import { unstable_cache } from "next/cache";
import { NextResponse } from "next/server";
import { getSql, hasDatabase } from "@/lib/db";
import { fetchRaceStakes, loadStakeHistory, morningIsLive } from "@/lib/live/stakes";
import { instantDepart } from "@/lib/paris-time";
import { buildStakeBoard } from "@/lib/stake-board";
import { schemaIdCourse } from "@/lib/validation";

/**
 * Tableau des mises d'une course. Le CDN garde la réponse une minute : quel que
 * soit le nombre d'onglets ouverts, le PMU n'est lu qu'une fois par minute et
 * par course, et jamais pour une course que personne ne regarde.
 *
 * La relecture à la minute ne touche que le PMU, pas Neon, dont le quota de
 * transfert a déjà suspendu le site en octobre 2026. L'heure de départ est
 * gardée une heure et l'historique quatre minutes, soit à peu près l'écart
 * entre deux relevés : le relire plus souvent ne ramènerait rien de neuf.
 */

export const dynamic = "force-dynamic";

const loadRaceTiming = unstable_cache(
  async (raceId: string) => {
    const [race] = (await getSql()`
      select race_date::text as race_date, start_time from races where id = ${raceId}
    `) as Array<{ race_date: string; start_time: string }>;
    return race ?? null;
  },
  ["stakes-race-timing"],
  { revalidate: 3600 },
);

/** `departedAt` : heure de départ passée ; `null` tant que les paris sont ouverts. */
const loadHistoryCached = unstable_cache(
  async (raceId: string, departedAt: string | null) => loadStakeHistory(raceId, departedAt ? new Date(departedAt) : new Date()),
  ["stakes-history"],
  { revalidate: 240 },
);

const NO_STORE = { "Cache-Control": "no-store" };
const LIVE_CACHE = { "Cache-Control": "public, max-age=0, s-maxage=55, stale-while-revalidate=5" };
const FINAL_CACHE = { "Cache-Control": "public, max-age=300, s-maxage=86400" };
/** Passé ce délai après le départ, les enjeux ne bougent plus. */
const SETTLED_AFTER_MIN = 30;

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  let id: string;
  try {
    id = decodeURIComponent((await params).id);
  } catch {
    return NextResponse.json({ error: "Identifiant de course invalide" }, { status: 400, headers: NO_STORE });
  }
  const parsed = schemaIdCourse.safeParse(id);
  if (!parsed.success) return NextResponse.json({ error: "Identifiant de course invalide" }, { status: 400, headers: NO_STORE });
  // Mode démonstration : pas de mises réelles à montrer, et ce n'est pas une panne.
  if (!hasDatabase()) return NextResponse.json({ board: null, updatedAt: null }, { headers: NO_STORE });

  const raceId = parsed.data;
  try {
    const race = await loadRaceTiming(raceId);
    if (!race) return NextResponse.json({ error: "Course introuvable" }, { status: 404, headers: NO_STORE });

    const depart = instantDepart(race.race_date, race.start_time);
    const now = new Date();
    const minutesToStart = depart ? (depart.getTime() - now.getTime()) / 60_000 : NaN;
    const settled = minutesToStart < -SETTLED_AFTER_MIN;
    const headers = settled ? FINAL_CACHE : LIVE_CACHE;

    const live = await fetchRaceStakes(raceId);
    if (!live) return NextResponse.json({ board: null, updatedAt: null }, { headers });

    // Après le départ, la fenêtre reste celle des dernières minutes de paris.
    const departed = depart && depart < now ? depart : null;
    const until = departed ?? now;
    const { baseline, morning } = await loadHistoryCached(raceId, departed?.toISOString() ?? null);
    const board = buildStakeBoard({
      live: live.reading,
      baseline: baseline && {
        reading: baseline.reading,
        minutes: Math.round((until.getTime() - new Date(baseline.observedAt).getTime()) / 60_000),
      },
      morning: morning ?? (morningIsLive(minutesToStart) ? live.morning : null),
    });
    return NextResponse.json({ board, updatedAt: live.updatedAt }, { headers });
  } catch (cause) {
    console.error("GET /api/races/%s/stakes", raceId, cause instanceof Error ? cause.message : cause);
    return NextResponse.json({ error: "Le PMU ne répond pas." }, { status: 502, headers: NO_STORE });
  }
}
