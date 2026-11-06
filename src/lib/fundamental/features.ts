import { tokenizeMusic, type MusicToken } from "@/lib/prediction-math";
import type { HorseHistory } from "@/lib/fundamental/history";

/**
 * VARIABLES DU MODÈLE FONDAMENTAL — tout ce qu'on sait d'un partant SANS sa cote.
 *
 * Le PronoScore historique est calculé à partir des probabilités du marché : le
 * comparer au marché revient à comparer le marché à lui-même. Pour qu'un écart
 * « IA contre marché » ait un sens, il faut une estimation qui n'a jamais vu la
 * cote. C'est l'objet de ce module : forme (musique, pondérée par spécialité),
 * gains, âge, sexe, entourage, recul et autostart au trot, place à la corde et
 * poids au plat, déferrage, œillères, historique en base (fraîcheur, aptitudes
 * distance/terrain/hippodrome, changement de catégorie, couple cheval-jockey).
 *
 * Les mêmes fonctions servent à l'entraînement (scripts/train-fundamental.ts)
 * et au calcul en ligne : une variable ne peut pas être calculée différemment
 * entre les deux. Le calcul est piloté par la LISTE DE NOMS du modèle chargé
 * (model.json) : l'ancien modèle continue de recevoir exactement ses anciennes
 * variables.
 *
 * Toute donnée nouvelle est facultative : absente, la variable prend une valeur
 * neutre et un indicateur « manquant » passe à 1 (le modèle apprend ce que vaut
 * l'absence). Les données de COURSE (spécialité, départ, distance…) sont
 * identiques pour tous les partants : dans un logit conditionnel elles
 * s'annulent, elles n'agissent donc qu'en interaction avec une donnée du cheval
 * (place à la corde × autostart, musique × spécialité…).
 */

export type Discipline = "Plat" | "Trot" | "Obstacle";

/** Données de la course du jour (communes à tous les partants). */
export type FundamentalRaceContext = {
  /** races.specialty : TROT_ATTELE, TROT_MONTE, PLAT, HAIES, STEEPLECHASE, CROSS… ou Attele/Monte/Haies… */
  specialty?: string | null;
  /** races.start_type : 'autostart' | 'volte'. */
  startType?: string | null;
  /** Distance en mètres. */
  distance?: number | string | null;
  /** Allocation (€). */
  prize?: number | null;
  going?: string | null;
};

export type FundamentalInput = {
  number: number;
  music?: string | null;
  earnings?: number | null;
  age?: number | null;
  sex?: string | null;
  equipment?: string | null;
  handicapDistance?: number | null;
  /** Courses et victoires du jockey/driver AVANT cette course. */
  jockeyRuns?: number | null;
  jockeyWins?: number | null;
  trainerRuns?: number | null;
  trainerWins?: number | null;
  /** Place à la corde (entries.draw), distincte du numéro de dossard. */
  draw?: number | null;
  /** Poids porté (entries.weight, unité PMU : hectogrammes ou plus fin ; converti en kg). */
  weight?: number | null;
  /** Code de déferrage (entries.shoeing), ex. DEFERRE_ANTERIEURS_POSTERIEURS. */
  shoeing?: string | null;
  /** Code d'œillères (entries.blinkers), ex. OEILLERES_CLASSIQUE, SANS_OEILLERES. */
  blinkers?: string | null;
  /** Données de la course, répétées sur chaque partant (voir `fieldFeatures`). */
  raceContext?: FundamentalRaceContext | null;
  /** Historique en base, résumé par src/lib/fundamental/history.ts. */
  history?: HorseHistory | null;
};

/**
 * Libellés des variables du modèle d'origine (format 1). La page /methode
 * liste encore cet objet : il reste inchangé tant qu'elle n'est pas passée à
 * `fundamentalFeatureNames(discipline)` + `ALL_FEATURE_LABELS`.
 */
export const FEATURE_LABELS = {
  formAvg: "Forme récente (musique pondérée)",
  lastRace: "Dernière course",
  winsLast5: "Victoires sur les 5 dernières",
  placesLast5: "Places sur les 5 dernières",
  incidentsLast5: "Incidents récents (disq., chute, arrêt)",
  experience: "Expérience (courses lues)",
  noMusic: "Aucune course connue",
  earningsRel: "Gains (relatifs au peloton)",
  age: "Âge",
  female: "Femelle",
  male: "Entier",
  blinkers: "Œillères",
  jockeyRate: "Réussite du jockey/driver",
  trainerRate: "Réussite de l'entraîneur",
  recul: "Recul (trot, en mètres)",
  drawRel: "Numéro relatif (plat)",
} as const;

/** Libellés de toutes les variables connues (format 1 et format 2). */
export const ALL_FEATURE_LABELS = {
  ...FEATURE_LABELS,
  // — Format 2. —
  formScore: "Forme récente (musique, même spécialité d'abord)",
  sameSpecShare: "Courses récentes dans la spécialité du jour",
  stallRel: "Place à la corde (relative)",
  stallMissing: "Place à la corde inconnue",
  stallSprint: "Corde sur une course courte (plat ≤ 1 400 m)",
  stallAutostart: "Place derrière l'autostart",
  weightRel: "Poids (écart à la moyenne, kg)",
  weightMissing: "Poids inconnu",
  blinkersOn: "Œillères",
  shoeD4: "Déferré des 4",
  shoeDA: "Déferré des antérieurs",
  shoeDP: "Déferré des postérieurs",
  shoeMissing: "Déferrage inconnu",
  shoeFirstTime: "Déferré pour la 1re fois",
  daysSinceLog: "Fraîcheur (jours depuis la dernière course)",
  longBreak: "Retour après plus de 90 jours",
  runs90d: "Courses dans les 90 derniers jours",
  historyMissing: "Aucune course en base",
  bestRelFinish: "Meilleure place récente (relative au peloton)",
  avgRelFinish: "Place moyenne récente (relative au peloton)",
  distAptitude: "Aptitude à la distance (±200 m)",
  goingAptitude: "Aptitude au terrain",
  courseAptitude: "Résultats sur l'hippodrome",
  classChange: "Changement de catégorie (allocation)",
  classMissing: "Catégorie précédente inconnue",
  comboRuns: "Courses avec ce jockey/driver",
  comboRate: "Réussite du couple cheval-jockey",
  chronoBest: "Meilleur chrono récent (réduction km, écart au peloton)",
  chronoLast: "Dernier chrono (réduction km, écart au peloton)",
  chronoMissing: "Aucun chrono connu",
} as const;

export type FeatureName = keyof typeof ALL_FEATURE_LABELS;
export const FEATURE_NAMES = Object.keys(ALL_FEATURE_LABELS) as FeatureName[];

/** Variables du modèle d'origine, dans l'ordre de son model.json. */
export const LEGACY_FEATURE_NAMES: FeatureName[] = [
  "formAvg",
  "lastRace",
  "winsLast5",
  "placesLast5",
  "incidentsLast5",
  "experience",
  "noMusic",
  "earningsRel",
  "age",
  "female",
  "male",
  "blinkers",
  "jockeyRate",
  "trainerRate",
  "recul",
  "drawRel",
];

/**
 * Groupes du format 2. `base` est toujours présent ; les autres ne sont gardés
 * par l'entraînement que s'ils baissent le log loss hors échantillon.
 */
export const FEATURE_GROUPS = {
  base: ["formScore", "incidentsLast5", "experience", "noMusic", "earningsRel", "age", "female", "male", "jockeyRate", "trainerRate", "recul"],
  specialty: ["sameSpecShare"],
  stall: ["stallRel", "stallMissing", "stallSprint", "stallAutostart"],
  weight: ["weightRel", "weightMissing"],
  equipment: ["blinkersOn", "shoeD4", "shoeDA", "shoeDP", "shoeMissing", "shoeFirstTime"],
  recency: ["daysSinceLog", "longBreak", "runs90d", "historyMissing"],
  finish: ["bestRelFinish", "avgRelFinish"],
  aptitude: ["distAptitude", "goingAptitude", "courseAptitude"],
  class: ["classChange", "classMissing"],
  combo: ["comboRuns", "comboRate"],
  chrono: ["chronoBest", "chronoLast", "chronoMissing"],
} as const satisfies Record<string, readonly FeatureName[]>;

export type FeatureGroup = keyof typeof FEATURE_GROUPS;
export const FEATURE_GROUP_NAMES = Object.keys(FEATURE_GROUPS) as FeatureGroup[];

export function featuresOfGroups(groups: readonly FeatureGroup[]): FeatureName[] {
  return groups.flatMap((g) => [...FEATURE_GROUPS[g]]);
}

/** Taux de victoire rétréci vers la moyenne : 3 victoires en 5 montes ne valent pas 60 %. */
function shrunkRate(wins: number | null | undefined, runs: number | null | undefined, prior = 0.09, strength = 30) {
  const r = Math.max(0, Number(runs) || 0);
  const w = Math.max(0, Math.min(r, Number(wins) || 0));
  return (w + prior * strength) / (r + strength);
}

// ─── Musique et spécialité ──────────────────────────────────────────────────

const FAMILY: Record<string, "trot" | "plat" | "obstacle"> = { a: "trot", m: "trot", p: "plat", h: "obstacle", s: "obstacle", c: "obstacle" };
const DISCIPLINE_FAMILY: Record<Discipline, "trot" | "plat" | "obstacle"> = { Trot: "trot", Plat: "plat", Obstacle: "obstacle" };

/** Lettre de musique de la spécialité du jour (a, m, p, h, s, c), `null` si inconnue. */
export function specialtyLetter(specialty: string | null | undefined, discipline: Discipline): string | null {
  const s = String(specialty ?? "").toUpperCase();
  if (s.includes("MONTE")) return "m";
  if (s.includes("ATTELE")) return "a";
  if (s.includes("HAIE")) return "h";
  if (s.includes("STEEPLE")) return "s";
  if (s.includes("CROSS")) return "c";
  if (s.includes("PLAT") || discipline === "Plat") return "p";
  return null;
}

/**
 * Poids d'une course passée selon sa spécialité : même spécialité 1, même
 * famille (ex. monté pour un attelé) 0,6, autre famille 0,3. Sans lettre, la
 * course compte pleinement (format historique sans lettre).
 */
export function musicTokenWeight(token: MusicToken, letter: string | null, discipline: Discipline): number {
  const l = token.discipline;
  if (!l || !FAMILY[l]) return 1;
  if (letter) return l === letter ? 1 : FAMILY[l] === FAMILY[letter] ? 0.6 : 0.3;
  return FAMILY[l] === DISCIPLINE_FAMILY[discipline] ? 1 : 0.3;
}

/** Note d'une course : 1 victoire → 1, 9e → 0,11 ; non placé ou incident → 0. */
function runScore(token: MusicToken) {
  return token.kind === "pos" ? (10 - token.value) / 9 : 0;
}

/** Note de forme décroissante (0,75^k) pondérée par la spécialité ; 0,3 sans musique. */
export function formScore(tokens: MusicToken[], letter: string | null, discipline: Discipline): number {
  let num = 0;
  let den = 0;
  tokens.forEach((t, k) => {
    const w = Math.pow(0.75, k) * musicTokenWeight(t, letter, discipline);
    num += w * runScore(t);
    den += w;
  });
  return den > 0 ? num / den : 0.3;
}

function sameSpecShare(tokens: MusicToken[], letter: string | null, discipline: Discipline): number {
  const lettered = tokens.filter((t) => t.discipline && FAMILY[t.discipline]);
  if (!lettered.length) return 0;
  const same = lettered.filter((t) => (letter ? t.discipline === letter : FAMILY[t.discipline!] === DISCIPLINE_FAMILY[discipline]));
  return same.length / lettered.length;
}

// ─── Équipement ─────────────────────────────────────────────────────────────

export type Shoeing = { front: boolean; hind: boolean };

/** Code PMU de déferrage → antérieurs / postérieurs déferrés ; `null` si absent. */
export function parseShoeing(code: string | null | undefined): Shoeing | null {
  const s = String(code ?? "").toUpperCase();
  if (!s) return null;
  if (s.includes("DEFERRE_ANTERIEURS_POSTERIEURS") || s.includes("DEFERRE_4") || s === "D4") return { front: true, hind: true };
  return { front: s.includes("DEFERRE_ANTERIEURS"), hind: s.includes("DEFERRE_POSTERIEURS") };
}

/** Code de déferrage du partant : colonne dédiée, sinon `equipment` quand l'import y a mis le déferrage. */
function shoeingCode(horse: FundamentalInput): string | null {
  if (horse.shoeing) return horse.shoeing;
  const e = String(horse.equipment ?? "").toUpperCase();
  return e.startsWith("DEFERRE") || e.startsWith("PROTEGE") ? e : null;
}

function blinkersOn(horse: FundamentalInput): number {
  const code = String(horse.blinkers ?? horse.equipment ?? "").toUpperCase();
  return code.includes("OEILLERE") && !code.startsWith("SANS") ? 1 : 0;
}

/** Poids en kg quelle que soit l'unité stockée (kg, hg, dag, g…). `null` si absent. */
export function weightKg(value: number | null | undefined): number | null {
  let v = Number(value);
  if (!Number.isFinite(v) || v <= 0) return null;
  while (v > 150) v /= 10;
  return v >= 30 ? v : null;
}

// ─── Calcul ─────────────────────────────────────────────────────────────────

function contextOf(field: FundamentalInput[], context?: FundamentalRaceContext | null): FundamentalRaceContext {
  return context ?? field.find((h) => h.raceContext)?.raceContext ?? {};
}

function shrunkTop3(top3: number, runs: number) {
  return (top3 + 0.3 * 3) / (runs + 3);
}

/** Toutes les variables d'un partant (le peloton sert aux variables relatives). */
function horseRecord(
  horse: FundamentalInput,
  i: number,
  ctx: {
    discipline: Discipline;
    fieldSize: number;
    logEarnings: number[];
    meanEarnings: number;
    baseDistance: number | null;
    maxDraw: number;
    meanWeight: number | null;
    letter: string | null;
    autostart: boolean;
    sprint: boolean;
    meanBestKm: number | null;
    meanLastKm: number | null;
  },
): Record<FeatureName, number> {
  const { discipline, fieldSize } = ctx;
  const tokens = tokenizeMusic(horse.music, 8);
  const values = tokens.map((t) => (t.kind === "pos" ? t.value : 10));
  const last5 = tokens.slice(0, 5);
  const weights = values.map((_, k) => Math.pow(0.75, k));
  const weightSum = weights.reduce((a, b) => a + b, 0);
  const formAvg = values.length ? values.reduce((s, v, k) => s + v * weights[k], 0) / weightSum : 7.5;

  const draw = Number(horse.draw);
  const hasDraw = Number.isFinite(draw) && draw >= 1;
  const stallRel = hasDraw && ctx.maxDraw > 1 ? Math.min(1, (draw - 1) / (ctx.maxDraw - 1)) : 0;
  const stallUsed = discipline === "Plat" || (discipline === "Trot" && ctx.autostart);

  const kg = weightKg(horse.weight);
  const shoe = discipline === "Trot" ? parseShoeing(shoeingCode(horse)) : null;
  const lastShoe = parseShoeing(horse.history?.lastShoeing);
  const deferred = shoe ? shoe.front || shoe.hind : false;

  const h = horse.history;
  const hasHistory = !!h && h.runs > 0;

  return {
    formAvg,
    lastRace: values[0] ?? 7.5,
    winsLast5: last5.filter((t) => t.kind === "pos" && t.value === 1).length,
    placesLast5: last5.filter((t) => t.kind === "pos" && t.value <= 3).length,
    incidentsLast5: last5.filter((t) => t.kind === "inc").length,
    experience: Math.min(tokens.length, 8),
    noMusic: tokens.length === 0 ? 1 : 0,
    earningsRel: ctx.logEarnings[i] - ctx.meanEarnings,
    age: Number(horse.age) || 5,
    female: horse.sex === "FEMELLES" ? 1 : 0,
    male: horse.sex === "MALES" ? 1 : 0,
    blinkers: horse.equipment && horse.equipment !== "SANS_OEILLERES" ? 1 : 0,
    jockeyRate: shrunkRate(horse.jockeyWins, horse.jockeyRuns),
    trainerRate: shrunkRate(horse.trainerWins, horse.trainerRuns),
    recul:
      discipline === "Trot" && ctx.baseDistance !== null && Number(horse.handicapDistance) > 0
        ? (Number(horse.handicapDistance) - ctx.baseDistance) / 25
        : 0,
    // Ancienne variable (format 1) : numéro de DOSSARD, gardée pour reproduire l'ancien modèle.
    drawRel: discipline === "Plat" && fieldSize > 1 ? (horse.number - 1) / (fieldSize - 1) : 0,

    formScore: formScore(tokens, ctx.letter, discipline),
    sameSpecShare: sameSpecShare(tokens, ctx.letter, discipline),
    stallRel: discipline === "Plat" ? stallRel : 0,
    stallMissing: stallUsed && !hasDraw ? 1 : 0,
    stallSprint: discipline === "Plat" && ctx.sprint ? stallRel : 0,
    stallAutostart: discipline === "Trot" && ctx.autostart ? stallRel : 0,
    weightRel: discipline !== "Trot" && kg !== null && ctx.meanWeight !== null ? kg - ctx.meanWeight : 0,
    weightMissing: discipline !== "Trot" && kg === null ? 1 : 0,
    blinkersOn: blinkersOn(horse),
    shoeD4: shoe && shoe.front && shoe.hind ? 1 : 0,
    shoeDA: shoe && shoe.front && !shoe.hind ? 1 : 0,
    shoeDP: shoe && !shoe.front && shoe.hind ? 1 : 0,
    shoeMissing: discipline === "Trot" && !shoe ? 1 : 0,
    shoeFirstTime: deferred && h?.lastShoeing != null && lastShoe !== null && !lastShoe.front && !lastShoe.hind ? 1 : 0,
    daysSinceLog: hasHistory && h.daysSinceLast !== null ? Math.log1p(Math.max(0, h.daysSinceLast)) : Math.log1p(30),
    longBreak: hasHistory && h.daysSinceLast !== null && h.daysSinceLast > 90 ? 1 : 0,
    runs90d: hasHistory ? h.runs90d : 0,
    historyMissing: hasHistory ? 0 : 1,
    bestRelFinish: hasHistory && h.bestRelFinish !== null ? 1 - h.bestRelFinish : 0.5,
    avgRelFinish: hasHistory && h.avgRelFinish !== null ? 1 - h.avgRelFinish : 0.5,
    distAptitude: shrunkTop3(h?.distanceTop3 ?? 0, h?.distanceRuns ?? 0),
    goingAptitude: shrunkTop3(h?.goingTop3 ?? 0, h?.goingRuns ?? 0),
    courseAptitude: shrunkTop3(h?.courseTop3 ?? 0, h?.courseRuns ?? 0),
    classChange: h?.classChange ?? 0,
    classMissing: h?.classChange == null ? 1 : 0,
    comboRuns: Math.log1p(h?.comboRuns ?? 0),
    comboRate: shrunkTop3(h?.comboTop3 ?? 0, h?.comboRuns ?? 0),
    // Trot seul : secondes gagnées sur la moyenne du peloton (positif = plus rapide).
    chronoBest: discipline === "Trot" && h?.bestKm != null && ctx.meanBestKm !== null ? ctx.meanBestKm - h.bestKm : 0,
    chronoLast: discipline === "Trot" && h?.lastKm != null && ctx.meanLastKm !== null ? ctx.meanLastKm - h.lastKm : 0,
    chronoMissing: discipline === "Trot" && h?.bestKm == null ? 1 : 0,
  };
}

/**
 * Vecteur de variables `names` de chaque partant d'une course. Les variables
 * relatives (gains, recul, corde, poids) se calculent à l'échelle du peloton :
 * c'est pourquoi la fonction prend la course entière. `context` (ou, à défaut,
 * le `raceContext` porté par les partants) donne la spécialité, le départ et la
 * distance.
 */
export function computeFeatures(
  field: FundamentalInput[],
  discipline: Discipline,
  names: readonly FeatureName[],
  context?: FundamentalRaceContext | null,
): number[][] {
  const fieldSize = field.length;
  const logEarnings = field.map((h) => Math.log1p(Math.max(0, Number(h.earnings) || 0)));
  const meanEarnings = logEarnings.reduce((a, b) => a + b, 0) / Math.max(fieldSize, 1);
  const distances = field.map((h) => Number(h.handicapDistance)).filter((d) => Number.isFinite(d) && d > 0);
  const draws = field.map((h) => Number(h.draw)).filter((d) => Number.isFinite(d) && d >= 1);
  const kgs = field.map((h) => weightKg(h.weight)).filter((w): w is number => w !== null);
  const race = contextOf(field, context);
  const meanOf = (values: Array<number | null | undefined>) => {
    const known = values.filter((v): v is number => v != null);
    return known.length ? known.reduce((a, b) => a + b, 0) / known.length : null;
  };
  const raceDistance = Number(String(race.distance ?? "").replace(/[^\d]/g, ""));

  const ctx = {
    discipline,
    fieldSize,
    logEarnings,
    meanEarnings,
    baseDistance: distances.length ? Math.min(...distances) : null,
    maxDraw: Math.max(fieldSize, ...draws),
    meanWeight: kgs.length ? kgs.reduce((a, b) => a + b, 0) / kgs.length : null,
    letter: specialtyLetter(race.specialty, discipline),
    autostart: String(race.startType ?? "").toLowerCase().startsWith("auto"),
    sprint: raceDistance > 0 && raceDistance <= 1400,
    meanBestKm: meanOf(field.map((h) => h.history?.bestKm)),
    meanLastKm: meanOf(field.map((h) => h.history?.lastKm)),
  };

  return field.map((horse, i) => {
    const record = horseRecord(horse, i, ctx);
    return names.map((name) => record[name]);
  });
}

/** Variables du modèle d'origine (format 1), dans son ordre. */
export function fieldFeatures(field: FundamentalInput[], discipline: Discipline): number[][] {
  return computeFeatures(field, discipline, LEGACY_FEATURE_NAMES);
}

export function isFeatureName(name: string): name is FeatureName {
  return Object.prototype.hasOwnProperty.call(ALL_FEATURE_LABELS, name);
}
