import { unstable_cache } from "next/cache";
import { getSql, hasDatabase } from "@/lib/db";
import { probableArrival, raceToContext } from "@/lib/bet-recommendations";
import { raceCards, valueBets } from "@/lib/mock-data";
import { computeHorseHistory, fetchHorseHistories, type HorseHistory, type SqlTag } from "@/lib/fundamental/history";
import { fundamentalFeatureNames, fundamentalProbabilities } from "@/lib/fundamental/model";
import type { MarketHistory } from "@/lib/market";
import { calibrateField } from "@/lib/probability";
import { minutesToStart } from "@/lib/race-status";
import { VALUE_EDGE_THRESHOLD } from "@/lib/value-signal";
import { parseOddsSource } from "@/lib/odds-freshness";
import { connectionStatsAt, raceHasStarted } from "@/lib/point-in-time";
import type { BetOffer, Confidence, HorsePrediction, RaceAnalysis } from "@/lib/types";

// Les jeux de démonstration passent par la même calibration que la base : sans
// ça, un environnement sans DB afficherait des probabilités d'une autre source.
const demoRaces: RaceAnalysis[] = raceCards.map((race) => ({ ...race, horses: calibrateField(race.horses) }));

/**
 * Vrai quand aucune base n'est configurée : le site tourne alors sur des
 * courses fictives.
 *
 * Ce drapeau existe parce que la substitution était jusqu'ici invisible. Toute
 * panne base renvoyait `demoRaces`, et le site affichait des chevaux, des
 * cotes et des pronostics inventés avec la même présentation que les vraies
 * courses PMU. Sur un service d'aide à la décision de pari, présenter des
 * données fabriquées comme authentiques relève de la pratique commerciale
 * trompeuse (code de la consommation, art. L. 121-2).
 *
 * Deux règles en découlent :
 *  - une panne base ne fabrique plus rien, elle remonte l'erreur ;
 *  - l'absence volontaire de base reste possible pour la démonstration, mais
 *    l'interface l'annonce (voir `BandeauDemonstration`).
 */
export function estModeDemonstration() {
  return !hasDatabase();
}

/** Panne de la source de données. Distincte d'un « aucun résultat ». */
export class ErreurSourceDonnees extends Error {
  constructor(operation: string, cause: unknown) {
    super(`Source de données indisponible (${operation})`);
    this.name = "ErreurSourceDonnees";
    this.cause = cause;
  }
}

type RaceRow = {
  id: string;
  race_date: string;
  relative_day: RaceAnalysis["relativeDay"];
  reunion_number: number | null;
  course_number: number | null;
  source_country: string | null;
  name: string;
  racecourse: string;
  start_time: string;
  discipline: RaceAnalysis["discipline"];
  specialty: string | null;
  distance: string;
  going: string;
  weather: string;
  market_volatility: string;
  model_consensus: string;
  race_quality_score: string;
  betting_tier: RaceAnalysis["bettingTier"];
  risk_level: RaceAnalysis["riskLevel"];
  bet_types: BetOffer[] | string | null;
  odds_refreshed_at: string | null;
  start_type: string | null;
  racecourse_id: string | null;
  prize: number | null;
  going_updated_at: string | null;
};

type EntryRow = {
  id: string;
  horse_id: string;
  number: number;
  horse: string;
  age: number | null;
  sex: string | null;
  music: string | null;
  earnings: string | null;
  handicap_distance: number | null;
  reduction_km: string | null;
  speed_figure: string | null;
  draw: number | null;
  weight: string | null;
  shoeing: string | null;
  jockey_id: string | null;
  equipment: string | null;
  blinkers: string | null;
  silks_url: string | null;
  jockey: string;
  trainer: string;
  odds: string | null;
  odds_source: string | null;
  fair_odds: string | null;
  market_edge: string | null;
  win_probability: string | null;
  top3_probability: string | null;
  top5_probability: string | null;
  kz_score: string | null;
  value_index: string | null;
  confidence: Confidence;
  factors: string[] | string;
  finish_position: number | null;
  won: boolean | null;
  pool_win: string | null;
  pool_place: string | null;
  jockey_runs: number | null;
  jockey_wins: number | null;
  trainer_runs: number | null;
  trainer_wins: number | null;
  jockey_runs_pre: number | null;
  jockey_wins_pre: number | null;
  trainer_runs_pre: number | null;
  trainer_wins_pre: number | null;
};

/**
 * Spécialité telle qu'on l'écrit. L'import PMU livre « Attele » et « Monte »
 * sans accent, et répète la discipline pour le plat et l'obstacle : l'en-tête
 * des courses affichait « Plat · Plat ». Chaîne vide quand elle n'apporte rien.
 */
function specialtyLabel(specialty: string | null, discipline: string): string {
  const labels: Record<string, string> = { Attele: "Attelé", Monte: "Monté" };
  const value = specialty ? (labels[specialty] ?? specialty) : "";
  return value === discipline ? "" : value;
}

/**
 * Programme partagé entre l'accueil, le direct, les pronostics, le sitemap et
 * l'API : chaque rendu relisait sinon toutes les courses et tous leurs partants
 * (de l'ordre du mégaoctet), et ce transfert a épuisé le quota mensuel Neon.
 * Dix minutes de fraîcheur, pour toutes les pages à la fois ; la page d'une
 * course relit toujours ses propres cotes. La date de Paris entre dans la clé
 * pour qu'« aujourd'hui » ne serve pas la veille après minuit.
 */
//
// Une entrée par JOUR, pas une pour les trois jours : Next n'enregistre pas une
// entrée de plus de 2 Mo (simple avertissement), et le programme de trois
// jours la dépassait probablement les jours chargés — le cache ne stockait
// alors rien et chaque rendu relisait tout (audit du 08/11/2026). La clé ne
// dépend que de la date réelle : `day=today` et `date=<aujourd'hui>` partagent
// la même entrée.
const loadDayCached = unstable_cache(
  async (date: string, parisDate: string | null) => {
    void parisDate; // n'influe que sur la clé de cache
    return loadRaces({ date });
  },
  ["races-programme-jour"],
  { revalidate: 600 },
);

export async function getRaces(filters?: { date?: string | null; day?: string | null }) {
  if (!hasDatabase()) return loadRaces(filters);
  const today = dateForRelativeDay("today");
  const date = filters?.date ?? (filters?.day ? dateForRelativeDay(filters.day) : null);
  if (date) return loadDayCached(date, today);
  const days = ["yesterday", "today", "tomorrow"].map(dateForRelativeDay).filter((d): d is string => Boolean(d));
  return (await Promise.all(days.map((d) => loadDayCached(d, today)))).flat();
}

async function loadRaces(filters?: { date?: string | null; day?: string | null }) {
  const filterDate = filters?.date ?? (filters?.day ? dateForRelativeDay(filters.day) : null);
  const yesterdayDate = dateForRelativeDay("yesterday");
  const todayDate = dateForRelativeDay("today");
  const tomorrowDate = dateForRelativeDay("tomorrow");
  const rollingDates = [yesterdayDate, todayDate, tomorrowDate].filter((date): date is string => Boolean(date));

  if (!hasDatabase()) {
    return demoRaces.filter((race) => {
      if (filterDate && race.raceDate !== filterDate) return false;
      if (!filterDate && !filters?.day && !rollingDates.includes(race.raceDate)) return false;
      if (filters?.day && relativeDayFromDate(race.raceDate) !== filters.day) return false;
      return true;
    });
  }

  let rows: RaceRow[] = [];

  try {
    const sql = getSql();
    rows = await sql`
      select
        races.id,
        races.race_date::text,
        races.relative_day,
        races.reunion_number,
        races.course_number,
        coalesce(races.source_country, racecourses.country, 'N/A') as source_country,
        races.name,
        racecourses.name as racecourse,
        races.start_time,
        races.discipline,
        races.specialty,
        races.distance,
        races.going,
        races.weather,
        races.market_volatility::text,
        races.model_consensus::text,
        races.race_quality_score::text,
        races.betting_tier,
        races.risk_level,
        races.bet_types,
        to_char(races.odds_refreshed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as odds_refreshed_at,
        -- Colonnes ajoutées en octobre 2026, lues par to_jsonb : tant que le
        -- schéma n'est pas appliqué, elles valent null au lieu de faire
        -- échouer la page (le site peut être déployé avant la migration).
        to_jsonb(races) ->> 'start_type' as start_type,
        races.racecourse_id::text as racecourse_id,
        (to_jsonb(races) ->> 'prize')::int as prize,
        to_char((to_jsonb(races) ->> 'going_updated_at')::timestamptz at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as going_updated_at
      from races
      left join racecourses on racecourses.id = races.racecourse_id
      where
        (${filterDate ?? null}::text is not null and races.race_date = ${filterDate ?? null}::date)
        or (
          ${filterDate ?? null}::text is null
          and races.race_date in (${yesterdayDate}::date, ${todayDate}::date, ${tomorrowDate}::date)
        )
      order by races.race_date, races.start_time, races.reunion_number nulls last, races.course_number nulls last
    ` as RaceRow[];
  } catch (cause) {
    // Renvoyer `demoRaces` ici transformait une panne base en programme fictif
    // servi comme authentique. On remonte : la page conserve alors sa dernière
    // version valide en cache ISR, ou affiche la frontière d'erreur.
    console.error("Lecture des courses impossible", cause);
    throw new ErreurSourceDonnees("lecture des courses", cause);
  }

  // Une requête pour les partants de toutes les courses, au lieu d'une par
  // course : le chargement du programme passait 104 allers-retours en base
  // (1 + 103 courses), chacun payant la latence réseau du serverless Neon.
  let entriesByRace: Map<string, EntryRow[]>;
  try {
    entriesByRace = await fetchEntriesByRace(rows.map((row) => row.id));
  } catch (cause) {
    console.error("Lecture des partants impossible", cause);
    throw new ErreurSourceDonnees("lecture des partants", cause);
  }

  const [histories, press] = await Promise.all([
    loadHistories(getSql() as unknown as SqlTag, rows, entriesByRace),
    loadPressSelections(rows.map((row) => row.id)),
  ]);
  const hydratedRaces = rows.flatMap((row) => {
    const entries = entriesByRace.get(row.id);
    // Une course sans partant n'est pas affichable. L'ancien code lui
    // substituait la course de démonstration, qui apparaissait alors dans le
    // programme réel — autant de doublons que de courses vides.
    return entries?.length ? [{ ...mapRace(row, entries, histories), press: press.get(row.id) ?? [] }] : [];
  });

  return sortByStartTime(hydratedRaces);
}

/**
 * Charge les partants d'un lot de courses et les regroupe par course.
 * Partagé entre le programme et la page course pour qu'une seule requête,
 * unique, décrive ce qu'est un partant.
 */
async function fetchEntriesByRace(raceIds: string[]) {
  const byRace = new Map<string, EntryRow[]>();
  if (raceIds.length === 0) return byRace;

  const sql = getSql();
  const rows = (await sql`
    select
      entries.race_id,
      entries.id,
      entries.horse_id,
      entries.number,
      horses.name as horse,
      coalesce(entries.age, horses.age) as age,
      entries.sex,
      entries.music,
      entries.earnings::text,
      entries.handicap_distance,
      entries.reduction_km,
      entries.speed_figure::text,
      entries.draw,
      entries.weight::text,
      entries.shoeing,
      entries.jockey_id::text,
      entries.equipment,
      ej.j ->> 'blinkers' as blinkers,
      entries.silks_url,
      jockeys.name as jockey,
      trainers.name as trainer,
      entries.odds::text,
      ej.j ->> 'odds_source' as odds_source,
      entries.fair_odds::text,
      entries.market_edge::text,
      entries.win_probability::text,
      entries.top3_probability::text,
      entries.top5_probability::text,
      entries.kz_score::text,
      entries.value_index::text,
      entries.confidence,
      entries.factors,
      results.finish_position,
      results.won,
      entries.pool_win::text,
      entries.pool_place::text,
      js.runs as jockey_runs,
      js.wins as jockey_wins,
      ts.runs as trainer_runs,
      ts.wins as trainer_wins,
      -- Totaux figés avant la course ; la règle de lecture (figé, sinon courant
      -- pour une course à venir, sinon rien) est dans src/lib/point-in-time.ts.
      (ej.j ->> 'jockey_runs_pre')::int as jockey_runs_pre,
      (ej.j ->> 'jockey_wins_pre')::int as jockey_wins_pre,
      (ej.j ->> 'trainer_runs_pre')::int as trainer_runs_pre,
      (ej.j ->> 'trainer_wins_pre')::int as trainer_wins_pre
    from entries
    -- Ligne sérialisée une seule fois, pour lire les colonnes d'octobre 2026
    -- même avant la migration (null si absentes).
    cross join lateral (select to_jsonb(entries) as j offset 0) ej
    join horses on horses.id = entries.horse_id
    left join jockeys on jockeys.id = entries.jockey_id
    left join trainers on trainers.id = entries.trainer_id
    left join connection_stats js on js.kind = 'jockey' and js.person_id = entries.jockey_id
    left join connection_stats ts on ts.kind = 'trainer' and ts.person_id = entries.trainer_id
    left join results on results.race_id = entries.race_id and results.horse_id = entries.horse_id
    where entries.race_id = any(${raceIds})
    order by entries.race_id, entries.kz_score desc nulls last, entries.number
  `) as Array<EntryRow & { race_id: string }>;

  for (const row of rows) {
    const liste = byRace.get(row.race_id);
    if (liste) liste.push(row);
    else byRace.set(row.race_id, [row]);
  }

  return byRace;
}

/**
 * Une course, ou `null` si l'identifiant est inconnu.
 *
 * L'option `fallback` a disparu : elle valait `true` par défaut et renvoyait la
 * course de démonstration pour n'importe quel identifiant inexistant. Une URL
 * `/races/nimporte-quoi` affichait donc une course complète — partants, cotes,
 * pronostics — au lieu d'un 404, et Google indexait autant de pages fantômes
 * qu'on lui en présentait.
 */
export async function getRaceById(id?: string | null): Promise<RaceAnalysis | null> {
  if (!id) return null;

  if (!hasDatabase()) {
    return demoRaces.find((race) => race.id === id) ?? null;
  }

  const sql = getSql();
  let row: RaceRow | undefined;

  try {
    row = (await sql`
      select
        races.id,
        races.race_date::text,
        races.relative_day,
        races.reunion_number,
        races.course_number,
        coalesce(races.source_country, racecourses.country, 'N/A') as source_country,
        races.name,
        racecourses.name as racecourse,
        races.start_time,
        races.discipline,
        races.specialty,
        races.distance,
        races.going,
        races.weather,
        races.market_volatility::text,
        races.model_consensus::text,
        races.race_quality_score::text,
        races.betting_tier,
        races.risk_level,
        races.bet_types,
        to_char(races.odds_refreshed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as odds_refreshed_at,
        -- Colonnes ajoutées en octobre 2026, lues par to_jsonb : tant que le
        -- schéma n'est pas appliqué, elles valent null au lieu de faire
        -- échouer la page (le site peut être déployé avant la migration).
        to_jsonb(races) ->> 'start_type' as start_type,
        races.racecourse_id::text as racecourse_id,
        (to_jsonb(races) ->> 'prize')::int as prize,
        to_char((to_jsonb(races) ->> 'going_updated_at')::timestamptz at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as going_updated_at
      from races
      left join racecourses on racecourses.id = races.racecourse_id
      where races.id = ${id}
      limit 1
    ` as RaceRow[])[0];
  } catch (cause) {
    console.error("Lecture de la course %s impossible", id, cause);
    throw new ErreurSourceDonnees("lecture d'une course", cause);
  }

  if (!row) return null;

  const entries = (await fetchEntriesByRace([row.id])).get(row.id) ?? [];

  // Une course sans partant n'est pas affichable : elle vaut 404, pas une
  // page de démonstration.
  if (entries.length === 0) return null;
  const [histories, press] = await Promise.all([
    loadHistories(getSql() as unknown as SqlTag, [row], new Map([[row.id, entries]])),
    loadPressSelections([row.id]),
  ]);
  return { ...mapRace(row, entries, histories), press: press.get(row.id) ?? [] };
}

export async function getPredictions() {
  const races = await getRaces();
  return races
    .flatMap((race) => probableArrival(race.horses, raceToContext(race)).map((horse, index) => ({ ...horse, raceId: race.id, raceName: race.name, arrivalRank: index + 1 })))
    .sort((a, b) => a.arrivalRank - b.arrivalRank || b.top3Probability - a.top3Probability);
}

export async function getValueBets() {
  if (!hasDatabase()) return valueBets;

  const predictions = await getPredictions();
  return predictions
    .filter((horse) => horse.valueIndex > VALUE_EDGE_THRESHOLD || (horse.odds >= 6 && horse.top3Probability >= 18))
    .sort((a, b) => b.valueIndex - a.valueIndex || a.arrivalRank - b.arrivalRank);
}

function mapRace(row: RaceRow, entries: EntryRow[], histories?: Map<string, PastRunsByHorse>): RaceAnalysis {
  // Course partie : les statistiques jockey/entraîneur courantes contiennent
  // l'avenir (et ce résultat-ci) — seules les valeurs figées sont lues.
  const started = raceHasStarted(
    { raceDate: row.race_date, startTime: row.start_time },
    entries.some((entry) => entry.finish_position != null && entry.finish_position > 0),
  );
  // Contexte de course et historique : lus par le modèle fondamental v2
  // (corde, spécialité, type de départ, aptitudes). L'ancien modèle les ignore.
  const raceContext = {
    specialty: row.specialty,
    startType: row.start_type,
    distance: Number.parseInt(String(row.distance), 10) || null,
    prize: row.prize != null ? Number(row.prize) : null,
    going: row.going,
  };
  const horses = withFundamental(
    entries.map((entry) => ({
      ...mapHorse(entry, started),
      raceContext,
      history: historyFor(histories?.get(row.race_date), entry, row, raceContext),
    })),
    row.discipline,
  );
  return {
    id: row.id,
    name: row.name,
    raceDate: row.race_date,
    relativeDay: relativeDayFromDate(row.race_date),
    reunionNumber: row.reunion_number ?? programNumber(row.id, "R"),
    courseNumber: row.course_number ?? programNumber(row.id, "C"),
    programCode: `R${row.reunion_number ?? programNumber(row.id, "R")}C${row.course_number ?? programNumber(row.id, "C")}`,
    sourceCountry: row.source_country ?? "N/A",
    racecourse: row.racecourse,
    startTime: row.start_time,
    discipline: row.discipline,
    specialty: specialtyLabel(row.specialty, row.discipline),
    distance: row.distance,
    going: row.going,
    weather: row.weather,
    marketVolatility: Number(row.market_volatility),
    modelConsensus: Number(row.model_consensus),
    raceQualityScore: Number(row.race_quality_score),
    bettingTier: row.betting_tier,
    riskLevel: row.risk_level,
    betTypes: parseJsonArray<BetOffer>(row.bet_types),
    // Recalibrage à l'échelle de la course : les probabilités stockées en base
    // sont calculées cheval par cheval, sans normalisation (Σ win ≈ 185 %).
    // On les remplace ici, une seule fois, pour que tous les consommateurs —
    // page course, dashboard, tickets, API — lisent les mêmes valeurs.
    // Discipline : coefficients du marché ajustés (lib/market-calibration) ;
    // délai au départ : l'espérance se lit à la cote finale attendue.
    horses: calibrateField(horses, {
      discipline: row.discipline,
      minutesToStart: minutesToStart({ raceDate: row.race_date, startTime: row.start_time }),
    }),
    oddsAvailable: horses.some((horse) => Number.isFinite(horse.odds) && horse.odds > 1),
    oddsRefreshedAt: row.odds_refreshed_at,
    startType: row.start_type === "autostart" || row.start_type === "volte" ? row.start_type : null,
    prize: row.prize != null ? Number(row.prize) : null,
    goingUpdatedAt: row.going_updated_at,
  };
}

type PastRunsByHorse = Awaited<ReturnType<typeof fetchHorseHistories>>;

type PressRow = { race_id: string; source: string; ranks: number[]; url: string | null; fetched_at: string };

/**
 * Sélections des sites de pronostics (table `press_selections`, remplie par
 * scripts/import-press.mjs). Échec non bloquant : table pas encore créée ou
 * base lente, la page s'affiche sans le comparateur.
 */
async function loadPressSelections(raceIds: string[]): Promise<Map<string, NonNullable<RaceAnalysis["press"]>>> {
  const out = new Map<string, NonNullable<RaceAnalysis["press"]>>();
  if (raceIds.length === 0) return out;
  try {
    const rows = (await getSql()`
      select race_id, source, ranks, url,
             to_char(fetched_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as fetched_at
        from press_selections
       where race_id = any(${raceIds})
    `) as PressRow[];
    for (const row of rows) {
      const list = out.get(row.race_id) ?? [];
      list.push({ source: row.source, ranks: (row.ranks ?? []).map(Number), url: row.url, fetchedAt: row.fetched_at });
      out.set(row.race_id, list);
    }
  } catch (cause) {
    const code = (cause as { code?: string }).code;
    if (code !== "42P01") console.error("Sélections des sites illisibles", cause instanceof Error ? cause.message : cause);
  }
  return out;
}

/** Variables du modèle v2 qui ont besoin de l'historique en base. */
const HISTORY_FEATURES = new Set([
  "daysSinceLog", "longBreak", "runs90d", "historyMissing", "bestRelFinish", "avgRelFinish",
  "distAptitude", "goingAptitude", "courseAptitude", "classChange", "classMissing", "comboRuns", "comboRate", "shoeFirstTime",
  "chronoBest", "chronoLast", "chronoMissing",
]);

/**
 * Vrai si le modèle chargé lit l'historique : tant que l'ancien modèle tourne,
 * la requête d'historique (coûteuse) n'est pas faite.
 */
const MODEL_USES_HISTORY = (["Plat", "Trot", "Obstacle"] as const).some((d) =>
  fundamentalFeatureNames(d).some((f) => HISTORY_FEATURES.has(f)),
);

/**
 * Historique des partants d'un lot de courses, une requête par jour de
 * course : chaque course ne voit que les sorties strictement antérieures à
 * sa date (aucune fuite). Échec non bloquant : le modèle prend alors
 * l'indicateur « historique manquant ».
 */
async function loadHistories(sql: SqlTag, rows: RaceRow[], entriesByRace: Map<string, EntryRow[]>) {
  const byDate = new Map<string, PastRunsByHorse>();
  if (!MODEL_USES_HISTORY) return byDate;
  const dates = [...new Set(rows.map((r) => r.race_date))];
  await Promise.all(
    dates.map(async (date) => {
      const ids = rows.filter((r) => r.race_date === date).flatMap((r) => (entriesByRace.get(r.id) ?? []).map((e) => e.horse_id));
      try {
        byDate.set(date, await fetchHorseHistories(sql, ids, date));
      } catch (cause) {
        console.error("Historique des partants du %s illisible", date, cause instanceof Error ? cause.message : cause);
      }
    }),
  );
  return byDate;
}

function historyFor(
  runs: PastRunsByHorse | undefined,
  entry: EntryRow,
  row: RaceRow,
  context: { distance: number | null; going: string; prize: number | null },
): HorseHistory | null {
  if (!runs) return null;
  return computeHorseHistory(runs.get(entry.horse_id) ?? [], {
    date: row.race_date,
    distance: context.distance,
    going: context.going,
    racecourse: row.racecourse_id,
    prize: context.prize,
    jockeyId: entry.jockey_id,
  });
}

/** Ajoute l'avis du modèle fondamental (sans cote), en %, à chaque partant. */
function withFundamental(horses: HorsePrediction[], discipline: RaceAnalysis["discipline"]): HorsePrediction[] {
  const probabilities = fundamentalProbabilities(horses, discipline);
  if (!probabilities) return horses;
  return horses.map((horse, i) => ({ ...horse, fundamentalProbability: Math.round(probabilities[i] * 1000) / 10 }));
}

function dateForRelativeDay(day: string) {
  if (day !== "yesterday" && day !== "today" && day !== "tomorrow") return null;

  if (day === "yesterday") return parisDateOffset(-1);
  if (day === "tomorrow") return parisDateOffset(1);
  return parisDateOffset(0);
}

function relativeDayFromDate(date: string): RaceAnalysis["relativeDay"] {
  if (date === dateForRelativeDay("yesterday")) return "yesterday";
  if (date === dateForRelativeDay("today")) return "today";
  if (date === dateForRelativeDay("tomorrow")) return "tomorrow";
  return "other";
}

function parisDateOffset(offset: number) {
  const parisDate = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Europe/Paris",
    year: "numeric",
  }).format(new Date());
  const [year, month, day] = parisDate.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + offset, 12));

  return new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "UTC",
    year: "numeric",
  }).format(date);
}

function programNumber(id: string, marker: "R" | "C") {
  const pattern = marker === "R" ? /-R(\d+)-C\d+$/ : /-R\d+-C(\d+)$/;
  return Number(id.match(pattern)?.[1] ?? 0);
}

function sortByStartTime(races: RaceAnalysis[]) {
  return races.sort(
    (a, b) =>
      a.raceDate.localeCompare(b.raceDate) ||
      a.startTime.localeCompare(b.startTime) ||
      a.reunionNumber - b.reunionNumber ||
      a.courseNumber - b.courseNumber,
  );
}

function mapHorse(row: EntryRow, raceStarted: boolean): HorsePrediction {
  return {
    id: row.id,
    horseId: row.horse_id,
    number: row.number,
    horse: row.horse,
    age: row.age,
    sex: row.sex,
    music: row.music,
    earnings: row.earnings === null ? null : Number(row.earnings),
    handicapDistance: row.handicap_distance,
    reductionKm: row.reduction_km,
    speedFigure: row.speed_figure != null ? Number(row.speed_figure) : null,
    draw: row.draw,
    weight: row.weight != null ? Number(row.weight) : null,
    shoeing: row.shoeing,
    equipment: row.equipment,
    blinkers: row.blinkers,
    silksUrl: row.silks_url,
    jockey: row.jockey,
    trainer: row.trainer,
    // `Number(null)` vaut 0, pas NaN : une cote absente passait pour une cote
    // de 0 et `devig` lui attribuait une probabilité. NaN dit « inconnu ».
    odds: row.odds != null ? Number(row.odds) : NaN,
    oddsSource: parseOddsSource(row.odds_source),
    fairOdds: row.fair_odds != null ? Number(row.fair_odds) : NaN,
    marketEdge: row.market_edge != null ? Number(row.market_edge) : 0,
    winProbability: row.win_probability != null ? Number(row.win_probability) : 0,
    top3Probability: row.top3_probability != null ? Number(row.top3_probability) : 0,
    top5Probability: row.top5_probability != null ? Number(row.top5_probability) : 0,
    // La valeur spéciale PostgreSQL 'NaN' arrive sous forme de texte : Number()
    // la convertit bien en NaN, que `modelProbabilities` traite comme manquante.
    kzScore: row.kz_score != null ? Number(row.kz_score) : NaN,
    valueIndex: row.value_index != null ? Number(row.value_index) : 0,
    confidence: row.confidence,
    factors: parseJsonArray<string>(row.factors),
    finishPosition: row.finish_position,
    won: row.won,
    poolWin: row.pool_win != null ? Number(row.pool_win) : null,
    poolPlace: row.pool_place != null ? Number(row.pool_place) : null,
    ...connectionStatsAt(row, raceStarted),
  };
}

function parseJsonArray<T>(value: T[] | string | null | undefined): T[] {
  if (Array.isArray(value)) return value;
  if (!value) return [];

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Historique de marché d'une course : relevés de cote par numéro et parts des
 * enjeux. Deux requêtes indexées (race_id en tête de clé), quelques centaines
 * de lignes au plus.
 */
export async function getRaceMarketHistory(raceId: string): Promise<MarketHistory> {
  if (!hasDatabase()) return { odds: {}, pools: [] };
  const sql = getSql();
  try {
    const [oddsRaw, poolRaw] = await Promise.all([
      sql`
        select e.number, o.odds::float8 as odds, to_char(o.observed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as t
          from odds_snapshots o
          join entries e on e.race_id = o.race_id and e.horse_id = o.horse_id
         where o.race_id = ${raceId}
         order by o.observed_at
      `,
      sql`
        select to_char(observed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as t, numbers, pool_win
          from pool_snapshots
         where race_id = ${raceId}
         order by observed_at
      `,
    ]);
    const oddsRows = oddsRaw as Array<{ number: number; odds: number; t: string }>;
    const poolRows = poolRaw as Array<{ t: string; numbers: number[]; pool_win: number[] }>;
    const odds: MarketHistory["odds"] = {};
    for (const row of oddsRows) (odds[row.number] ??= []).push({ t: row.t, odds: Number(row.odds) });
    const pools = poolRows.map((row) => ({ t: row.t, numbers: row.numbers.map(Number), win: row.pool_win.map(Number) }));
    return { odds, pools };
  } catch (cause) {
    // L'historique enrichit la page, il ne la conditionne pas.
    console.error("Historique de marché indisponible pour %s", raceId, cause);
    return { odds: {}, pools: [] };
  }
}

export type SignalRecord = {
  key: string;
  label: string;
  betType: string;
  bets: number;
  hitRate: number;
  roi: number;
  roiLow: number;
  roiHigh: number;
};

export type TrackRecordSummary = {
  generatedAt: string;
  period: { from: string; to: string };
  signals: SignalRecord[];
};

/**
 * Dernier rapport du suivi de performance, ou `null` s'il n'en existe pas encore.
 *
 * Le rapport est un gros JSON (séries quotidiennes de chaque signal) relu par
 * l'accueil et par chaque page de course : il n'est recalculé que par le
 * backtest, une heure de cache suffit largement.
 */
export async function getLatestTrackRecord(): Promise<(TrackRecordSummary & Record<string, unknown>) | null> {
  if (!hasDatabase()) return null;
  return loadLatestTrackRecordCached();
}

const loadLatestTrackRecordCached = unstable_cache(loadLatestTrackRecord, ["track-record-latest"], { revalidate: 3600 });

async function loadLatestTrackRecord(): Promise<(TrackRecordSummary & Record<string, unknown>) | null> {
  try {
    const sql = getSql();
    const rows = (await sql`
      select report from track_record_reports order by generated_at desc limit 1
    `) as Array<{ report: TrackRecordSummary & Record<string, unknown> }>;
    return rows[0]?.report ?? null;
  } catch (cause) {
    console.error("Suivi de performance indisponible", cause);
    return null;
  }
}

/**
 * Pronostics gelés d'une course (H-60, H-15, H-2), du plus ancien au plus
 * récent, tels qu'ils ont été publiés avant le départ. Tableau vide sans base
 * (démonstration), pour une course sans gel, ou si la lecture échoue : la
 * comparaison enrichit la page, elle ne la conditionne pas.
 */
export async function getFrozenPredictions(raceId: string): Promise<Array<import("@/lib/frozen-diff").FrozenStage>> {
  if (!hasDatabase()) return [];
  try {
    const sql = getSql();
    const rows = (await sql`
      select stage,
             to_char(captured_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as captured_at,
             minutes_to_start, model_version, payload
        from prediction_snapshots
       where race_id = ${raceId}
       order by captured_at
    `) as Array<{
      stage: import("@/lib/frozen-diff").FrozenStageName;
      captured_at: string;
      minutes_to_start: number;
      model_version: string;
      payload: import("@/lib/live/freeze").FrozenPayload;
    }>;
    return rows.map((r) => ({
      stage: r.stage,
      capturedAt: r.captured_at,
      minutesToStart: Number(r.minutes_to_start),
      modelVersion: r.model_version,
      payload: r.payload,
    }));
  } catch (cause) {
    console.error("Pronostics gelés indisponibles pour %s", raceId, cause);
    return [];
  }
}

/**
 * Fraîcheur des données, pour la page publique /etat.
 *
 * Une seule requête, agrégée côté base, plutôt que de recharger le programme
 * complet : la page est régénérée toutes les minutes. Les maxima sont bornés
 * aux courses des sept derniers jours — l'import ne réécrit que J-1, J et J+1,
 * et un balayage de tout l'historique n'apporterait rien de plus qu'un import
 * en panne depuis plus d'une semaine, que la page annonce de toute façon.
 *
 *  - dernier import : `races.data_cutoff_at`, posé à chaque écriture d'une
 *    course par l'import PMU ;
 *  - dernières cotes : `races.odds_refreshed_at`, posé par la boucle live et
 *    par le bouton « Relancer l'analyse IA » ;
 *  - couverture : courses du jour (heure de Paris) dont au moins un partant a
 *    une cote — une cote absente est NULL, jamais fabriquée ;
 *  - dernier rapport du suivi de performance.
 *
 * Sans base, `mode: "demonstration"` ; base injoignable, `mode: "indisponible"`
 * — la page le dit au lieu d'afficher des zéros trompeurs.
 */
export type EtatDonnees =
  | { mode: "demonstration" }
  | { mode: "indisponible" }
  | {
      mode: "connecte";
      /** Instant de la lecture, horloge de la base : référence des âges affichés. */
      luA: string;
      dateDuJour: string;
      dernierImport: string | null;
      dernieresCotes: string | null;
      coursesDuJour: number;
      coursesDuJourAvecCotes: number;
      dernierRapportPerformance: string | null;
    };

export async function getEtatDonnees(): Promise<EtatDonnees> {
  if (!hasDatabase()) return { mode: "demonstration" };
  const aujourdhui = dateForRelativeDay("today")!;
  const iso = (colonne: string) => `to_char(${colonne} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
  try {
    const rows = (await getSql().query(
      `select
         ${iso("now()")} as read_at,
         ${iso("max(r.data_cutoff_at)")} as imported_at,
         ${iso("max(r.odds_refreshed_at)")} as odds_refreshed_at,
         count(*) filter (where r.race_date = $1::date)::int as races_today,
         count(*) filter (
           where r.race_date = $1::date
             and exists (select 1 from entries e where e.race_id = r.id and e.odds is not null)
         )::int as races_today_with_odds,
         (select ${iso("max(generated_at)")} from track_record_reports) as report_at
       from races r
       where r.race_date >= $1::date - 7`,
      [aujourdhui],
    )) as Array<{
      read_at: string;
      imported_at: string | null;
      odds_refreshed_at: string | null;
      races_today: number;
      races_today_with_odds: number;
      report_at: string | null;
    }>;
    const row = rows[0];
    return {
      mode: "connecte",
      luA: row?.read_at ?? new Date().toISOString(),
      dateDuJour: aujourdhui,
      dernierImport: row?.imported_at ?? null,
      dernieresCotes: row?.odds_refreshed_at ?? null,
      coursesDuJour: row?.races_today ?? 0,
      coursesDuJourAvecCotes: row?.races_today_with_odds ?? 0,
      dernierRapportPerformance: row?.report_at ?? null,
    };
  } catch (cause) {
    console.error("État du service indisponible", cause);
    return { mode: "indisponible" };
  }
}

/**
 * Programme d'un jour réduit à l'essentiel, pour la navigation de la page
 * course (course précédente / suivante, carte de la réunion). Une requête sur
 * `races` seule, indexée par date — pas de partants, contrairement à
 * `getRaces`, qui hydrate chaque course entière. Une course sans partant est
 * écartée, comme dans le programme : elle répondrait 404.
 */
export type DayRaceIndexItem = Pick<
  RaceAnalysis,
  "id" | "raceDate" | "startTime" | "reunionNumber" | "courseNumber" | "programCode" | "racecourse" | "name" | "discipline"
> & {
  /** Au moins une place d'arrivée publiée. */
  arrived: boolean;
};

export async function getDayRaceIndex(raceDate: string): Promise<DayRaceIndexItem[]> {
  if (!hasDatabase()) {
    return demoRaces
      .filter((race) => race.raceDate === raceDate)
      .map((race) => ({
        id: race.id,
        raceDate: race.raceDate,
        startTime: race.startTime,
        reunionNumber: race.reunionNumber,
        courseNumber: race.courseNumber,
        programCode: race.programCode,
        racecourse: race.racecourse,
        name: race.name,
        discipline: race.discipline,
        arrived: race.horses.some((h) => h.finishPosition != null && h.finishPosition > 0),
      }));
  }

  try {
    const sql = getSql();
    const rows = (await sql`
      select
        races.id,
        races.race_date::text,
        races.reunion_number,
        races.course_number,
        races.name,
        racecourses.name as racecourse,
        races.start_time,
        races.discipline,
        exists (select 1 from results where results.race_id = races.id and results.finish_position > 0) as arrived
      from races
      left join racecourses on racecourses.id = races.racecourse_id
      where races.race_date = ${raceDate}::date
        and exists (select 1 from entries where entries.race_id = races.id)
      order by races.start_time, races.reunion_number, races.course_number
    `) as Array<{
      id: string;
      race_date: string;
      reunion_number: number | null;
      course_number: number | null;
      name: string;
      racecourse: string | null;
      start_time: string;
      discipline: RaceAnalysis["discipline"];
      arrived: boolean;
    }>;
    return rows.map((row) => {
      const reunion = row.reunion_number ?? programNumber(row.id, "R");
      const course = row.course_number ?? programNumber(row.id, "C");
      return {
        id: row.id,
        raceDate: row.race_date,
        startTime: row.start_time,
        reunionNumber: reunion,
        courseNumber: course,
        programCode: `R${reunion}C${course}`,
        racecourse: row.racecourse ?? "",
        name: row.name,
        discipline: row.discipline,
        arrived: Boolean(row.arrived),
      };
    });
  } catch (cause) {
    // La navigation enrichit la page, elle ne la conditionne pas.
    console.error("Programme du jour indisponible pour %s", raceDate, cause);
    return [];
  }
}

/** Rapport officiel PMU pour 1 € (table `race_payouts`, alimentée après l'arrivée). */
export type RacePayout = { betType: string; combination: string; dividend: number };

/**
 * Rapports officiels d'une course : quatre à huit lignes, lues par clé
 * primaire. Liste vide tant que le PMU ne les a pas publiés, et en
 * démonstration : aucun rapport n'est inventé.
 */
export async function getRacePayouts(raceId: string): Promise<RacePayout[]> {
  if (!hasDatabase()) return [];
  try {
    const sql = getSql();
    const rows = (await sql`
      select bet_type, combination, dividend::float8 as dividend
        from race_payouts
       where race_id = ${raceId}
       order by bet_type, dividend
    `) as Array<{ bet_type: string; combination: string; dividend: number }>;
    return rows.map((row) => ({ betType: row.bet_type, combination: row.combination, dividend: Number(row.dividend) }));
  } catch (cause) {
    console.error("Rapports indisponibles pour %s", raceId, cause);
    return [];
  }
}
