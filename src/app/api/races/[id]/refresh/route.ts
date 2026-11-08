import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { getSql, hasDatabase } from "@/lib/db";
import { refreshRace } from "@/lib/live/refresh-race";
import { instantDepart } from "@/lib/paris-time";
import { adresseAppelant, limiterDebit, reponseTropDeRequetes } from "@/lib/rate-limit";
import { schemaIdCourse } from "@/lib/validation";

/**
 * « Relancer l'analyse IA » — relit le PMU pour une course (cotes, parts des
 * mises, non-partants, pronostic gelé) puis fait recalculer la page.
 *
 * Ouvert à tout moment avant le départ. Le PMU n'est interrogé qu'à la cadence
 * partagée avec la boucle planifiée (15 min loin du départ, 10 min entre H-60
 * et H-15, 2 min dans le dernier quart d'heure), quel que soit le nombre de
 * visiteurs : le verrou vit en base
 * (`races.odds_refreshed_at`), pas dans l'instance.
 */

export const dynamic = "force-dynamic";

/** Au-delà, la course n'est pas du jour : rien à relire. */
const MAX_MINUTES_BEFORE = 18 * 60;

/**
 * Régénérations de page déclenchées par un clic alors que le PMU venait d'être
 * relu (par la boucle ou un autre visiteur) : au plus une toutes les 15 s par
 * course et par instance, pour que cent clics ne fassent pas cent rendus.
 */
const lastRevalidation = new Map<string, number>();
const REVALIDATE_GAP_MS = 15_000;
const NO_STORE = { "Cache-Control": "no-store" };

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const limite = limiterDebit(`race-refresh:${adresseAppelant(request)}`, 6, 60_000);
  if (!limite.autorise) return reponseTropDeRequetes(limite);

  let id: string;
  try {
    id = decodeURIComponent((await params).id);
  } catch {
    return NextResponse.json({ error: "Identifiant de course invalide" }, { status: 400, headers: NO_STORE });
  }
  const parsed = schemaIdCourse.safeParse(id);
  // Le corps `{ auto }` envoyé par la page n'est plus lu : clic ou relecture
  // automatique, la page n'est régénérée que sur des données neuves.
  if (!parsed.success) return NextResponse.json({ error: "Identifiant de course invalide" }, { status: 400, headers: NO_STORE });
  if (!hasDatabase()) return NextResponse.json({ error: "Données indisponibles" }, { status: 503, headers: NO_STORE });

  const raceId = parsed.data;
  const [race] = (await getSql()`
    select race_date::text as race_date, start_time from races where id = ${raceId}
  `) as Array<{ race_date: string; start_time: string }>;
  if (!race) return NextResponse.json({ error: "Course introuvable" }, { status: 404, headers: NO_STORE });

  const depart = instantDepart(race.race_date, race.start_time);
  const minutesToStart = depart ? (depart.getTime() - Date.now()) / 60_000 : NaN;
  if (!(minutesToStart >= -2)) {
    return NextResponse.json({ error: "La course est partie : l'analyse n'est plus relancée." }, { status: 409, headers: NO_STORE });
  }
  if (!(minutesToStart <= MAX_MINUTES_BEFORE)) {
    return NextResponse.json({ error: "Relance possible le jour de la course." }, { status: 409, headers: NO_STORE });
  }

  try {
    const outcome = await refreshRace(raceId, { minutesToStart });
    // Régénérer la page seulement quand le PMU vient d'être relu. Un clic sur
    // une course relue par quelqu'un d'autre régénérait aussi la page : depuis
    // que la page est vraiment en cache, ce chemin permettait à n'importe qui
    // de forcer des rendus complets, donc des lectures Neon. Le verrou en base
    // borne déjà les relectures à la cadence partagée.
    const now = Date.now();
    if (outcome.status === "refreshed" && now - (lastRevalidation.get(raceId) ?? 0) > REVALIDATE_GAP_MS) {
      lastRevalidation.set(raceId, now);
      if (lastRevalidation.size > 500) lastRevalidation.clear();
      revalidatePath(`/races/${raceId}`);
    }
    const [{ odds_refreshed_at }] = (await getSql()`
      select odds_refreshed_at from races where id = ${raceId}
    `) as Array<{ odds_refreshed_at: string | null }>;
    return NextResponse.json({ ...outcome, oddsRefreshedAt: odds_refreshed_at }, { headers: NO_STORE });
  } catch (cause) {
    console.error("POST /api/races/%s/refresh", raceId, cause instanceof Error ? cause.message : cause);
    return NextResponse.json({ error: "Le PMU ne répond pas, réessayez dans un instant." }, { status: 502, headers: NO_STORE });
  }
}
