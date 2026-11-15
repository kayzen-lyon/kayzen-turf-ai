import { unstable_cache } from "next/cache";
import { NextResponse } from "next/server";
import { getSql, hasDatabase } from "@/lib/db";
import { demoOperatorSnapshots, loadOperatorHistory, pmuSnapshot } from "@/lib/live/operator-odds";
import { fetchRaceStakes, loadStakeHistory, morningIsLive } from "@/lib/live/stakes";
import { buildOperatorTable, OPERATOR_LABELS, OPERATOR_ORDER, type OddsSnapshot, type OperatorKey, type OperatorTable } from "@/lib/operator-board";
import { instantDepart } from "@/lib/paris-time";
import { pmuPathFromRaceId } from "@/lib/pmu/client";
import { getRaceById } from "@/lib/race-repository";
import { adresseAppelant, limiterDebit, reponseTropDeRequetes } from "@/lib/rate-limit";
import { schemaIdCourse } from "@/lib/validation";

/**
 * Marché par opérateur d'une course : un tableau pour ZEturf, un pour Genybet,
 * un pour PMU+ (définitions : src/lib/operator-board.ts).
 *
 * Mêmes garde-fous que l'ancienne route des mises qu'elle remplace : le CDN
 * garde la réponse une minute, la lecture PMU est gardée 50 s par course côté
 * serveur quelle que soit l'URL, et la base n'est relue que toutes les quatre
 * minutes (le quota de transfert Neon a déjà suspendu le site). Les cotes
 * ZEturf et Genybet viennent de la base : elles ne déclenchent aucune requête
 * vers ces sites depuis une page visitée.
 */

export const dynamic = "force-dynamic";

export type OperatorPayload = {
  operators: Array<{ key: OperatorKey; label: string; table: OperatorTable }>;
  startAt: string | null;
  /** Dernière publication du PMU (ISO), `null` si le PMU n'a rien publié. */
  pmuUpdatedAt: string | null;
};

const loadRaceTiming = unstable_cache(
  async (raceId: string) => {
    const [race] = (await getSql()`
      select race_date::text as race_date, start_time from races where id = ${raceId}
    `) as Array<{ race_date: string; start_time: string }>;
    return race ?? null;
  },
  ["operators-race-timing"],
  { revalidate: 3600 },
);

/** `departedAt` : heure de départ passée ; `null` tant que les paris sont ouverts. */
const loadHistoryCached = unstable_cache(
  async (raceId: string, departedAt: string | null) => {
    const [operators, stakes] = await Promise.all([loadOperatorHistory(raceId), loadStakeHistory(raceId, departedAt ? new Date(departedAt) : new Date())]);
    return { ...operators, morning: stakes.morning };
  },
  ["operators-history"],
  { revalidate: 240 },
);

const loadStakesCached = unstable_cache(fetchRaceStakes, ["operators-pmu"], { revalidate: 50 });

const NO_STORE = { "Cache-Control": "no-store" };
const LIVE_CACHE = { "Cache-Control": "public, max-age=0, s-maxage=55, stale-while-revalidate=5" };
const FINAL_CACHE = { "Cache-Control": "public, max-age=300, s-maxage=86400" };
/** Passé ce délai après le départ, plus rien ne bouge. */
const SETTLED_AFTER_MIN = 30;

function payload(snapshots: Record<OperatorKey, OddsSnapshot[]>, startAt: Date | null, nonRunners: number[], pmuUpdatedAt: string | null): OperatorPayload {
  const iso = startAt?.toISOString() ?? null;
  return {
    operators: OPERATOR_ORDER.map((key) => ({
      key,
      label: OPERATOR_LABELS[key],
      table: buildOperatorTable({ snapshots: snapshots[key], startAt: iso, nonRunners }),
    })),
    startAt: iso,
    pmuUpdatedAt,
  };
}

/** Mode démonstration : cotes fictives dérivées de la course fictive, annoncées comme telles par le bandeau du site. */
async function demoPayload(id: string): Promise<OperatorPayload | null> {
  const race = await getRaceById(id);
  if (!race) return null;
  const startAt = instantDepart(race.raceDate, race.startTime) ?? new Date();
  const runners = race.horses.map((h) => ({ number: h.number, odds: Number.isFinite(h.odds) ? h.odds : null }));
  return payload(
    { zeturf: demoOperatorSnapshots(runners, startAt, 1), genybet: demoOperatorSnapshots(runners, startAt, 2), pmu: demoOperatorSnapshots(runners, startAt, 3) },
    startAt,
    [],
    null,
  );
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  // Seules les requêtes qui manquent le CDN arrivent ici : une par minute et par onglet suffit largement.
  const limite = limiterDebit(`operators:${adresseAppelant(request)}`, 20, 60_000);
  if (!limite.autorise) return reponseTropDeRequetes(limite);
  let id: string;
  try {
    id = decodeURIComponent((await params).id);
  } catch {
    return NextResponse.json({ error: "Identifiant de course invalide" }, { status: 400, headers: NO_STORE });
  }
  const parsed = schemaIdCourse.safeParse(id);
  if (!parsed.success) return NextResponse.json({ error: "Identifiant de course invalide" }, { status: 400, headers: NO_STORE });
  if (!hasDatabase()) {
    const demo = await demoPayload(parsed.data);
    return demo ? NextResponse.json(demo, { headers: NO_STORE }) : NextResponse.json({ error: "Course introuvable" }, { status: 404, headers: NO_STORE });
  }
  // Format réel (date, réunion, course) : un identifiant inventé n'atteint ni la base ni le cache.
  if (!pmuPathFromRaceId(parsed.data)) return NextResponse.json({ error: "Identifiant de course invalide" }, { status: 400, headers: NO_STORE });

  const raceId = parsed.data;
  try {
    const race = await loadRaceTiming(raceId);
    if (!race) return NextResponse.json({ error: "Course introuvable" }, { status: 404, headers: NO_STORE });

    const depart = instantDepart(race.race_date, race.start_time);
    const now = new Date();
    const minutesToStart = depart ? (depart.getTime() - now.getTime()) / 60_000 : NaN;
    const departed = depart && depart < now ? depart : null;

    // Une panne du PMU ne doit pas vider les tableaux ZEturf et Genybet.
    const [live, history] = await Promise.all([
      loadStakesCached(raceId).catch((cause) => {
        console.error("GET /api/races/%s/operators — PMU", raceId, cause instanceof Error ? cause.message : cause);
        return undefined;
      }),
      loadHistoryCached(raceId, departed?.toISOString() ?? null),
    ]);
    const morning = history.morning ?? (live && morningIsLive(minutesToStart) ? live.morning : null);
    const body = payload(
      { zeturf: history.snapshots.zeturf, genybet: history.snapshots.genybet, pmu: pmuSnapshot(live ?? null, morning, now, depart) },
      depart,
      history.nonRunners,
      live?.updatedAt ?? null,
    );
    const settled = minutesToStart < -SETTLED_AFTER_MIN && live !== undefined && !live?.partial;
    return NextResponse.json(body, { headers: settled ? FINAL_CACHE : LIVE_CACHE });
  } catch (cause) {
    console.error("GET /api/races/%s/operators", raceId, cause instanceof Error ? cause.message : cause);
    return NextResponse.json({ error: "Les cotes ne sont pas disponibles pour le moment." }, { status: 502, headers: NO_STORE });
  }
}
