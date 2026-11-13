import type { DetailedRun, RunDiscipline } from "@/lib/performances/pmu-performances";

/**
 * CHRONOS, POIDS ET FORME — ce que disent les dernières courses de chaque
 * partant, indépendamment des cotes et de la presse.
 *
 * Source : les cinq dernières courses publiées par le PMU pour chaque partant
 * (src/lib/performances/pmu-performances.ts). Trois lectures :
 *
 *   Chrono   meilleure réduction kilométrique (temps ramené au kilomètre) dans
 *            la même spécialité, sur une distance proche de celle du jour
 *            (`DISTANCE_TOLERANCE`). Les partants sont classés du plus rapide
 *            au moins rapide. Un chrono dépend du terrain et du train de la
 *            course : la date, l'hippodrome et le terrain sont affichés à côté.
 *   Poids    poids du jour comparé à la moyenne des trois dernières courses
 *            (plat et obstacle ; au trot il n'y a pas de poids porté).
 *   Forme    note sur 100, somme de quatre critères publiés (`FORM_WEIGHTS`) :
 *            résultats récents, progression, régularité, fraîcheur.
 *
 * Ce sont des règles explicites, pas un modèle entraîné : la note de forme
 * n'est pas une probabilité de victoire et n'a pas été mesurée au backtest.
 * La page le dit.
 */

export type RaceDiscipline = "Plat" | "Trot" | "Obstacle";

/** Écart de distance accepté, en mètres, pour parler de « même distance ». */
export const DISTANCE_TOLERANCE: Record<RaceDiscipline, number> = { Plat: 100, Trot: 200, Obstacle: 300 };

/** Poids de chaque critère dans la note de forme (total 100). */
export const FORM_WEIGHTS = { results: 40, progress: 20, regularity: 20, freshness: 20 } as const;

export const FORM_THRESHOLDS = {
  /**
   * Note minimale d'une bonne forme. À 60, dix partants sur quatorze d'une
   * course de haies d'Auteuil (14/11/2026) sortaient en bonne forme : le seuil
   * ne départageait rien.
   */
  good: 70,
  /** Note minimale d'une forme moyenne ; en dessous, mauvaise forme. */
  average: 45,
  /** Au-delà de ce nombre de jours sans courir, la forme est au mieux « moyenne » : la préparation reste à vérifier. */
  layoffDays: 120,
  /** Écart de poids, en kilos, à partir duquel un cheval est dit allégé ou chargé. */
  weightDeltaKg: 1,
} as const;

export type RaceInfo = { discipline: RaceDiscipline; specialty?: string | null; distance: number | null };

export type BestChrono = {
  kmTimeMs: number;
  /** Temps total de cette course : réduction × distance parcourue. */
  totalMs: number;
  distance: number;
  date: string;
  racecourse: string;
  going: string | null;
  position: number | null;
};

export type WeightTrend = "allege" | "stable" | "charge";

export type WeightReading = {
  todayKg: number | null;
  /** Poids des trois dernières courses où il est publié, de la plus récente à la plus ancienne. */
  recent: number[];
  referenceKg: number | null;
  /** Poids du jour − moyenne des dernières courses ; négatif = allégé. */
  deltaKg: number | null;
  trend: WeightTrend | null;
};

export type FormLevel = "bonne" | "moyenne" | "mauvaise" | "inconnue";

export type FormRating = {
  level: FormLevel;
  /** Note sur 100, `null` sans course connue. */
  score: number | null;
  parts: { results: number; progress: number; regularity: number; freshness: number } | null;
  daysSinceLast: number | null;
  /** Nombre de courses lues. */
  runs: number;
  reasons: string[];
};

export type BoardRunner = {
  number: number;
  name: string;
  jockey: string;
  trainer: string;
  odds: number | null;
  weightKg: number | null;
  nonRunner: boolean;
};

export type BoardRow = BoardRunner & {
  chrono: BestChrono | null;
  /** Rang par le chrono (1 = le plus rapide), `null` sans chrono. */
  chronoRank: number | null;
  /** Rang par la cote (1 = favori), `null` sans cote. */
  marketRank: number | null;
  weight: WeightReading;
  form: FormRating;
  runs: DetailedRun[];
};

export type FormBoard = {
  rows: BoardRow[];
  /** Partants ayant un chrono sur la distance. */
  timed: number;
  fastest: BoardRow | null;
  bestForm: BoardRow | null;
  /** Le plus allégé par rapport à ses dernières courses. */
  lightest: BoardRow | null;
  /** Dans les trois meilleurs chronos, en bonne forme, hors des trois premiers du marché. */
  overlooked: BoardRow[];
  toleranceMeters: number;
};

/** « 1'15"6 » : réduction kilométrique au dixième. */
export function formatKmTime(ms: number | null | undefined): string {
  return formatRaceTime(ms);
}

/** Durée en minutes, secondes et dixièmes : 264 530 → « 4'24"5 », 58 000 → « 58"0 ». */
export function formatRaceTime(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return "—";
  const tenths = Math.round(ms / 100);
  const minutes = Math.floor(tenths / 600);
  const seconds = Math.floor((tenths % 600) / 10);
  const rest = `${minutes > 0 ? String(seconds).padStart(2, "0") : seconds}"${tenths % 10}`;
  return minutes > 0 ? `${minutes}'${rest}` : rest;
}

function plain(value: string | null | undefined): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/** Spécialités des courses passées comparables à la course du jour. */
export function comparableDisciplines(race: RaceInfo): RunDiscipline[] {
  const specialty = plain(race.specialty);
  if (race.discipline === "Plat") return ["plat"];
  if (race.discipline === "Trot") {
    if (specialty.includes("mont")) return ["monte"];
    if (specialty.includes("attel")) return ["attele"];
    return ["attele", "monte"];
  }
  if (specialty.includes("haie")) return ["haies"];
  if (specialty.includes("steeple")) return ["steeple"];
  if (specialty.includes("cross")) return ["cross"];
  return ["haies", "steeple", "cross"];
}

/** Meilleur chrono du cheval dans la spécialité, sur une distance proche de celle du jour. */
export function bestChrono(runs: readonly DetailedRun[], race: RaceInfo): BestChrono | null {
  if (!race.distance) return null;
  const disciplines = comparableDisciplines(race);
  const tolerance = DISTANCE_TOLERANCE[race.discipline];
  let best: DetailedRun | null = null;
  for (const run of runs) {
    if (run.kmTimeMs === null || run.distance === null) continue;
    if (!disciplines.includes(run.discipline) || Math.abs(run.distance - race.distance) > tolerance) continue;
    if (!best || run.kmTimeMs < best.kmTimeMs!) best = run;
  }
  if (!best) return null;
  return {
    kmTimeMs: best.kmTimeMs!,
    totalMs: Math.round((best.kmTimeMs! * best.distance!) / 1000),
    distance: best.distance!,
    date: best.date,
    racecourse: best.racecourse,
    going: best.going,
    position: best.position,
  };
}

/** Poids du jour comparé à la moyenne des trois dernières courses où il est publié. */
export function weightReading(todayKg: number | null, runs: readonly DetailedRun[]): WeightReading {
  const recent = runs.map((run) => run.weightKg).filter((kg): kg is number => kg !== null).slice(0, 3);
  if (todayKg === null || recent.length === 0) return { todayKg, recent, referenceKg: null, deltaKg: null, trend: null };
  const referenceKg = Math.round((recent.reduce((sum, kg) => sum + kg, 0) / recent.length) * 10) / 10;
  const deltaKg = Math.round((todayKg - referenceKg) * 10) / 10;
  const limit = FORM_THRESHOLDS.weightDeltaKg;
  const trend: WeightTrend = deltaKg <= -limit ? "allege" : deltaKg >= limit ? "charge" : "stable";
  return { todayKg, recent, referenceKg, deltaKg, trend };
}

const DAY_MS = 86_400_000;

function dayNumber(date: string): number {
  return Math.floor(Date.parse(`${date.slice(0, 10)}T00:00:00Z`) / DAY_MS);
}

/** Qualité d'une arrivée, 0 à 1 : 1 = vainqueur, 0 = dernier ou non classé. */
function finishQuality(run: DetailedRun): number {
  if (run.position === null) return 0;
  if (run.fieldSize === null || run.fieldSize < 2) return run.position === 1 ? 1 : 0.5;
  return Math.max(0, 1 - (run.position - 1) / (run.fieldSize - 1));
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Points de fraîcheur (sur 20) selon le nombre de jours depuis la dernière course. */
function freshnessPoints(days: number): number {
  if (days < 4) return 6;
  if (days <= 7) return 12;
  if (days <= 35) return 20;
  if (days <= 60) return 15;
  if (days <= FORM_THRESHOLDS.layoffDays) return 8;
  return 3;
}

function formReasons(past: DetailedRun[], days: number, progress: number): string[] {
  const reasons: string[] = [];
  const lastThree = past.slice(0, 3);
  const podiums = lastThree.filter((run) => run.position !== null && run.position <= 3).length;
  if (podiums > 0) reasons.push(`${podiums} podium${podiums > 1 ? "s" : ""} sur ses ${lastThree.length > 1 ? `${lastThree.length} dernières courses` : "dernière course"}`);
  if (past[0].position === null) reasons.push(`non classé à sa dernière course${past[0].status ? ` (${past[0].status})` : ""}`);
  if (past.length >= 3 && progress >= 13) reasons.push("en progrès");
  if (past.length >= 3 && progress <= 7) reasons.push("en baisse");
  if (days > FORM_THRESHOLDS.layoffDays) reasons.push(`rentrée après ${days} jours`);
  else if (days <= 7) reasons.push(`récupération courte (${days} j)`);
  if (past.length === 1) reasons.push("une seule course connue");
  return reasons;
}

/**
 * Note de forme à partir des courses strictement antérieures à `today`
 * (`AAAA-MM-JJ`). Quatre critères, voir `FORM_WEIGHTS` :
 *   résultats    qualité des 3 dernières arrivées, la plus récente comptant triple ;
 *   progression  2 dernières arrivées comparées aux précédentes ;
 *   régularité   part des courses finies dans la première moitié du peloton ;
 *   fraîcheur    jours depuis la dernière course (idéal : 8 à 35).
 */
export function formRating(runs: readonly DetailedRun[], today: string): FormRating {
  const todayDay = dayNumber(today);
  const past = runs
    .filter((run) => dayNumber(run.date) < todayDay)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    .slice(0, 5);
  if (past.length === 0) return { level: "inconnue", score: null, parts: null, daysSinceLast: null, runs: 0, reasons: [] };

  const qualities = past.map(finishQuality);
  const weights = [3, 2, 1].slice(0, Math.min(3, qualities.length));
  const results = (weights.reduce((sum, w, i) => sum + w * qualities[i], 0) / weights.reduce((a, b) => a + b, 0)) * FORM_WEIGHTS.results;

  const half = FORM_WEIGHTS.progress / 2;
  const progress =
    qualities.length >= 3 ? Math.max(0, Math.min(FORM_WEIGHTS.progress, half + (mean(qualities.slice(0, 2)) - mean(qualities.slice(2))) * half)) : half;

  const regularity = (qualities.filter((q) => q >= 0.5).length / qualities.length) * FORM_WEIGHTS.regularity;
  const daysSinceLast = todayDay - dayNumber(past[0].date);
  const freshness = freshnessPoints(daysSinceLast);

  const score = Math.round(results + progress + regularity + freshness);
  let level: FormLevel = score >= FORM_THRESHOLDS.good ? "bonne" : score >= FORM_THRESHOLDS.average ? "moyenne" : "mauvaise";
  if (level === "bonne" && daysSinceLast > FORM_THRESHOLDS.layoffDays) level = "moyenne";

  return {
    level,
    score,
    parts: { results: Math.round(results), progress: Math.round(progress), regularity: Math.round(regularity), freshness },
    daysSinceLast,
    runs: past.length,
    reasons: formReasons(past, daysSinceLast, progress),
  };
}

function marketRanks(runners: readonly BoardRunner[]): Map<number, number> {
  const priced = runners
    .filter((r) => !r.nonRunner && r.odds !== null && Number.isFinite(r.odds) && r.odds > 1)
    .sort((a, b) => (a.odds as number) - (b.odds as number) || a.number - b.number);
  return new Map(priced.map((r, i) => [r.number, i + 1]));
}

/**
 * Tableau de la course : partants classés du meilleur chrono au moins bon,
 * ceux sans chrono ensuite (par note de forme). Les non-partants sont retirés.
 */
export function buildFormBoard(
  race: RaceInfo & { date: string },
  runners: readonly BoardRunner[],
  performances: ReadonlyMap<number, DetailedRun[]>,
): FormBoard {
  const ranks = marketRanks(runners);
  const unranked = runners
    .filter((runner) => !runner.nonRunner)
    .map((runner) => {
      const runs = (performances.get(runner.number) ?? []).filter((run) => run.date < race.date);
      return {
        ...runner,
        runs,
        chrono: bestChrono(runs, race),
        marketRank: ranks.get(runner.number) ?? null,
        weight: weightReading(runner.weightKg, runs),
        form: formRating(runs, race.date),
      };
    })
    .sort(
      (a, b) =>
        (a.chrono?.kmTimeMs ?? Infinity) - (b.chrono?.kmTimeMs ?? Infinity) || (b.form.score ?? -1) - (a.form.score ?? -1) || a.number - b.number,
    );

  let rank = 0;
  const rows: BoardRow[] = unranked.map((row) => ({ ...row, chronoRank: row.chrono ? ++rank : null }));

  const scored = rows.filter((row) => row.form.score !== null);
  const bestForm = scored.length ? scored.reduce((best, row) => (row.form.score! > best.form.score! ? row : best)) : null;
  const lighter = rows.filter((row) => row.weight.trend === "allege");
  const lightest = lighter.length ? lighter.reduce((best, row) => (row.weight.deltaKg! < best.weight.deltaKg! ? row : best)) : null;

  return {
    rows,
    timed: rank,
    fastest: rows.find((row) => row.chronoRank === 1) ?? null,
    bestForm,
    lightest,
    overlooked: rows.filter((row) => row.chronoRank !== null && row.chronoRank <= 3 && row.form.level === "bonne" && (row.marketRank === null || row.marketRank > 3)),
    toleranceMeters: DISTANCE_TOLERANCE[race.discipline],
  };
}
