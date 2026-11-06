/**
 * HISTORIQUE D'UN CHEVAL TIRÉ DE LA BASE — au-delà de la musique.
 *
 * La musique ne dit ni la date, ni la distance, ni le terrain, ni l'hippodrome,
 * ni le niveau de la course. La base, elle, garde chaque sortie du cheval
 * (entries ⋈ races ⋈ results). Ce module résume ces sorties en quelques
 * nombres, à partir d'une liste de courses PASSÉES :
 *
 *   - `computeHorseHistory` est pur : il sert à l'entraînement
 *     (scripts/lib/dataset.ts, qui reconstitue l'historique date par date) ET en
 *     production, à partir des lignes renvoyées par `fetchHorseHistories`. Une
 *     variable ne peut donc pas être calculée différemment entre les deux.
 *   - Garde-fou anti-fuite : toute course dont la date n'est pas STRICTEMENT
 *     antérieure au jour de la course étudiée est ignorée, même si l'appelant
 *     l'a transmise par erreur (une course plus tôt le même jour est exclue
 *     aussi : l'entraînement ne la connaît pas non plus).
 */

/** Nombre maximal de sorties lues par cheval (le même à l'entraînement et en production). */
export const HISTORY_MAX_RUNS = 30;

/** Une sortie passée du cheval. */
export type PastRun = {
  /** Date de la course, `YYYY-MM-DD`. */
  date: string;
  /** Place à l'arrivée ; `null` = non classé (disqualifié, arrêté, tombé…). */
  position: number | null;
  /** Nombre de partants de cette course. */
  fieldSize: number | null;
  /** Distance en mètres. */
  distance: number | null;
  going?: string | null;
  racecourse?: string | null;
  /** Allocation de la course (€). */
  prize?: number | null;
  /** Identifiant du jockey/driver de cette sortie. */
  jockeyId?: string | null;
  /** Code de déferrage de cette sortie (trot). */
  shoeing?: string | null;
  /** Réduction kilométrique RÉALISÉE dans cette sortie (millièmes de seconde). Passée : connue avant la course du jour. */
  reductionKm?: number | string | null;
};

/** Ce que l'on sait de la course du jour, pour situer l'historique. */
export type HistoryToday = {
  date: string;
  distance?: number | null;
  going?: string | null;
  racecourse?: string | null;
  prize?: number | null;
  jockeyId?: string | null;
};

/** Résumé de l'historique, prêt à transformer en variables du modèle. */
export type HorseHistory = {
  /** Sorties antérieures retenues (0 = aucune trace en base). */
  runs: number;
  /** Jours depuis la dernière sortie, `null` si aucune. */
  daysSinceLast: number | null;
  /** Sorties dans les 90 jours précédents. */
  runs90d: number;
  /** Meilleure place relative au peloton sur les 6 dernières (0 = gagnant, 1 = dernier), `null` si aucune. */
  bestRelFinish: number | null;
  /** Place relative moyenne sur les 6 dernières, `null` si aucune. */
  avgRelFinish: number | null;
  /** Sorties à ±200 m de la distance du jour, et podiums parmi elles. */
  distanceRuns: number;
  distanceTop3: number;
  /** Sorties sur le même terrain (état de piste), et podiums. */
  goingRuns: number;
  goingTop3: number;
  /** Sorties sur le même hippodrome, et podiums. */
  courseRuns: number;
  courseTop3: number;
  /** log(allocation du jour ÷ allocation médiane des 3 dernières sorties), `null` si inconnu. */
  classChange: number | null;
  /** Sorties avec le jockey/driver du jour, et podiums. */
  comboRuns: number;
  comboTop3: number;
  /** Déferrage lors de la dernière sortie (pour repérer un « 1er déferré »). */
  lastShoeing: string | null;
  /** Meilleure réduction km (secondes) sur les 6 dernières sorties, `null` si aucune. */
  bestKm: number | null;
  /** Réduction km (secondes) de la sortie chronométrée la plus récente, `null` si aucune. */
  lastKm: number | null;
};

export const EMPTY_HISTORY: HorseHistory = {
  runs: 0,
  daysSinceLast: null,
  runs90d: 0,
  bestRelFinish: null,
  avgRelFinish: null,
  distanceRuns: 0,
  distanceTop3: 0,
  goingRuns: 0,
  goingTop3: 0,
  courseRuns: 0,
  courseTop3: 0,
  classChange: null,
  comboRuns: 0,
  comboTop3: 0,
  lastShoeing: null,
  bestKm: null,
  lastKm: null,
};

const DAY_MS = 86_400_000;

function dayNumber(date: string): number {
  return Math.floor(Date.parse(`${date.slice(0, 10)}T00:00:00Z`) / DAY_MS);
}

/** « 2 700 m », « 2700 », 2700 → 2700 ; tout le reste → `null`. */
export function parseDistance(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : null;
  const digits = String(value ?? "").replace(/[^\d]/g, "");
  const n = Number(digits);
  return digits && Number.isFinite(n) && n >= 600 && n <= 9000 ? n : null;
}

/** État de piste comparable d'une course à l'autre (casse, accents, espaces). */
export function normalizeGoing(value: unknown): string | null {
  const s = String(value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase();
  return s ? s : null;
}

function relFinish(run: PastRun): number {
  const size = Number(run.fieldSize);
  const pos = Number(run.position);
  if (!run.position || !Number.isFinite(pos) || pos < 1) return 1;
  if (!Number.isFinite(size) || size < 2) return pos === 1 ? 0 : 1;
  return Math.min(1, (pos - 1) / (size - 1));
}

/** Réduction km d'une sortie en secondes ; hors plage plausible (0 compris) → `null`. */
function kmSeconds(run: PastRun): number | null {
  const v = Number(run.reductionKm);
  return Number.isFinite(v) && v > 40_000 && v < 200_000 ? v / 1000 : null;
}

function isTop3(run: PastRun) {
  return run.position != null && run.position >= 1 && run.position <= 3;
}

function median(values: number[]) {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Résume les sorties passées d'un cheval, vues depuis la course du jour.
 * L'ordre de `runs` est indifférent ; seules les `HISTORY_MAX_RUNS` plus
 * récentes, strictement antérieures à `today.date`, sont lues.
 */
export function computeHorseHistory(runs: readonly PastRun[], today: HistoryToday): HorseHistory {
  const todayDay = dayNumber(today.date);
  const past = runs
    .filter((r) => r.date && dayNumber(r.date) < todayDay)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    .slice(0, HISTORY_MAX_RUNS);
  if (past.length === 0) return { ...EMPTY_HISTORY };

  const recent = past.slice(0, 6).map(relFinish);
  const todayDistance = parseDistance(today.distance);
  const todayGoing = normalizeGoing(today.going);
  const todayCourse = today.racecourse ? String(today.racecourse) : null;
  const todayJockey = today.jockeyId ? String(today.jockeyId) : null;

  const count = (pred: (r: PastRun) => boolean) => {
    const subset = past.filter(pred);
    return { runs: subset.length, top3: subset.filter(isTop3).length };
  };
  const distance = todayDistance
    ? count((r) => {
        const d = parseDistance(r.distance);
        return d !== null && Math.abs(d - todayDistance) <= 200;
      })
    : { runs: 0, top3: 0 };
  const going = todayGoing ? count((r) => normalizeGoing(r.going) === todayGoing) : { runs: 0, top3: 0 };
  const course = todayCourse ? count((r) => r.racecourse != null && String(r.racecourse) === todayCourse) : { runs: 0, top3: 0 };
  const combo = todayJockey ? count((r) => r.jockeyId != null && String(r.jockeyId) === todayJockey) : { runs: 0, top3: 0 };

  const prizes = past
    .slice(0, 3)
    .map((r) => Number(r.prize))
    .filter((p) => Number.isFinite(p) && p > 0);
  const todayPrize = Number(today.prize);
  const classChange =
    prizes.length && Number.isFinite(todayPrize) && todayPrize > 0
      ? Math.max(-2, Math.min(2, Math.log(todayPrize / median(prizes))))
      : null;

  const timed = past.slice(0, 6).map(kmSeconds).filter((k): k is number => k !== null);

  return {
    runs: past.length,
    daysSinceLast: todayDay - dayNumber(past[0].date),
    runs90d: past.filter((r) => todayDay - dayNumber(r.date) <= 90).length,
    bestRelFinish: Math.min(...recent),
    avgRelFinish: recent.reduce((a, b) => a + b, 0) / recent.length,
    distanceRuns: distance.runs,
    distanceTop3: distance.top3,
    goingRuns: going.runs,
    goingTop3: going.top3,
    courseRuns: course.runs,
    courseTop3: course.top3,
    classChange,
    comboRuns: combo.runs,
    comboTop3: combo.top3,
    lastShoeing: past[0].shoeing ?? null,
    bestKm: timed.length ? Math.min(...timed) : null,
    lastKm: timed.length ? timed[0] : null,
  };
}

/** Ligne SQL renvoyée par `fetchHorseHistories`. */
export type PastRunRow = {
  horse_id: string;
  race_date: string;
  position: number | null;
  field_size: number | null;
  distance: string | null;
  going: string | null;
  racecourse: string | null;
  prize: number | string | null;
  jockey_id: string | null;
  shoeing: string | null;
  reduction_km?: string | null;
};

export function pastRunFromRow(row: PastRunRow): PastRun {
  const prize = Number(row.prize);
  return {
    date: String(row.race_date).slice(0, 10),
    position: row.position == null ? null : Number(row.position),
    fieldSize: row.field_size == null ? null : Number(row.field_size),
    distance: parseDistance(row.distance),
    going: row.going,
    racecourse: row.racecourse,
    prize: Number.isFinite(prize) && prize > 0 ? prize : null,
    jockeyId: row.jockey_id,
    shoeing: row.shoeing,
    reductionKm: row.reduction_km ?? null,
  };
}

/** Balise SQL compatible avec `neon(url)` de @neondatabase/serverless. */
export type SqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => PromiseLike<unknown>;

/**
 * Sorties passées des chevaux `horseIds`, strictement AVANT `beforeDate`
 * (`YYYY-MM-DD`, la date de la course du jour), limitées aux courses dont
 * l'arrivée est connue. Renvoie une liste par cheval, à passer à
 * `computeHorseHistory`.
 *
 * À appeler depuis src/lib/race-repository.ts (une requête par course) :
 *
 *   const runs = await fetchHorseHistories(sql, entries.map((e) => e.horse_id), row.race_date);
 *   horse.history = computeHorseHistory(runs.get(horseId) ?? [], {
 *     date: row.race_date, distance: row.distance, going: row.going,
 *     racecourse: row.racecourse_id, prize: row.prize, jockeyId: entry.jockey_id,
 *   });
 *
 * Les colonnes encore absentes d'anciennes bases (races.prize) sont lues via
 * `to_jsonb(r)` : elles valent `null` au lieu de faire échouer la requête.
 * `racecourse` est l'identifiant `races.racecourse_id` : passer le même
 * identifiant dans `HistoryToday.racecourse`.
 */
export async function fetchHorseHistories(
  sql: SqlTag,
  horseIds: readonly string[],
  beforeDate: string,
  maxRuns = HISTORY_MAX_RUNS,
): Promise<Map<string, PastRun[]>> {
  const ids = [...new Set(horseIds.filter(Boolean))];
  const out = new Map<string, PastRun[]>();
  if (ids.length === 0) return out;
  const rows = (await sql`
    select horse_id, race_date, position,
           -- Taille du peloton calculée après le filtre rn : seulement pour les sorties gardées.
           (select count(*) from entries c where c.race_id = t.race_id)::int as field_size,
           distance, going, racecourse, prize, jockey_id, shoeing, reduction_km
      from (
        select e.horse_id,
               r.race_date::text as race_date,
               res.finish_position as position,
               e.race_id,
               r.distance,
               r.going,
               r.racecourse_id::text as racecourse,
               (to_jsonb(r)->>'prize') as prize,
               e.jockey_id::text as jockey_id,
               coalesce(e.shoeing, case when e.equipment like 'DEFERRE%' or e.equipment like 'PROTEGE%' then e.equipment end) as shoeing,
               coalesce(to_jsonb(e)->>'realized_km', e.reduction_km) as reduction_km,
               row_number() over (partition by e.horse_id order by r.race_date desc, r.id desc) as rn
          from entries e
          join races r on r.id = e.race_id
          left join results res on res.race_id = e.race_id and res.horse_id = e.horse_id
         where e.horse_id = any(${ids})
           and r.race_date < ${beforeDate}::date
           and exists (select 1 from results w where w.race_id = e.race_id and w.finish_position = 1)
      ) t
     where rn <= ${maxRuns}
     order by horse_id, race_date desc
  `) as PastRunRow[];
  for (const row of rows) {
    const list = out.get(row.horse_id) ?? [];
    list.push(pastRunFromRow(row));
    out.set(row.horse_id, list);
  }
  return out;
}
