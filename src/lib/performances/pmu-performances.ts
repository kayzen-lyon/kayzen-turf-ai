import { fetchPmuJson, pmuRaceUrl } from "@/lib/pmu/client";

/**
 * DERNIÈRES COURSES DÉTAILLÉES — lues sur l'API PMU (`performances-detaillees`).
 *
 * Pour chaque partant, le PMU publie ses cinq dernières courses : date,
 * hippodrome, distance, terrain, place, poids porté et réduction kilométrique
 * (temps ramené au kilomètre). C'est la matière de la page « Chronos, poids et
 * forme » (src/lib/performances/form-board.ts).
 *
 * Ces courses sont toutes antérieures à la course du jour : rien ici ne lit le
 * résultat de la course affichée.
 */

export type RunDiscipline = "attele" | "monte" | "plat" | "haies" | "steeple" | "cross" | "autre";

export type DetailedRun = {
  /** Date de la course, `AAAA-MM-JJ` (heure locale de l'hippodrome). */
  date: string;
  racecourse: string;
  raceName: string | null;
  discipline: RunDiscipline;
  /** Distance en mètres : celle parcourue par le cheval si le PMU la publie (trot, avec rendement), sinon celle de la course. */
  distance: number | null;
  /** État du terrain publié (plat et obstacle), `null` sinon. */
  going: string | null;
  fieldSize: number | null;
  /** Place à l'arrivée ; `null` = non classé. */
  position: number | null;
  /** Motif publié quand le cheval n'est pas classé (« AI » disqualifié, « T » tombé, « A » arrêté…). */
  status: string | null;
  /** Poids porté en kilos (plat et obstacle), `null` au trot. */
  weightKg: number | null;
  /** Réduction kilométrique en millièmes de seconde (75 580 = 1'15"6 au kilomètre), `null` si non chronométré. */
  kmTimeMs: number | null;
};

const DISCIPLINES: Record<string, RunDiscipline> = {
  ATTELE: "attele",
  MONTE: "monte",
  PLAT: "plat",
  HAIE: "haies",
  STEEPLECHASE: "steeple",
  CROSS: "cross",
};

/** Bornes plausibles d'une réduction kilométrique (galop ≈ 55 s, trot ≈ 75 s, obstacle ≈ 80 s). */
const KM_MIN_MS = 40_000;
const KM_MAX_MS = 200_000;

type RawRunner = {
  itsHim?: boolean;
  place?: { place?: number | null; rawValue?: string | null; statusArrivee?: string | null } | null;
  poidsJockey?: number | null;
  reductionKilometrique?: number | null;
  distanceParcourue?: number | null;
};

type RawRun = {
  date?: number;
  timezoneOffset?: number;
  hippodrome?: string;
  nomPrix?: string;
  discipline?: string;
  distance?: number;
  nbParticipants?: number;
  tempsDuPremier?: number;
  etatTerrain?: string;
  participants?: RawRunner[];
};

function positive(value: unknown): number | null {
  const n = Number(value);
  return value != null && Number.isFinite(n) && n > 0 ? n : null;
}

function kmTime(runner: RawRunner, raw: RawRun, distance: number | null): number | null {
  const published = positive(runner.reductionKilometrique);
  if (published !== null) return published > KM_MIN_MS && published < KM_MAX_MS ? published : null;
  // Vainqueur sans réduction publiée (courses étrangères) : temps du premier ÷ distance.
  const winnerTime = positive(raw.tempsDuPremier);
  if (runner.place?.place !== 1 || winnerTime === null || distance === null) return null;
  const derived = Math.round((winnerTime / distance) * 1000);
  return derived > KM_MIN_MS && derived < KM_MAX_MS ? derived : null;
}

function parseRun(raw: RawRun): DetailedRun | null {
  const runner = Array.isArray(raw.participants) ? raw.participants.find((p) => p?.itsHim) : undefined;
  const epoch = Number(raw.date);
  if (!runner || !Number.isFinite(epoch)) return null;
  const distance = positive(runner.distanceParcourue) ?? positive(raw.distance);
  const position = positive(runner.place?.place);
  return {
    date: new Date(epoch + (Number(raw.timezoneOffset) || 0)).toISOString().slice(0, 10),
    racecourse: String(raw.hippodrome ?? "").trim(),
    raceName: raw.nomPrix ? String(raw.nomPrix).trim() : null,
    discipline: DISCIPLINES[String(raw.discipline ?? "").toUpperCase()] ?? "autre",
    distance,
    going: raw.etatTerrain ? String(raw.etatTerrain).trim() : null,
    fieldSize: positive(raw.nbParticipants),
    position,
    status: position === null && runner.place?.rawValue ? String(runner.place.rawValue) : null,
    weightKg: positive(runner.poidsJockey),
    kmTimeMs: kmTime(runner, raw, distance),
  };
}

/**
 * Réponse `performances-detaillees` → courses passées par numéro de partant,
 * de la plus récente à la plus ancienne. Fonction pure ; une réponse illisible
 * donne une table vide.
 */
export function parsePerformances(payload: unknown): Map<number, DetailedRun[]> {
  const out = new Map<number, DetailedRun[]>();
  const participants = (payload as { participants?: unknown } | null)?.participants;
  if (!Array.isArray(participants)) return out;
  for (const participant of participants as Array<{ numPmu?: number; coursesCourues?: RawRun[] }>) {
    const number = Number(participant?.numPmu);
    if (!Number.isInteger(number)) continue;
    const runs = (Array.isArray(participant.coursesCourues) ? participant.coursesCourues : [])
      .map(parseRun)
      .filter((run): run is DetailedRun => run !== null)
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    out.set(number, runs);
  }
  return out;
}

/**
 * Dernières courses des partants d'une course. `null` si l'identifiant n'est
 * pas une course PMU (mode démonstration). Lève si le PMU ne répond pas : une
 * panne ne doit pas passer pour « aucun chrono ».
 */
export async function fetchRacePerformances(raceId: string): Promise<Map<number, DetailedRun[]> | null> {
  const url = pmuRaceUrl(raceId, "/performances-detaillees/pretty");
  if (!url) return null;
  return parsePerformances(await fetchPmuJson(url));
}
