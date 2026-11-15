/**
 * Relevé des cotes du simple gagnant chez les opérateurs partenaires (ZEturf,
 * Genybet), dans `operator_odds`. Alimente les tableaux « Marché par opérateur »
 * de la page course (src/lib/operator-board.ts).
 *
 *   node scripts/operator-odds-loop.mjs --minutes 330   # boucle (lancée par live-refresh.ts)
 *   node scripts/operator-odds-loop.mjs --once          # une seule passe
 *   node scripts/operator-odds-loop.mjs --once --dry-run  # affiche sans écrire
 *
 * Cadence : cinq relevés au plus par course et par opérateur — le matin, puis
 * H-60, H-15, H-5 et H-2 (scripts/lib/press-sources/odds.mjs). Le relevé de H-2
 * donne le « classement final » ; il passe avant tous les autres.
 *
 * Mêmes règles que la collecte presse (scripts/lib/press-sources/http.mjs) :
 * identité de robot honnête, 1,5 s entre deux requêtes par site, robots.txt
 * respecté, aucun contournement. Un refus (401/403/429) arrête l'opérateur
 * jusqu'à la boucle suivante. `OPERATOR_ODDS=off` désactive tout ;
 * `OPERATOR_ODDS=zeturf` ne garde qu'un opérateur.
 */

import { neon } from "@neondatabase/serverless";
import { loadLocalEnv } from "./lib/pmu-fetch.mjs";
import { parseGenyProgramme } from "./lib/press-sources/geny.mjs";
import { createPoliteHttp, responseProblem } from "./lib/press-sources/http.mjs";
import { matchRace } from "./lib/press-sources/mapping.mjs";
import { oddsDue, parseGenyOdds, parseZeturfOdds } from "./lib/press-sources/odds.mjs";
import { looksLikeBotChallenge } from "./lib/press-sources/parse-utils.mjs";
import { parisIsoDate, parisStartEpoch } from "./lib/press-sources/races.mjs";
import { parisHour } from "./lib/press-sources/schedule.mjs";
import { parseZeturfProgramme, ZETURF_PROGRAMME_URL } from "./lib/press-sources/zeturf.mjs";

const TICK_MS = 20_000;
const RACES_TTL_MS = 30 * 60_000;
const URLS_TTL_MS = 60 * 60_000;
/** Avant cette heure (Paris), les opérateurs n'ont pas de cote du matin à relever. */
const MORNING_HOUR = 9;
/** Relevés par opérateur et par passage : les plus proches du départ d'abord. */
const BATCH = 4;
/** Plafond de requêtes par site sur une boucle de 5 h 30 (≈ 2 par minute). */
const MAX_REQUESTS_PER_HOST = 700;

const OPERATORS = {
  zeturf: {
    label: "ZEturf",
    parse: parseZeturfOdds,
    async urls(http, date, races) {
      const page = await http.get(ZETURF_PROGRAMME_URL);
      const problem = responseProblem(page, looksLikeBotChallenge);
      if (problem) return { problem };
      const map = new Map();
      for (const site of parseZeturfProgramme(page.text, date)) {
        const race = matchRace(races, { reunion: site.reunion, course: site.course, racecourse: site.slug.replace(/-/g, " ") });
        if (race) map.set(race.id, site.url);
      }
      return { map };
    },
  },
  genybet: {
    label: "Genybet",
    parse: parseGenyOdds,
    async urls(http, date, races) {
      const page = await http.get(`https://www.geny.com/programme/${date}`);
      const problem = responseProblem(page, looksLikeBotChallenge);
      if (problem) return { problem };
      const map = new Map();
      for (const site of parseGenyProgramme(page.text)) {
        const race = matchRace(races, site);
        if (race) map.set(race.id, site.url);
      }
      return { map };
    },
  },
};

function parseArgs(argv) {
  const options = { minutes: 330, once: false, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--once") options.once = true;
    else if (argv[i] === "--dry-run") options.dryRun = true;
    else if (argv[i] === "--minutes") options.minutes = Number(argv[(i += 1)]) || options.minutes;
    else throw new Error(`argument inconnu : ${argv[i]}`);
  }
  return options;
}

function enabledOperators() {
  const raw = String(process.env.OPERATOR_ODDS ?? "zeturf,genybet").toLowerCase();
  if (raw === "off" || raw === "0" || raw === "false") return [];
  return raw.split(",").map((key) => key.trim()).filter((key) => key in OPERATORS);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function loadRaces(sql, date) {
  const rows = await sql`
    select r.id, r.race_date::text as race_date, r.reunion_number, r.course_number, r.start_time, rc.name as racecourse
      from races r
      left join racecourses rc on rc.id = r.racecourse_id
     where r.race_date = ${date}
     order by r.start_time
  `;
  return rows.map((row) => ({
    id: row.id,
    date: row.race_date,
    reunion: row.reunion_number === null ? null : Number(row.reunion_number),
    course: row.course_number === null ? null : Number(row.course_number),
    racecourse: row.racecourse ?? null,
    startTime: row.start_time,
    start: parisStartEpoch(row.race_date, row.start_time),
  }));
}

/** Dernier relevé connu de chaque (opérateur, course), en minutes avant le départ. */
async function loadLastSeen(sql, races) {
  const starts = new Map(races.map((race) => [race.id, race.start]));
  const rows = await sql`
    select race_id, operator, max(observed_at) as last_at
      from operator_odds
     where race_id = any(${races.map((race) => race.id)})
     group by race_id, operator
  `;
  const last = new Map();
  for (const row of rows) {
    const start = starts.get(row.race_id);
    if (start) last.set(`${row.operator}|${row.race_id}`, (start - new Date(row.last_at).getTime()) / 60_000);
  }
  return last;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await loadLocalEnv();
  const operators = enabledOperators();
  if (operators.length === 0) return console.log("[cotes] relevé désactivé (OPERATOR_ODDS)");
  if (!process.env.DATABASE_URL) return console.warn("[cotes] DATABASE_URL absent : aucun relevé");

  const sql = neon(process.env.DATABASE_URL);
  const http = createPoliteHttp({ maxRequestsPerHost: MAX_REQUESTS_PER_HOST });
  const deadline = Date.now() + options.minutes * 60_000;
  const stopped = new Set();
  const urls = new Map(); // opérateur → { map, at }
  let races = [];
  let racesAt = 0;
  let racesDate = "";
  let lastSeen = new Map();
  let written = 0;

  async function refreshRaces() {
    const date = parisIsoDate(0);
    if (date === racesDate && Date.now() - racesAt < RACES_TTL_MS) return;
    races = (await loadRaces(sql, date)).filter((race) => race.start !== null);
    if (date !== racesDate) {
      urls.clear();
      lastSeen = await loadLastSeen(sql, races);
    }
    racesDate = date;
    racesAt = Date.now();
  }

  function dueRaces(key) {
    const now = Date.now();
    const hour = parisHour(now);
    return races
      .map((race) => ({ race, minutes: (race.start - now) / 60_000, last: lastSeen.get(`${key}|${race.id}`) ?? null }))
      .filter(({ minutes, last }) => oddsDue(minutes, last) && (last !== null || minutes <= 60 || hour >= MORNING_HOUR))
      .sort((a, b) => a.minutes - b.minutes)
      .slice(0, BATCH);
  }

  async function passFor(key) {
    if (stopped.has(key)) return;
    const operator = OPERATORS[key];
    const due = dueRaces(key);
    if (due.length === 0) return;

    const cached = urls.get(key);
    if (!cached || Date.now() - cached.at > URLS_TTL_MS) {
      const result = await operator.urls(http, racesDate, races);
      if (result.problem) {
        if (result.problem.status === "blocked") stopped.add(key);
        console.warn(`[cotes] ${operator.label} : programme illisible — ${result.problem.detail}${stopped.has(key) ? " ; opérateur arrêté pour cette boucle" : ""}`);
        return;
      }
      urls.set(key, { map: result.map, at: Date.now() });
    }
    const map = urls.get(key).map;

    for (const { race } of due) {
      const url = map.get(race.id);
      const minutes = (race.start - Date.now()) / 60_000;
      // Marqué avant la lecture : une page sans cote n'est pas redemandée avant le palier suivant.
      lastSeen.set(`${key}|${race.id}`, minutes);
      if (!url || minutes <= 0) continue;
      const page = await http.get(url);
      const problem = responseProblem(page, looksLikeBotChallenge);
      if (problem?.status === "blocked") {
        stopped.add(key);
        console.warn(`[cotes] ${operator.label} : accès refusé (${problem.detail}) ; opérateur arrêté pour cette boucle`);
        return;
      }
      if (problem) continue;
      const snapshot = operator.parse(page.text);
      // La course a pu partir pendant la lecture : aucune cote d'après-départ n'est écrite.
      if (!snapshot || Date.now() >= race.start) continue;
      if (options.dryRun) {
        console.log(`  ${key.padEnd(8)} ${race.id.padEnd(18)} H-${Math.round(minutes)} ${snapshot.numbers.map((n, i) => `${n}:${snapshot.odds[i] ?? "—"}`).join(" ")}`);
        continue;
      }
      await sql`
        insert into operator_odds (race_id, operator, observed_at, numbers, odds, reference)
        values (${race.id}, ${key}, now(), ${snapshot.numbers}::smallint[], ${snapshot.odds}::real[], ${snapshot.reference ?? null}::real[])
        on conflict do nothing
      `;
      written += 1;
    }
  }

  do {
    try {
      await refreshRaces();
      // Un opérateur après l'autre sur son propre site, les opérateurs en parallèle.
      await Promise.all(operators.map((key) => passFor(key)));
    } catch (error) {
      // Table pas encore créée : le schéma est appliqué par l'import PMU, rien à faire d'ici là.
      if (error?.code === "42P01") return console.warn("[cotes] table operator_odds absente : relevé remis à la prochaine boucle");
      console.warn("[cotes] passage ignoré :", error instanceof Error ? error.message : error);
    }
    if (options.once || stopped.size === operators.length) break;
    await sleep(Math.max(0, Math.min(TICK_MS, deadline - Date.now())));
  } while (Date.now() < deadline);

  console.log(`[cotes] terminé — ${written} relevé(s) écrit(s), requêtes par hôte :`, http.stats());
}

main().catch((error) => {
  // Le relevé des cotes ne doit jamais faire échouer la boucle des cotes PMU.
  console.error("[cotes] échec :", error instanceof Error ? error.message : error);
});
