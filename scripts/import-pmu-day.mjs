import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { neon } from "@neondatabase/serverless";
import { storePayouts } from "./lib/payouts.mjs";
import { getOddsWithSource } from "./lib/pmu-fetch.mjs";
import {
  arrivalPlacings,
  blinkersFromParticipant,
  entryUpsertParams,
  entryUpsertSql,
  hasRaceStarted,
  parseMusicSignal,
  preRaceConnectionStats,
  prizeFromCourse,
  startTypeFromCourse,
  realizedKm,
} from "./lib/pmu-integrity.mjs";

const PMU_BASE = "https://offline.turfinfo.api.pmu.fr/rest/client/7/programme";
const USER_AGENT = "KayzenTurfAI/0.1 contact:github.com/skyymar69-rgb/kayzen-turf-ai";

async function loadLocalEnv() {
  try {
    const content = await readFile(resolve(process.cwd(), ".env.local"), "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const separator = trimmed.indexOf("=");
      if (separator === -1) continue;
      const key = trimmed.slice(0, separator);
      const value = trimmed.slice(separator + 1).replace(/^"|"$/g, "");
      process.env[key] ||= value;
    }
  } catch {
    // Vercel/CI can provide DATABASE_URL directly.
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  const dates = [];
  let maxRaces = Number.POSITIVE_INFINITY;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--date") {
      const value = args[index + 1];
      // Une date mal formée partait telle quelle dans l'URL PMU : 404 en boucle,
      // quatre tentatives, puis un échec incompréhensible. On refuse à l'entrée.
      if (!/^\d{8}$/.test(String(value ?? ""))) {
        throw new Error(`--date attend une date PMU au format JJMMAAAA, reçu : ${value ?? "(vide)"}`);
      }
      dates.push(value);
    }
    if (arg === "--max-races") {
      const value = Number(args[index + 1]);
      if (!Number.isFinite(value)) {
        throw new Error(`--max-races attend un nombre, reçu : ${args[index + 1] ?? "(vide)"}`);
      }
      maxRaces = value;
    }
  }

  return {
    dates: dates.length > 0 ? dates : defaultDates(),
    maxRaces,
  };
}

function defaultDates() {
  return [-1, 0, 1].map(formatParisPmuDateOffset);
}

function formatParisPmuDateOffset(offset) {
  const parisDate = new Intl.DateTimeFormat("fr-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Europe/Paris",
    year: "numeric",
  }).format(new Date());
  const [year, month, day] = parisDate.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + offset, 12));

  return `${String(date.getUTCDate()).padStart(2, "0")}${String(date.getUTCMonth() + 1).padStart(2, "0")}${date.getUTCFullYear()}`;
}

function isoDateFromPmu(pmuDate) {
  return `${pmuDate.slice(4, 8)}-${pmuDate.slice(2, 4)}-${pmuDate.slice(0, 2)}`;
}

function relativeDayFromPmu(pmuDate) {
  if (pmuDate === formatParisPmuDateOffset(0)) return "today";
  if (pmuDate === formatParisPmuDateOffset(-1)) return "yesterday";
  if (pmuDate === formatParisPmuDateOffset(1)) return "tomorrow";
  return null;
}

// L'API PMU coupe régulièrement la connexion (ECONNRESET) : sans reprise, un seul
// incident réseau tuait l'import complet de la journée.
const FETCH_ATTEMPTS = 4;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

async function fetchJson(url) {
  let lastError;

  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
    try {
      // Sans délai maximal, une connexion que l'API PMU laisse pendre bloquait
      // le job jusqu'à sa limite de 45 min. Le TimeoutError est traité comme
      // une coupure réseau : il repasse par les tentatives ci-dessous.
      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": USER_AGENT,
        },
        signal: AbortSignal.timeout(20_000),
      });

      if (response.ok) return await response.json();

      const httpError = new Error(`PMU request failed ${response.status} for ${url}`);
      if (!RETRYABLE_STATUS.has(response.status)) {
        httpError.permanent = true;
        throw httpError;
      }
      lastError = httpError;
    } catch (error) {
      if (error?.permanent) throw error;
      lastError = error;
    }

    if (attempt < FETCH_ATTEMPTS) {
      console.warn(`[pmu] tentative ${attempt}/${FETCH_ATTEMPTS} échouée sur ${url} — nouvel essai`);
      await delay(attempt * 2000);
    }
  }

  throw lastError;
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function disciplineFromPmu(value) {
  if (String(value).includes("TROT")) return "Trot";
  if (String(value).includes("OBSTACLE")) return "Obstacle";
  if (String(value).includes("MONTE") || String(value).includes("ATTELE")) return "Trot";
  if (String(value).includes("HAIE") || String(value).includes("STEEPLE") || String(value).includes("CROSS")) return "Obstacle";
  return "Plat";
}

function specialtyFromPmu(course) {
  const value = String(course?.specialite ?? course?.discipline ?? "");
  if (value.includes("MONTE")) return "Monte";
  if (value.includes("ATTELE")) return "Attele";
  if (value.includes("HAIE")) return "Haies";
  if (value.includes("STEEPLE")) return "Steeple";
  if (value.includes("CROSS")) return "Cross";
  if (value.includes("OBSTACLE")) return "Obstacle";
  return "Plat";
}

function riskFromVolatility(volatility) {
  if (volatility >= 24) return "Speculatif";
  if (volatility >= 15) return "Equilibre";
  return "Prudent";
}

function bettingTier(score) {
  if (score >= 70) return "Focus";
  if (score >= 50) return "Value";
  return "Avoid";
}

function buildPrediction(participant, fieldSize) {
  // Origine de la cote conservée (voir `getOddsWithSource`) : direct,
  // référence ou probable n'ont pas la même valeur de marché.
  const { odds, source: oddsSource } = getOddsWithSource(participant);
  const marketProbability = odds > 1 ? 1 / odds : 1 / Math.max(fieldSize, 1);
  const careerRuns = Number(participant.nombreCourses ?? 0);
  const wins = Number(participant.nombreVictoires ?? 0);
  const places = Number(participant.nombrePlaces ?? 0);
  const careerWinRate = careerRuns > 0 ? wins / careerRuns : 1 / Math.max(fieldSize, 1);
  const careerPlaceRate = careerRuns > 0 ? places / careerRuns : Math.min(0.45, 3 / Math.max(fieldSize, 1));
  const formSignal = parseMusicSignal(participant.musique);

  const adjustedProbability =
    marketProbability * 0.72 +
    careerWinRate * 0.13 +
    formSignal * 0.1 +
    1 / Math.max(fieldSize, 1) * 0.05;
  const winProbability = clamp(adjustedProbability * 100, 2, 45);
  const top3Probability = clamp((winProbability / 100 + careerPlaceRate * 0.35 + 2 / Math.max(fieldSize, 1)) * 100, winProbability, 85);
  const top5Probability = clamp(top3Probability + 16 + Math.max(0, 18 - fieldSize), top3Probability, 96);
  const fairOdds = Number((100 / winProbability).toFixed(2));
  const rawMarketEdge = odds > 1 ? odds * (winProbability / 100) * 100 - 100 : 0;
  const marketEdge = Number(clamp(rawMarketEdge, -40, 95).toFixed(1));
  const favoriteFragility = favoriteFailureRisk({ fieldSize, formSignal, marketEdge, odds, top3Probability, winProbability });
  const longshotSignal = watchedLongshotSignal({ careerPlaceRate, fieldSize, formSignal, marketEdge, odds, top3Probability, top5Probability, winProbability });
  const kzScore = clamp(
    Math.round(
      winProbability * 1.22 +
        top3Probability * 0.42 +
        top5Probability * 0.12 +
        Math.max(0, marketEdge) * 0.18 +
        formSignal * 16 +
        longshotSignal * 0.2 -
        favoriteFragility * 0.28,
    ),
    1,
    99,
  );

  return {
    // Sans rapport PMU, la cote est ABSENTE — pas remplacée par la cote juste
    // du modèle. Stocker `fairOdds` à sa place faisait afficher « cote 8,82 »
    // pour une course dont le marché n'avait encore rien publié, et `devig`
    // comparait ensuite le modèle à lui-même : tous les partants ressortaient
    // à la même probabilité (Quinté du 04/09/2026, quinze chevaux à 7-8 %).
    odds: odds > 1 ? odds : null,
    oddsSource: odds > 1 ? oddsSource : null,
    fairOdds,
    marketEdge,
    winProbability: Number(winProbability.toFixed(1)),
    top3Probability: Number(top3Probability.toFixed(1)),
    top5Probability: Number(top5Probability.toFixed(1)),
    kzScore,
    valueIndex: marketEdge,
    confidence: careerRuns >= 12 && odds > 1 ? "Forte" : careerRuns >= 5 ? "Moyenne" : "Faible",
    factors: [
      odds > 1 ? `Cote PMU observee: ${odds}` : "Cote absente, estimation prudente",
      careerRuns > 0 ? `Historique: ${wins}/${careerRuns} victoires` : "Historique limite",
      participant.musique ? `Musique: ${participant.musique}` : "Forme recente non renseignee",
      favoriteFragility >= 18 ? `Favori fragile: risque ${favoriteFragility}/60` : null,
      longshotSignal >= 18 ? `Tocard surveille: signal Top 3 ${longshotSignal}/60` : null,
    ].filter(Boolean),
  };
}

function favoriteFailureRisk({ fieldSize, formSignal, marketEdge, odds, top3Probability, winProbability }) {
  return clamp(
    (odds > 1 && odds <= 4 ? 16 : 0) +
      (top3Probability < 34 ? 12 : 0) +
      (winProbability < 14 ? 8 : 0) +
      (marketEdge < -8 ? 12 : 0) +
      Math.max(0, fieldSize - 10) * 1.3 -
      formSignal * 18,
    0,
    60,
  );
}

function watchedLongshotSignal({ careerPlaceRate, fieldSize, formSignal, marketEdge, odds, top3Probability, top5Probability, winProbability }) {
  return clamp(
    (odds >= 6 && odds <= 22 ? 14 : 0) +
      Math.max(0, marketEdge) * 0.22 +
      Math.max(0, top3Probability - winProbability * 1.9) * 0.3 +
      Math.max(0, top5Probability - top3Probability) * 0.12 +
      careerPlaceRate * 16 +
      formSignal * 12 +
      Math.max(0, fieldSize - 12) * 0.45 -
      Math.max(0, odds - 30) * 0.55,
    0,
    60,
  );
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

// Le nom de table est interpolé dans la requête : on n'accepte que les deux
// tables prévues, quoi qu'en dise l'appelant.
const NAME_TABLES = new Set(["jockeys", "trainers"]);

// Cache par exécution : un même jockey ou entraîneur revient sur des dizaines
// de partants dans la journée, inutile de le réécrire à chaque fois.
const nameIdCache = new Map();

async function upsertName(sql, table, name) {
  if (!NAME_TABLES.has(table)) throw new Error(`upsertName : table non autorisée « ${table} »`);
  const safeName = name || "Non renseigne";
  const cacheKey = `${table} ${safeName}`;
  const cached = nameIdCache.get(cacheKey);
  if (cached) return cached;

  const rows = await sql.query(
    `insert into ${table} (name) values ($1) on conflict (name) do update set name = excluded.name returning id`,
    [safeName],
  );
  nameIdCache.set(cacheKey, rows[0].id);
  return rows[0].id;
}

// Identifiant de cheval. À défaut d'identifiant PMU et de nom, l'ancien repli
// `crypto.randomUUID()` créait un cheval neuf à chaque import — trois fois par
// jour — sans jamais pouvoir le rattacher à son partant ni à son arrivée. Le
// repli est désormais déterministe : course + numéro de partant.
function horseId(participant, raceId) {
  return String(participant.idCheval || participant.nom || `${raceId}-p${participant.numPmu}`)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 120);
}


function normalizeBetTypes(paris = []) {
  const unique = new Map();

  for (const pari of paris) {
    const rawType = String(pari?.codePari ?? pari?.typePari ?? "");
    if (!rawType || rawType === "REPORT_PLUS" || rawType === "E_REPORT_PLUS") continue;

    const type = rawType.replace(/^E_/, "");
    const existing = unique.get(type);
    const offer = {
      type,
      label: labelBetType(type),
      audience: pari.audience ?? null,
      baseStake: Number(pari.miseBase ?? 0) / 100,
      ordered: Boolean(pari.ordre),
      combined: Boolean(pari.combine),
      requiredHorses: Number(pari.nbChevauxReglementaire ?? 0),
      flexi: pari.valeursFlexiAutorisees ?? [],
      riskOptions: pari.valeursRisqueAutorisees ?? [],
      online: rawType.startsWith("E_"),
      spotAllowed: Boolean(pari.spotAutorise),
    };

    if (!existing || offer.online) unique.set(type, offer);
  }

  return Array.from(unique.values()).sort((a, b) => betTypeRank(a.type) - betTypeRank(b.type));
}

function labelBetType(type) {
  return type
    .replaceAll("_", " ")
    .toLowerCase()
    .replace(/(^|\s)\S/g, (letter) => letter.toUpperCase());
}

function betTypeRank(type) {
  const order = [
    "SIMPLE_GAGNANT",
    "SIMPLE_PLACE",
    "COUPLE_GAGNANT",
    "COUPLE_PLACE",
    "COUPLE_ORDRE",
    "DEUX_SUR_QUATRE",
    "TRIO",
    "TRIO_ORDRE",
    "MULTI",
    "SUPER_QUATRE",
    "QUARTE_PLUS",
    "QUINTE_PLUS",
  ];
  const index = order.indexOf(type);
  return index === -1 ? 999 : index;
}

/**
 * Photographie de `connection_stats` au début de l'import, indexée par
 * « kind person_id ». Elle est copiée sur chaque partant d'une course pas
 * encore partie (`entries.*_pre`) : c'est l'état connu avant la course, celui
 * que le modèle doit lire — y compris des mois plus tard, quand
 * `connection_stats` aura intégré les résultats suivants. Une seule requête
 * par exécution : quelques milliers de lignes.
 */
async function loadConnectionStats(sql) {
  try {
    const rows = await sql`select kind, person_id::text as person_id, runs, wins from connection_stats`;
    return new Map(rows.map((row) => [`${row.kind} ${row.person_id}`, { runs: Number(row.runs), wins: Number(row.wins) }]));
  } catch (error) {
    // Table absente (base neuve) : pas de statistiques figées, pas d'échec.
    console.warn(`[pmu] connection_stats illisible (${error.message}) — statistiques d'avant-course non figées`);
    return new Map();
  }
}

/** Courses non importées pendant ce passage, toutes dates confondues. */
const importFailures = [];

async function importDate(sql, pmuDate, maxRaces, connectionStats) {
  // Le périmètre est le programme des points de vente PMU (pmu.fr/point-de-vente),
  // tel que l'API le sert : réunions étrangères comprises, réunions réservées à
  // internet ou à l'hippodrome exclues. Aucun filtre maison par-dessus.
  const programmeUrl = `${PMU_BASE}/${pmuDate}?specialisation=OFFLINE`;
  const payload = await fetchJson(programmeUrl);
  const reunions = payload?.programme?.reunions ?? [];
  const isoDate = isoDateFromPmu(pmuDate);
  const relativeDay = relativeDayFromPmu(pmuDate);
  // Les tables `prediction_runs`, `predictions` et `value_bets` ne sont lues par
  // aucune requête de l'application : 89 Mo écrits trois fois par jour pour rien,
  // sur une base qui a déjà saturé son plafond une fois. L'historique horodaté
  // dont on a réellement besoin pour rejouer un pronostic passé, c'est
  // `odds_snapshots` — la page dérivant tout des cotes, un relevé de cote daté
  // suffit à reconstituer ce qui était affiché. Les lignes déjà écrites sont
  // conservées, seules les écritures cessent.
  let importedRaces = 0;

  for (const reunion of reunions) {

    const racecourseName = reunion?.hippodrome?.libelleCourt ?? reunion?.hippodrome?.libelleLong ?? `R${reunion.numOfficiel}`;
    const racecourseRows = await sql`
      insert into racecourses (name, country, surface)
      values (${racecourseName}, ${reunion?.pays?.code ?? "N/A"}, ${reunion?.disciplinesMere ?? null})
      on conflict (name) do update set country = excluded.country
      returning id
    `;
    const racecourseId = racecourseRows[0].id;
    const courses = reunion.courses ?? [];

    for (const course of courses) {
      if (importedRaces >= maxRaces) return importedRaces;
      if (!course?.numOrdre) continue;

      const raceId = `${isoDate}-R${reunion.numOfficiel}-C${course.numOrdre}`;
      // Une course en erreur (réponse PMU refusée, valeur rejetée par la base)
      // ne bloque plus les suivantes ni les autres jours : l'import entier
      // s'arrêtait sur un seul enregistrement défectueux (audit du 08/11/2026).
      try {
        const startDate = new Date(course.heureDepart);
        if (Number.isNaN(startDate.getTime())) {
          // `toLocaleTimeString` sur une date invalide renvoie « Invalid Date »,
          // qui finissait tel quel dans `races.start_time` et cassait le tri du
          // programme. Une course sans heure de départ n'est pas importable.
          console.warn(`[pmu] ${raceId} ignorée : heure de départ invalide (${course.heureDepart ?? "absente"})`);
          continue;
        }
        const startTime = startDate.toLocaleTimeString("fr-FR", {
          hour: "2-digit",
          minute: "2-digit",
          timeZone: "Europe/Paris",
        });
        const fieldSize = Number(course.nombreDeclaresPartants ?? 0);
        const volatility = fieldSize >= 16 ? 24 : fieldSize >= 12 ? 18 : 11;
        const qualityScore = clamp(82 - Math.abs(fieldSize - 12) * 2 + (course.montantPrix ?? 0) / 10000, 35, 92);
        const betTypes = normalizeBetTypes(course.paris);
        // Course partie (arrivée publiée ou heure passée) : plus rien d'avant-course
        // n'est réécrit — ni partants, ni cotes, ni terrain (voir pmu-integrity.mjs).
        const raceStarted = hasRaceStarted(course);
        const startType = startTypeFromCourse(course);
        const prize = prizeFromCourse(course);
        const weather = reunion?.meteo
          ? `${reunion.meteo.nebulositeLibelleCourt ?? "Meteo inconnue"}, ${reunion.meteo.temperature ?? "?"}C, vent ${reunion.meteo.forceVent ?? "?"}km/h`
          : "Meteo non renseignee";

        await sql`
          insert into races (
            id, race_date, relative_day, reunion_number, course_number, source_country,
            name, racecourse_id, start_time, discipline, specialty,
            distance, going, weather, market_volatility, model_consensus, race_quality_score,
            betting_tier, risk_level, bet_types, data_cutoff_at, start_type, prize
          )
          values (
            ${raceId}, ${isoDate}, ${relativeDay}, ${Number(reunion.numOfficiel)}, ${Number(course.numOrdre)},
            ${reunion?.pays?.code ?? null}, ${course.libelle ?? `Course ${course.numOrdre}`},
            ${racecourseId}, ${startTime}, ${disciplineFromPmu(course.specialite ?? course.discipline)}, ${specialtyFromPmu(course)},
            ${String(course.distance ?? course.parcours ?? "")}, ${course?.penetrometre?.intitule ?? course.typePiste ?? null},
            ${weather}, ${volatility}, ${68}, ${qualityScore}, ${bettingTier(qualityScore)},
            ${riskFromVolatility(volatility)}, ${JSON.stringify(betTypes)}, now(), ${startType}, ${prize}
          )
          on conflict (id) do update set
            race_date = excluded.race_date,
            relative_day = excluded.relative_day,
            reunion_number = excluded.reunion_number,
            course_number = excluded.course_number,
            source_country = excluded.source_country,
            name = excluded.name,
            racecourse_id = excluded.racecourse_id,
            start_time = excluded.start_time,
            discipline = excluded.discipline,
            specialty = excluded.specialty,
            distance = excluded.distance,
            -- Terrain annoncé avant le départ : figé une fois la course partie
            -- (la boucle live le relit jusqu'au départ, voir refresh-race.ts).
            going = case when ${raceStarted}::boolean then coalesce(races.going, excluded.going) else excluded.going end,
            weather = excluded.weather,
            market_volatility = excluded.market_volatility,
            model_consensus = excluded.model_consensus,
            race_quality_score = excluded.race_quality_score,
            betting_tier = excluded.betting_tier,
            risk_level = excluded.risk_level,
            bet_types = excluded.bet_types,
            data_cutoff_at = excluded.data_cutoff_at,
            start_type = coalesce(excluded.start_type, races.start_type),
            prize = coalesce(excluded.prize, races.prize),
            updated_at = now()
        `;

        const participantsPayload = await fetchJson(`${PMU_BASE}/${pmuDate}/R${reunion.numOfficiel}/C${course.numOrdre}/participants`);
        const participants = participantsPayload?.participants ?? [];

        // Après l'arrivée, l'API renvoie dans `reductionKilometrique` le chrono
        // réalisé pendant la course, et non plus le record du cheval. Écraser la
        // valeur d'avant-course reviendrait à stocker le résultat sous couvert de
        // pronostic : `speed_figure` et `reduction_km` ne sont donc plus écrites
        // dès que la course est partie (`raceStarted`, plus strict que l'arrivée).
        // Chevaux effectivement écrits pour cette course : l'arrivée ne peut
        // référencer qu'eux (clé étrangère results.horse_id -> horses.id).
        const insertedHorseIds = new Set();

        for (const participant of participants) {
          if (participant.statut && participant.statut !== "PARTANT") continue;

          const id = horseId(participant, raceId);
          const jockeyId = await upsertName(sql, "jockeys", participant.driver);
          const trainerId = await upsertName(sql, "trainers", participant.entraineur);
          const prediction = buildPrediction(participant, participants.length || fieldSize || 12);
          const entryId = `${raceId}-P${participant.numPmu}`;
          // Même garde-fou que refresh-odds.mjs : hors de cette plage, la valeur
          // n'est pas une réduction kilométrique (champ vide, 0, ou unité inattendue).
          const rawFigure = Number(participant.reductionKilometrique);
          const speedFigure =
            !raceStarted && Number.isFinite(rawFigure) && rawFigure > 40000 && rawFigure < 200000 ? rawFigure : null;

          await sql`
            insert into horses (id, name, age)
            values (${id}, ${participant.nom ?? id}, ${participant.age ?? null})
            on conflict (id) do update set name = excluded.name, age = excluded.age
          `;
          insertedHorseIds.add(id);

          const preStats = preRaceConnectionStats(connectionStats, jockeyId, trainerId, raceStarted);
          const blinkers = blinkersFromParticipant(participant);

          // Requête générée par `entryUpsertSql` : course pas encore partie, tout
          // est rafraîchi ; course partie (import J-1, backfill-history.mjs), les
          // valeurs d'avant-course déjà en base sont gelées et seules les colonnes
          // vides sont complétées. Voir scripts/lib/pmu-integrity.mjs.
          await sql.query(
            entryUpsertSql(raceStarted),
            entryUpsertParams({
              id: entryId,
              race_id: raceId,
              horse_id: id,
              number: participant.numPmu,
              age: participant.age ?? null,
              sex: participant.sexe ?? null,
              music: participant.musique ?? null,
              earnings: Number(participant?.gainsParticipant?.gainsCarriere ?? 0) / 100,
              handicap_distance: participant.handicapDistance ?? null,
              // Chrono réalisé une fois la course partie : jamais écrit après le départ.
              reduction_km: raceStarted ? null : (participant.reductionKilometrique ?? participant.record ?? null),
              // `equipment` = œillères seules (plus de repli sur le déferrage).
              equipment: blinkers,
              blinkers,
              silks_url: participant.urlCasaque ?? null,
              weight: participant.handicapPoids ?? null,
              draw: participant.placeCorde ?? null,
              shoeing: participant.deferre ?? null,
              speed_figure: speedFigure,
              jockey_id: jockeyId,
              trainer_id: trainerId,
              odds: prediction.odds,
              odds_source: prediction.oddsSource,
              fair_odds: prediction.fairOdds,
              market_edge: prediction.marketEdge,
              win_probability: prediction.winProbability,
              top3_probability: prediction.top3Probability,
              top5_probability: prediction.top5Probability,
              kz_score: prediction.kzScore,
              value_index: prediction.valueIndex,
              confidence: prediction.confidence,
              factors: JSON.stringify(prediction.factors),
              jockey_runs_pre: preStats.jockeyRunsPre,
              jockey_wins_pre: preStats.jockeyWinsPre,
              trainer_runs_pre: preStats.trainerRunsPre,
              trainer_wins_pre: preStats.trainerWinsPre,
              realized_km: realizedKm(participant, course.ordreArrivee),
            }),
          );

          // Un relevé n'est enregistré que si la cote a bougé depuis le dernier.
          // Le cron passe 2 fois par jour sur une fenêtre de 3 jours, soit ~6
          // relevés par partant : sans ce filtre, la moitié de la table était de
          // la cote réenregistrée à l'identique, sans aucune information de
          // marché — et c'est ce qui a saturé le plafond de 512 Mo du projet Neon.
          //
          // Course partie : pas de relevé. La cote lue après le départ est la cote
          // finale, horodatée `now()` — des heures après la course — elle
          // fausserait toute reconstitution de ce qui était affiché avant.
          if (prediction.odds > 1 && !raceStarted) {
            await sql`
              insert into odds_snapshots (race_id, horse_id, odds, source, odds_source, observed_at)
              select ${raceId}::text, ${id}::text, ${prediction.odds}::numeric, ${"PMU"}::text, ${prediction.oddsSource}::text, now()
              where ${prediction.odds}::numeric is distinct from (
                select previous.odds
                from odds_snapshots previous
                where previous.race_id = ${raceId}
                  and previous.horse_id = ${id}
                  and previous.source = ${"PMU"}
                order by previous.observed_at desc
                limit 1
              )
            `;
          }

        }

        // Arrivée : le PMU publie d'abord une arrivée provisoire (podium + 4e pour
        // les rapports Quarté), puis l'arrivée définitive complète. Sans le
        // remplacement ci-dessous, la première version partielle restait figée en
        // base — d'où des courses à 4 places alors que l'API en renvoyait 10, et
        // un Top 5 mécaniquement plafonné qui se lisait comme un échec du modèle.
        //
        // Ex aequo : `ordreArrivee` est une liste de groupes ([[2], [11, 16], …]),
        // chaque cheval reçoit la place de son groupe (`arrivalPlacings`).
        const arrival = arrivalPlacings(course.ordreArrivee);
        if (arrival.length > 0) {
          // Remplacement intégral plutôt qu'un upsert ligne à ligne : une arrivée
          // peut être rectifiée (disqualification), et un upsert laisserait les
          // anciennes positions orphelines.
          //
          // Le tout part dans une seule transaction HTTP (`sql.transaction`, même
          // instance `neon()`) : auparavant, un incident entre le DELETE et les
          // INSERT laissait une course arrivée sans aucun résultat jusqu'au
          // passage suivant — et le site l'affichait comme non courue.
          const statements = [sql`delete from results where race_id = ${raceId}`];
          let matched = 0;

          for (const { number, position, won } of arrival) {
            const participant = participants.find((item) => Number(item.numPmu) === number);
            if (!participant) continue;
            const id = horseId(participant, raceId);
            if (!insertedHorseIds.has(id)) {
              // Un cheval de l'arrivée qui n'a pas été écrit comme partant (statut
              // autre que PARTANT dans la réponse) violerait la clé étrangère et
              // ferait échouer toute la transaction.
              console.warn(`[pmu] ${raceId}: n° ${number} présent à l'arrivée mais absent des partants — résultat ignoré`);
              continue;
            }
            statements.push(sql`
              insert into results (race_id, horse_id, finish_position, won)
              values (${raceId}, ${id}, ${position}, ${won})
              on conflict (race_id, horse_id) do update set
                finish_position = excluded.finish_position,
                won = excluded.won
            `);
            matched += 1;
          }

          // Le remplacement n'efface jamais sans réécrire (audit du 08/11/2026) :
          // une réponse /participants vide ou incomplète passait la transaction
          // avec le seul DELETE, et la course perdait son arrivée sans que le
          // passage suivant ne revienne dessus. Une arrivée plus courte que celle
          // en base n'est acceptée que définitive (disqualification).
          const [{ stored }] = await sql`select count(*)::int as stored from results where race_id = ${raceId}`;
          const definitive = !course.statut || course.statut === "ARRIVEE_DEFINITIVE_COMPLETE";
          if (matched < arrival.length) {
            console.warn(`[pmu] ${raceId}: ${matched}/${arrival.length} chevaux de l'arrivée retrouvés parmi les partants — arrivée en base conservée`);
          } else if (matched < stored && !definitive) {
            console.warn(`[pmu] ${raceId}: arrivée provisoire de ${matched} places, ${stored} en base — arrivée en base conservée`);
          } else {
            await sql.transaction(statements);
          }

          if (course.statut && course.statut !== "ARRIVEE_DEFINITIVE_COMPLETE") {
            console.log(`[pmu] ${raceId}: arrivée ${arrival.length} places, statut ${course.statut} — sera complétée au prochain passage`);
          } else {
            // Rapports officiels, une seule fois par course : ils ne bougent plus
            // après l'arrivée définitive. Un échec ici ne doit pas coûter l'import.
            const [{ known }] = await sql`select count(*)::int as known from race_payouts where race_id = ${raceId}`;
            if (known === 0) {
              try {
                const rapports = await fetchJson(`${PMU_BASE}/${pmuDate}/R${reunion.numOfficiel}/C${course.numOrdre}/rapports-definitifs`);
                await storePayouts(sql, raceId, rapports);
              } catch (error) {
                console.warn(`[pmu] ${raceId}: rapports officiels indisponibles (${error.message})`);
              }
            }
          }
        }

      } catch (error) {
        importFailures.push(raceId);
        console.error(`::warning::[pmu] ${raceId} non importée : ${error?.message ?? error}`);
        continue;
      }
      importedRaces += 1;
      await delay(300);
    }
  }


  return importedRaces;
}

async function main() {
  await loadLocalEnv();
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

  const { dates, maxRaces } = parseArgs();
  const sql = neon(process.env.DATABASE_URL);
  const connectionStats = await loadConnectionStats(sql);
  let total = 0;

  for (const date of dates) {
    console.log(`[pmu] importing ${date}`);
    total += await importDate(sql, date, maxRaces - total, connectionStats);
    if (total >= maxRaces) break;
  }

  const [{ size }] = await sql`
    select pg_size_pretty(pg_database_size(current_database())) as size
  `;

  console.log(`[pmu] imported ${total} races — database size ${size}`);
  if (importFailures.length > 0) {
    console.error(`::warning::[pmu] ${importFailures.length} course(s) non importée(s) : ${importFailures.join(", ")}`);
    // Rien d'importé du tout : la panne est générale, le job doit échouer.
    if (total === 0) process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
