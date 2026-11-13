/**
 * Import des sélections presse partenaires (Geny, ZEturf, Canalturf, Turfomania,
 * Paris-Turf) et du pronostic presse PMU dans `press_selections`.
 *
 *   node scripts/import-press.mjs                     # aujourd'hui (Paris), base DATABASE_URL
 *   node scripts/import-press.mjs --date 2026-11-01   # autre date (AAAA-MM-JJ ou JJMMAAAA)
 *   node scripts/import-press.mjs --dry-run           # affiche sans écrire
 *   node scripts/import-press.mjs --from-pmu --dry-run   # courses lues sur l'API PMU (sans base)
 *   node scripts/import-press.mjs --only geny,zeturf  # sous-ensemble de sources
 *   node scripts/import-press.mjs --missing-only      # seulement les sélections absentes de la base
 *   node scripts/import-press.mjs --tomorrow          # courses du lendemain (Paris)
 *
 * `--missing-only` sert aux passes répétées de la boucle en direct
 * (scripts/live-refresh.ts) : une course déjà relevée chez une source n'est pas
 * redemandée à son site, et une source complète n'est pas contactée du tout.
 *
 * Règles : une seule exécution séquentielle, client HTTP poli (voir
 * scripts/lib/press-sources/http.mjs) et UNIQUEMENT des courses non parties —
 * la sélection stockée est toujours d'avant-course. Le script sort en 0 même si
 * une source échoue : l'import presse ne doit jamais faire échouer le job PMU.
 */

import { neon } from "@neondatabase/serverless";
import { loadLocalEnv } from "./lib/pmu-fetch.mjs";
import { createPoliteHttp } from "./lib/press-sources/http.mjs";
import { PRESS_SOURCES } from "./lib/press-sources/index.mjs";
import { PMU_PRESSE_HOST, pmuDate } from "./lib/press-sources/pmu-presse.mjs";
import { isUpcoming, parisIsoDate, racesFromPmuProgramme } from "./lib/press-sources/races.mjs";
import { racesMissingSource, selectionKey } from "./lib/press-sources/schedule.mjs";

function parseArgs(argv) {
  const options = { date: parisIsoDate(0), dryRun: false, fromPmu: false, only: null, missingOnly: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--from-pmu") options.fromPmu = true;
    else if (arg === "--missing-only") options.missingOnly = true;
    else if (arg === "--tomorrow") options.date = parisIsoDate(1);
    else if (arg === "--only") {
      options.only = String(argv[index + 1] ?? "").split(",").map((key) => key.trim()).filter(Boolean);
      index += 1;
    } else if (arg === "--date") {
      const value = String(argv[index + 1] ?? "");
      index += 1;
      if (/^\d{4}-\d{2}-\d{2}$/.test(value)) options.date = value;
      else if (/^\d{8}$/.test(value)) options.date = `${value.slice(4, 8)}-${value.slice(2, 4)}-${value.slice(0, 2)}`;
      else throw new Error(`--date attend AAAA-MM-JJ ou JJMMAAAA, reçu : ${value || "(vide)"}`);
    } else {
      throw new Error(`argument inconnu : ${arg}`);
    }
  }
  return options;
}

async function loadRacesFromDb(sql, date) {
  const rows = await sql`
    select r.id, r.race_date::text as race_date, r.reunion_number, r.course_number,
           r.start_time, r.name, rc.name as racecourse
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
    name: row.name,
  }));
}

async function loadRacesFromPmu(http, date) {
  const url = `https://${PMU_PRESSE_HOST}/rest/client/61/programme/${pmuDate(date)}`;
  const response = await http.get(url, { accept: "application/json" });
  if (response.status !== 200) throw new Error(`programme PMU indisponible (HTTP ${response.status}) : ${url}`);
  return racesFromPmuProgramme(JSON.parse(response.text), date);
}

/** Couples (course, source) déjà enregistrés pour la date, sous forme de clés. */
async function loadExistingKeys(sql, date) {
  const rows = await sql`
    select p.race_id, p.source
      from press_selections p
      join races r on r.id = p.race_id
     where r.race_date = ${date}
  `;
  return new Set(rows.map((row) => selectionKey(row.race_id, row.source)));
}

async function writeSelections(sql, source, selections) {
  if (selections.length === 0) return 0;
  // Une transaction HTTP par source : tout ou rien, et ré-exécutable (upsert).
  await sql.transaction(
    selections.map(
      (selection) => sql`
        insert into press_selections (race_id, source, ranks, url, fetched_at)
        values (${selection.raceId}, ${source}, ${selection.ranks}, ${selection.url ?? null}, now())
        on conflict (race_id, source) do update
          set ranks = excluded.ranks, url = excluded.url, fetched_at = excluded.fetched_at
      `,
    ),
  );
  return selections.length;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await loadLocalEnv();

  const http = createPoliteHttp({
    // Une requête par course sur l'API PMU : plafond relevé pour cet hôte seulement.
    hostLimits: { [PMU_PRESSE_HOST]: 160 },
    log: (message) => console.log(message),
  });

  const hasDb = Boolean(process.env.DATABASE_URL);
  if (!options.dryRun && !hasDb) {
    console.warn("[presse] DATABASE_URL absent : passage en --dry-run");
    options.dryRun = true;
  }
  const sql = hasDb ? neon(process.env.DATABASE_URL) : null;

  let allRaces;
  try {
    allRaces = options.fromPmu || !sql ? await loadRacesFromPmu(http, options.date) : await loadRacesFromDb(sql, options.date);
  } catch (error) {
    console.error(`[presse] impossible de charger les courses du ${options.date} :`, error instanceof Error ? error.message : error);
    process.exitCode = 1;
    return;
  }

  const upcoming = allRaces.filter((race) => isUpcoming(race));
  console.log(
    `[presse] ${options.date} : ${allRaces.length} courses (${options.fromPmu || !sql ? "API PMU" : "base"}), ${upcoming.length} pas encore parties${options.dryRun ? " — DRY RUN" : ""}`,
  );
  if (upcoming.length === 0) return;

  const sources = options.only ? PRESS_SOURCES.filter((collector) => options.only.includes(collector.SOURCE.key)) : PRESS_SOURCES;
  const summary = [];
  const byId = new Map(upcoming.map((race) => [race.id, race]));

  let existing = new Set();
  if (options.missingOnly && sql) {
    try {
      existing = await loadExistingKeys(sql, options.date);
    } catch (error) {
      // Lecture impossible : passe complète plutôt qu'aucune passe.
      console.warn("[presse] sélections existantes illisibles, passe complète :", error instanceof Error ? error.message : error);
    }
  }

  for (const collector of sources) {
    const { key, label } = collector.SOURCE;
    const wanted = options.missingOnly ? racesMissingSource(upcoming, existing, key) : upcoming;
    if (wanted.length === 0) {
      summary.push({ source: key, statut: "complet", courses: 0, ecrites: 0, detail: "toutes les courses à venir sont déjà relevées" });
      console.log(`[presse] ${label} : complet — aucune requête envoyée`);
      continue;
    }
    let result;
    try {
      result = await collector.collect({ date: options.date, races: wanted, http });
    } catch (error) {
      result = { status: "error", selections: [], detail: error instanceof Error ? error.message : String(error) };
    }

    // Seconde vérification au moment d'écrire : la collecte prend plusieurs minutes,
    // une course a pu partir entre-temps. Aucune sélection d'après-départ n'est stockée.
    const fresh = (result.selections ?? []).filter((selection) => {
      const race = byId.get(selection.raceId);
      return race && isUpcoming(race);
    });

    let written = 0;
    if (options.dryRun) {
      for (const selection of fresh) console.log(`  ${key.padEnd(11)} ${selection.raceId.padEnd(18)} ${selection.ranks.join("-")}  ${selection.url ?? ""}`);
    } else if (fresh.length > 0) {
      try {
        written = await writeSelections(sql, key, fresh);
      } catch (error) {
        result = { ...result, status: "error", detail: `écriture : ${error instanceof Error ? error.message : error}` };
      }
    }

    summary.push({ source: key, statut: result.status, courses: fresh.length, ecrites: written, detail: result.detail ?? "" });
    console.log(`[presse] ${label} : ${result.status} — ${fresh.length} courses rapprochées${result.detail ? ` (${result.detail})` : ""}`);
  }

  console.table(summary);
  console.log("[presse] requêtes par hôte :", http.stats());
}

main().catch((error) => {
  // Erreur d'arguments ou imprévue : signalée, mais le job PMU a continue-on-error.
  console.error("[presse] échec :", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
