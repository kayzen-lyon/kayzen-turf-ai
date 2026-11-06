/**
 * INTÉGRITÉ DES DONNÉES D'AVANT-COURSE — fonctions pures de l'import PMU.
 *
 * Règle commune : ce que le modèle lit pour une course doit être ce qu'on
 * savait AVANT son départ. L'import repasse sur les courses de la veille
 * (fenêtre J-1/J/J+1) et `backfill-history.mjs` sur des mois entiers : sans
 * garde-fou, chaque passage réécrivait la musique, les gains, les cotes et les
 * probabilités avec les valeurs publiées APRÈS l'arrivée. Le suivi de
 * performance mesurait alors un modèle qui connaissait le résultat.
 *
 * Tout ce qui décide de ce qui est écrit vit ici, sans accès réseau ni base,
 * pour être testé (tests/pmu-integrity.test.mjs).
 */

// ─────────────────────────────────────────────────────────────────────────────
// Musique
// ─────────────────────────────────────────────────────────────────────────────

/** Lettres qui suivent un résultat pour indiquer la discipline (a, m, p, h, s, c…). */
const MUSIC_DISCIPLINE_LETTER = /[a-z]/i;

/**
 * Découpe une musique PMU en courses, de la plus récente à la plus ancienne.
 *
 * Portage fidèle de `tokenizeMusic` (src/lib/prediction-math.ts) : l'import
 * en tournait une version caractère par caractère qui comptait « (25) » comme
 * une 2e puis une 5e place et ignorait les « 0 » (non placé). Le site et
 * l'import lisaient donc deux formes différentes pour la même musique. Le
 * test croisé de tests/pmu-integrity.test.mjs vérifie que les deux
 * implémentations restent identiques.
 *
 * Résultat : `{ kind: "pos", value }` (1 à 9, 10 pour « 0 ») ou
 * `{ kind: "inc", code }` (D disqualifié, A arrêté, T tombé, R retiré…).
 */
export function tokenizeMusic(music, maxRaces = 10) {
  const raw = String(music ?? "").replace(/\s/g, "");
  const tokens = [];
  let i = 0;

  while (i < raw.length && tokens.length < maxRaces) {
    const c = raw[i];

    if (c === "(") {
      const close = raw.indexOf(")", i);
      i = close === -1 ? raw.length : close + 1;
      continue;
    }

    if (/\d/.test(c)) {
      const next = raw[i + 1];
      // Deux chiffres consécutifs : un marqueur d'année sans parenthèses.
      if (next !== undefined && /\d/.test(next)) {
        i += 2;
        continue;
      }
      tokens.push({ kind: "pos", value: c === "0" ? 10 : Number(c) });
      i += 1;
    } else if (/[A-Za-z]/.test(c)) {
      // « Ret » (retiré) occupe trois lettres.
      if (raw.slice(i, i + 3).toLowerCase() === "ret") {
        tokens.push({ kind: "inc", code: "R" });
        i += 3;
        continue;
      }
      tokens.push({ kind: "inc", code: c.toUpperCase() });
      i += 1;
    } else {
      i += 1;
      continue;
    }

    // Lettre de discipline optionnelle après un résultat.
    if (i < raw.length && MUSIC_DISCIPLINE_LETTER.test(raw[i])) i += 1;
  }

  return tokens;
}

/**
 * Signal de forme de l'import (0,02 → 0,35), sur les cinq dernières courses.
 *
 * Même échelle qu'avant, lecture corrigée : un non-placé (« 0 ») ou un
 * incident vaut 10 — la valeur la plus défavorable — au lieu de disparaître.
 * Avec l'ancienne lecture, `0a0aDa1a` ressortait avec la forme d'un cheval
 * qui ne fait que gagner.
 */
export function parseMusicSignal(music) {
  if (!music) return 0.08;
  const races = tokenizeMusic(music, 5);
  if (races.length === 0) return 0.05;
  const values = races.map((token) => (token.kind === "pos" ? token.value : 10));
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.min(Math.max((10 - average) / 20, 0.02), 0.35);
}

// ─────────────────────────────────────────────────────────────────────────────
// Course
// ─────────────────────────────────────────────────────────────────────────────

function isTrotCourse(course) {
  const value = `${course?.specialite ?? ""} ${course?.discipline ?? ""}`;
  return /TROT|ATTELE|MONTE/.test(value);
}

/**
 * Type de départ d'une course de trot : 'autostart', 'volte' ou `null`.
 *
 * Constat sur l'API (programme du 06/10/2026, client 7 et client 61) : aucun
 * champ dédié. Le texte `conditions` porte la mention pour les départs
 * derrière l'autostart (« Course E Départ à l'Autostart 35.000. - Attelé »).
 * Les autres trots — tous les montés de la journée, et les attelés à recul
 * (« Recul de 25 m. à 65.000 ») — n'ont aucune mention : ils partent à la
 * volte. Sans texte `conditions`, on ne devine pas : `null`.
 */
export function startTypeFromCourse(course) {
  if (!isTrotCourse(course)) return null;
  const conditions = String(course?.conditions ?? "");
  if (!conditions.trim()) return null;
  return /auto-?start/i.test(conditions) ? "autostart" : "volte";
}

/** Allocation de la course en euros (montantPrix), `null` si absente. */
export function prizeFromCourse(course) {
  const prize = Number(course?.montantPrix);
  return Number.isFinite(prize) && prize > 0 ? Math.round(prize) : null;
}

/**
 * Vrai dès que la course est partie : arrivée publiée, ou heure de départ
 * passée. À partir de là, plus aucune donnée d'avant-course n'est réécrite.
 */
export function hasRaceStarted(course, now = Date.now()) {
  const arrival = Array.isArray(course?.ordreArrivee) ? course.ordreArrivee.flat() : [];
  if (arrival.length > 0) return true;
  const start = Number(course?.heureDepart);
  return Number.isFinite(start) && start > 0 && start <= now;
}

/**
 * Arrivée officielle, ex aequo compris.
 *
 * `ordreArrivee` est une liste de GROUPES : `[[2], [11, 16], [4]]` signifie
 * que 11 et 16 ont terminé deuxièmes ensemble. L'ancien code aplatissait la
 * liste et numérotait à la suite : 16 devenait 3e, 4 devenait 4e au lieu de
 * 4e… et, en cas d'ex aequo pour la victoire, un seul gagnant était retenu.
 * Chaque cheval reçoit ici la place de son groupe ; le groupe suivant
 * commence après tous les chevaux déjà classés (règle PMU : 1, 2, 2, 4).
 */
export function arrivalPlacings(ordreArrivee) {
  if (!Array.isArray(ordreArrivee)) return [];
  const placings = [];
  let classified = 0;

  for (const group of ordreArrivee) {
    const numbers = (Array.isArray(group) ? group : [group]).map(Number).filter((n) => Number.isInteger(n) && n > 0);
    if (numbers.length === 0) continue;
    const position = classified + 1;
    for (const number of numbers) placings.push({ number, position, won: position === 1 });
    classified += numbers.length;
  }

  return placings;
}

// ─────────────────────────────────────────────────────────────────────────────
// Partant
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Œillères seules. L'ancien `oeilleres ?? deferre` rangeait un code de
 * déferrage dans `equipment` quand les œillères manquaient, et la variable
 * « œillères » du modèle s'allumait sur un cheval simplement déferré.
 */
export function blinkersFromParticipant(participant) {
  const value = participant?.oeilleres;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Statistiques jockey/entraîneur à figer sur le partant, ou `null` partout
 * si la course est partie (on ne connaît plus l'état d'avant-course).
 */
export function preRaceConnectionStats(statsByPerson, jockeyId, trainerId, raceStarted) {
  const empty = { jockeyRunsPre: null, jockeyWinsPre: null, trainerRunsPre: null, trainerWinsPre: null };
  if (raceStarted) return empty;
  const jockey = statsByPerson.get(`jockey ${jockeyId}`);
  const trainer = statsByPerson.get(`trainer ${trainerId}`);
  return {
    jockeyRunsPre: jockey?.runs ?? null,
    jockeyWinsPre: jockey?.wins ?? null,
    trainerRunsPre: trainer?.runs ?? null,
    trainerWinsPre: trainer?.wins ?? null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Écriture d'un partant
// ─────────────────────────────────────────────────────────────────────────────

/** Colonnes écrites, dans l'ordre des paramètres $1…$n. */
export const ENTRY_COLUMNS = [
  "id", "race_id", "horse_id", "number", "age", "sex", "music", "earnings",
  "handicap_distance", "reduction_km", "equipment", "blinkers", "silks_url",
  "weight", "draw", "shoeing", "speed_figure", "jockey_id", "trainer_id",
  "odds", "odds_source", "fair_odds", "market_edge", "win_probability",
  "top3_probability", "top5_probability", "kz_score", "value_index",
  "confidence", "factors",
  "jockey_runs_pre", "jockey_wins_pre", "trainer_runs_pre", "trainer_wins_pre",
  "realized_km",
];

/** Identité du partant : toujours à jour (un changement de driver est un fait, pas une prévision). */
const ALWAYS_UPDATED = new Set(["horse_id", "jockey_id", "trainer_id", "silks_url"]);

/**
 * Valeurs relevées une seule fois, la première fois qu'elles sont connues
 * avant la course : `coalesce(entries.x, excluded.x)` dans tous les cas.
 *   - `speed_figure` : refresh-odds la relève au plus près du départ ;
 *   - `reduction_km` : après l'arrivée, l'API y renvoie le chrono RÉALISÉ.
 *     L'import ne l'écrit plus du tout une fois la course partie (valeur
 *     `null`), et ne remplace jamais une valeur existante.
 */
const FIRST_VALUE_WINS = new Set(["speed_figure", "reduction_km"]);

/**
 * Statistiques d'avant-course : la plus récente tant que la course n'est pas
 * partie (`coalesce(excluded.x, entries.x)`). Une fois partie, l'import passe
 * `null` et la valeur figée est conservée.
 */
const LATEST_PRE_RACE = new Set(["jockey_runs_pre", "jockey_wins_pre", "trainer_runs_pre", "trainer_wins_pre"]);

/**
 * Chrono réalisé (voir `realizedKm`) : connu après l'arrivée, jamais une donnée
 * d'avant-course. La dernière valeur publiée fait foi, sans effacer la précédente.
 */
const LATEST_AFTER_RACE = new Set(["realized_km"]);

/**
 * Requête d'insertion/mise à jour d'un partant.
 *
 * Course pas encore partie : tout est rafraîchi (déclarations, cotes, pronostic).
 * Course partie (import J-1, backfill) : les données d'avant-course déjà en
 * base sont GELÉES — seules les colonnes vides sont complétées. La cote suit
 * la même règle : elle vit jusqu'au départ (import et boucle live), plus après.
 */
export function entryUpsertSql(raceStarted) {
  const placeholders = ENTRY_COLUMNS.map((_, index) => `$${index + 1}`);
  const updates = ENTRY_COLUMNS.filter((column) => column !== "id").map((column) => {
    if (ALWAYS_UPDATED.has(column)) return `${column} = excluded.${column}`;
    if (FIRST_VALUE_WINS.has(column)) return `${column} = coalesce(entries.${column}, excluded.${column})`;
    if (LATEST_PRE_RACE.has(column) || LATEST_AFTER_RACE.has(column)) return `${column} = coalesce(excluded.${column}, entries.${column})`;
    // L'origine suit la cote : une cote gelée garde son origine (NULL pour
    // l'historique), elle ne reçoit pas celle de la cote finale qu'on écarte.
    if (column === "odds_source" && raceStarted) {
      return "odds_source = case when entries.odds is null then excluded.odds_source else entries.odds_source end";
    }
    return raceStarted ? `${column} = coalesce(entries.${column}, excluded.${column})` : `${column} = excluded.${column}`;
  });

  return `insert into entries (${ENTRY_COLUMNS.join(", ")})
values (${placeholders.join(", ")})
on conflict (id) do update set
  ${updates.join(",\n  ")}`;
}

/**
 * Réduction kilométrique RÉALISÉE (millièmes de seconde), `null` tant que l'arrivée
 * n'est pas publiée ou si la valeur est hors plage. Elle ne sert qu'à l'historique
 * des courses SUIVANTES du cheval : ne jamais la lire pour la course elle-même.
 */
export function realizedKm(participant, ordreArrivee) {
  if (arrivalPlacings(ordreArrivee).length === 0) return null;
  const value = Number(participant?.reductionKilometrique);
  return Number.isFinite(value) && value > 40000 && value < 200000 ? value : null;
}

/** Paramètres de `entryUpsertSql`, dans l'ordre de `ENTRY_COLUMNS`. */
export function entryUpsertParams(values) {
  return ENTRY_COLUMNS.map((column) => {
    if (!(column in values)) throw new Error(`entryUpsertParams : colonne « ${column} » manquante`);
    return values[column];
  });
}
