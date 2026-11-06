import assert from "node:assert/strict";
import { describe, it } from "node:test";
import modelFile from "../src/lib/fundamental/model.json";
import {
  FEATURE_GROUPS,
  ALL_FEATURE_LABELS,
  LEGACY_FEATURE_NAMES,
  computeFeatures,
  fieldFeatures,
  formScore,
  parseShoeing,
  specialtyLetter,
  weightKg,
  type FeatureName,
  type FundamentalInput,
} from "../src/lib/fundamental/features";
import { computeHorseHistory, pastRunFromRow, parseDistance, type PastRun } from "../src/lib/fundamental/history";
import { fundamentalContributions, fundamentalProbabilities, loadModel, probabilitiesWith } from "../src/lib/fundamental/model";
import { tokenizeMusic } from "../src/lib/prediction-math";
import { choleskySolve, explodedObjective, fitExplodedLogit, type RankedRace } from "../scripts/lib/exploded-logit";
import { buildDataset, type DatasetRow } from "../scripts/lib/dataset";

// ─── Référence figée : le calcul du modèle d'origine, tel qu'il était ───────

function legacyShrunk(wins: number | null | undefined, runs: number | null | undefined) {
  const r = Math.max(0, Number(runs) || 0);
  const w = Math.max(0, Math.min(r, Number(wins) || 0));
  return (w + 0.09 * 30) / (r + 30);
}

function legacyFeatures(field: FundamentalInput[], discipline: string): number[][] {
  const fieldSize = field.length;
  const logEarnings = field.map((h) => Math.log1p(Math.max(0, Number(h.earnings) || 0)));
  const meanEarnings = logEarnings.reduce((a, b) => a + b, 0) / Math.max(fieldSize, 1);
  const distances = field.map((h) => Number(h.handicapDistance)).filter((d) => Number.isFinite(d) && d > 0);
  const baseDistance = distances.length ? Math.min(...distances) : null;
  return field.map((horse, i) => {
    const tokens = tokenizeMusic(horse.music, 8);
    const values = tokens.map((t) => (t.kind === "pos" ? t.value : 10));
    const last5 = tokens.slice(0, 5);
    const weights = values.map((_, k) => Math.pow(0.75, k));
    const weightSum = weights.reduce((a, b) => a + b, 0);
    const formAvg = values.length ? values.reduce((s, v, k) => s + v * weights[k], 0) / weightSum : 7.5;
    return [
      formAvg,
      values[0] ?? 7.5,
      last5.filter((t) => t.kind === "pos" && t.value === 1).length,
      last5.filter((t) => t.kind === "pos" && t.value <= 3).length,
      last5.filter((t) => t.kind === "inc").length,
      Math.min(tokens.length, 8),
      tokens.length === 0 ? 1 : 0,
      logEarnings[i] - meanEarnings,
      Number(horse.age) || 5,
      horse.sex === "FEMELLES" ? 1 : 0,
      horse.sex === "MALES" ? 1 : 0,
      horse.equipment && horse.equipment !== "SANS_OEILLERES" ? 1 : 0,
      legacyShrunk(horse.jockeyWins, horse.jockeyRuns),
      legacyShrunk(horse.trainerWins, horse.trainerRuns),
      discipline === "Trot" && baseDistance !== null && Number(horse.handicapDistance) > 0 ? (Number(horse.handicapDistance) - baseDistance) / 25 : 0,
      discipline === "Plat" && fieldSize > 1 ? (horse.number - 1) / (fieldSize - 1) : 0,
    ];
  });
}

type LegacyFile = { disciplines: Record<string, { means: number[]; sds: number[]; coef: number[] }> };

function legacyProbabilities(field: FundamentalInput[], discipline: string) {
  const m = (modelFile as unknown as LegacyFile).disciplines[discipline];
  const logits = legacyFeatures(field, discipline).map((row) => row.reduce((acc, v, j) => acc + m.coef[j] * ((v - m.means[j]) / m.sds[j]), 0));
  const max = Math.max(...logits);
  const e = logits.map((l) => Math.exp(l - max));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map((v) => v / s);
}

const FIELD: FundamentalInput[] = [
  { number: 1, music: "1a2a(25)3a0a", earnings: 120000, age: 6, sex: "MALES", equipment: "OEILLERES_CLASSIQUE", handicapDistance: 2100, jockeyRuns: 300, jockeyWins: 40, trainerRuns: 80, trainerWins: 9, draw: 9, weight: 570 },
  { number: 2, music: "Da5m7a", earnings: 30000, age: 4, sex: "FEMELLES", equipment: "SANS_OEILLERES", handicapDistance: 2125, jockeyRuns: 10, jockeyWins: 0, draw: 1, weight: 550 },
  { number: 3, music: null, earnings: null, age: null, sex: "HONGRES", equipment: null, handicapDistance: 2100, draw: null },
  { number: 4, music: "7A3A0A198A", earnings: 5000, age: 9, sex: "MALES", equipment: "DEFERRE_ANTERIEURS", handicapDistance: 2150, jockeyRuns: 1000, jockeyWins: 130, draw: 4, weight: 600 },
  { number: 5, music: "2p1p1p", earnings: 80000, age: 3, sex: "FEMELLES", equipment: "SANS_OEILLERES", draw: 2, weight: 545 },
];

// ─── Rétrocompatibilité ──────────────────────────────────────────────────────

describe("modèle publié (format 1) — rétrocompatibilité", () => {
  it("les variables historiques sont calculées à l'identique", () => {
    for (const d of ["Plat", "Trot", "Obstacle"] as const) {
      assert.deepEqual(fieldFeatures(FIELD, d), legacyFeatures(FIELD, d));
    }
  });

  it("les probabilités sont exactement celles d'avant, même avec les nouvelles données", () => {
    const enriched = FIELD.map((h) => ({ ...h, raceContext: { specialty: "TROT_ATTELE", startType: "autostart", distance: 2100 }, shoeing: "DEFERRE_ANTERIEURS_POSTERIEURS" }));
    for (const d of ["Plat", "Trot", "Obstacle"] as const) {
      const expected = legacyProbabilities(FIELD, d);
      assert.deepEqual(fundamentalProbabilities(FIELD, d), expected);
      assert.deepEqual(fundamentalProbabilities(enriched, d), expected);
    }
  });

  it("les contributions somment à l'écart de logit et gardent les anciens libellés", () => {
    const c = fundamentalContributions(FIELD, "Trot")!;
    assert.equal(c[0].length, 16);
    const p = legacyProbabilities(FIELD, "Trot");
    const logits = p.map((v) => Math.log(v));
    const meanLogit = logits.reduce((a, b) => a + b, 0) / logits.length;
    c.forEach((row, i) => assert.ok(Math.abs(row.reduce((s, x) => s + x.contribution, 0) - (logits[i] - meanLogit)) < 1e-9));
    assert.deepEqual(c[0].map((x) => x.feature), LEGACY_FEATURE_NAMES);
  });

  it("loadModel lit le format 2 (variables par discipline) et refuse une variable inconnue", () => {
    const v2 = {
      formatVersion: 2,
      version: "x",
      trainCutoff: "2026-06-01",
      disciplines: { Plat: { features: ["formScore", "stallRel"], means: [0, 0], sds: [1, 1], coef: [1, -1] } },
    };
    const m = loadModel(v2);
    assert.equal(m.formatVersion, 2);
    assert.deepEqual(m.disciplines.Plat?.features, ["formScore", "stallRel"]);
    const p = probabilitiesWith(m.disciplines.Plat!, FIELD, "Plat");
    assert.ok(Math.abs(p.reduce((a, b) => a + b, 0) - 1) < 1e-12);
    assert.throws(() => loadModel({ ...v2, disciplines: { Plat: { ...v2.disciplines.Plat, features: ["inconnue", "stallRel"] } } }));
    assert.throws(() => loadModel({ ...v2, disciplines: { Plat: { ...v2.disciplines.Plat, coef: [1] } } }));
  });

  it("chaque variable des groupes a un libellé", () => {
    for (const names of Object.values(FEATURE_GROUPS)) for (const n of names) assert.ok(ALL_FEATURE_LABELS[n as FeatureName]);
  });
});

// ─── Musique ─────────────────────────────────────────────────────────────────

describe("tokenizeMusic — lettre de discipline", () => {
  it("garde la lettre sans changer le découpage", () => {
    const t = tokenizeMusic("Da0a4m(25)6p1h");
    assert.deepEqual(t.map((x) => (x.kind === "pos" ? x.value : x.code)), ["D", 10, 4, 6, 1]);
    assert.deepEqual(t.map((x) => x.discipline), ["a", "a", "m", "p", "h"]);
  });

  it("format historique en majuscules : lettre normalisée en minuscule", () => {
    const t = tokenizeMusic("7A3A0A198A");
    assert.deepEqual(t.map((x) => (x.kind === "pos" ? x.value : x.code)), [7, 3, 10, 8]);
    assert.deepEqual(t.map((x) => x.discipline), ["a", "a", "a", "a"]);
  });

  it("sans lettre, pas de champ discipline", () => {
    assert.equal(tokenizeMusic("123")[0].discipline, undefined);
  });

  it("la forme pèse d'abord les courses de même spécialité", () => {
    // Gagne au monté, échoue à l'attelé.
    const tokens = tokenizeMusic("1m0a1m0a");
    const attele = formScore(tokens, "a", "Trot");
    const monte = formScore(tokens, "m", "Trot");
    assert.ok(monte > attele);
    assert.equal(specialtyLetter("TROT_MONTE", "Trot"), "m");
    assert.equal(specialtyLetter("Attele", "Trot"), "a");
    assert.equal(specialtyLetter("STEEPLECHASE", "Obstacle"), "s");
    assert.equal(specialtyLetter(null, "Plat"), "p");
    assert.equal(specialtyLetter(null, "Trot"), null);
    assert.equal(formScore([], null, "Trot"), 0.3);
  });

  it("sameSpecShare suit la spécialité du jour", () => {
    const [a] = computeFeatures([{ number: 1, music: "1m2a3a4a" }, { number: 2 }], "Trot", ["sameSpecShare"], { specialty: "TROT_ATTELE" });
    assert.equal(a[0], 0.75);
  });
});

// ─── Corde, poids, équipement ───────────────────────────────────────────────

describe("corde, poids, déferrage", () => {
  it("la corde utilise la place à la corde, pas le dossard", () => {
    const field: FundamentalInput[] = [
      { number: 1, draw: 8 },
      { number: 2, draw: 1 },
      { number: 3, draw: null },
      { number: 4, draw: 4 },
    ];
    const x = computeFeatures(field, "Plat", ["stallRel", "stallMissing"]);
    // maxDraw = 8 (> 4 partants) : (8-1)/7 = 1, (1-1)/7 = 0
    assert.deepEqual(x.map((r) => r[0]), [1, 0, 0, 3 / 7]);
    assert.deepEqual(x.map((r) => r[1]), [0, 0, 1, 0]);
    // L'ancienne variable reste le numéro de dossard.
    assert.deepEqual(computeFeatures(field, "Plat", ["drawRel"]).map((r) => r[0]), [0, 1 / 3, 2 / 3, 1]);
  });

  it("corde au trot : seulement derrière l'autostart ; sprint au plat", () => {
    const field: FundamentalInput[] = [{ number: 1, draw: 2 }, { number: 2, draw: 1 }];
    assert.deepEqual(computeFeatures(field, "Trot", ["stallAutostart", "stallMissing"], { startType: "autostart" }), [[1, 0], [0, 0]]);
    assert.deepEqual(computeFeatures(field, "Trot", ["stallAutostart", "stallMissing"], { startType: "volte" }), [[0, 0], [0, 0]]);
    assert.deepEqual(computeFeatures(field, "Plat", ["stallSprint"], { distance: "1 200 m" }).map((r) => r[0]), [1, 0]);
    assert.deepEqual(computeFeatures(field, "Plat", ["stallSprint"], { distance: 2400 }).map((r) => r[0]), [0, 0]);
  });

  it("le contexte peut venir des partants (raceContext)", () => {
    const field: FundamentalInput[] = [{ number: 1, draw: 2, raceContext: { startType: "autostart" } }, { number: 2, draw: 1 }];
    assert.deepEqual(computeFeatures(field, "Trot", ["stallAutostart"]).map((r) => r[0]), [1, 0]);
  });

  it("poids : converti en kg, relatif au peloton, indicateur si absent", () => {
    assert.equal(weightKg(570), 57);
    assert.equal(weightKg(57), 57);
    assert.equal(weightKg(57000), 57);
    assert.equal(weightKg(null), null);
    const x = computeFeatures([{ number: 1, weight: 600 }, { number: 2, weight: 560 }, { number: 3 }], "Plat", ["weightRel", "weightMissing"]);
    assert.deepEqual(x, [[2, 0], [-2, 0], [0, 1]]);
    assert.deepEqual(computeFeatures([{ number: 1, weight: 600 }], "Trot", ["weightRel", "weightMissing"]), [[0, 0]]);
  });

  it("déferrage : 4 pieds, antérieurs, postérieurs, 1re fois", () => {
    assert.deepEqual(parseShoeing("DEFERRE_ANTERIEURS_POSTERIEURS"), { front: true, hind: true });
    assert.deepEqual(parseShoeing("DEFERRE_ANTERIEURS"), { front: true, hind: false });
    assert.deepEqual(parseShoeing("PROTEGE_ANTERIEURS_DEFERRE_POSTERIEURS"), { front: false, hind: true });
    assert.equal(parseShoeing(null), null);
    const names: FeatureName[] = ["shoeD4", "shoeDA", "shoeDP", "shoeMissing", "shoeFirstTime"];
    const history = (lastShoeing: string | null) => ({ ...computeHorseHistory([], { date: "2026-01-01" }), runs: 1, lastShoeing });
    const x = computeFeatures(
      [
        { number: 1, shoeing: "DEFERRE_ANTERIEURS_POSTERIEURS", history: history("PROTEGE_ANTERIEURS") },
        { number: 2, equipment: "DEFERRE_ANTERIEURS" },
        { number: 3 },
        { number: 4, shoeing: "DEFERRE_POSTERIEURS", history: history("DEFERRE_POSTERIEURS") },
      ],
      "Trot",
      names,
    );
    assert.deepEqual(x, [
      [1, 0, 0, 0, 1],
      [0, 1, 0, 0, 0],
      [0, 0, 0, 1, 0],
      [0, 0, 1, 0, 0],
    ]);
  });

  it("œillères : colonne dédiée, sinon equipment ; un code de déferrage n'est pas une œillère", () => {
    const x = computeFeatures(
      [{ number: 1, blinkers: "OEILLERES_AUSTRALIENNES" }, { number: 2, equipment: "OEILLERES_CLASSIQUE" }, { number: 3, equipment: "DEFERRE_ANTERIEURS" }, { number: 4, equipment: "SANS_OEILLERES" }],
      "Trot",
      ["blinkersOn"],
    );
    assert.deepEqual(x.map((r) => r[0]), [1, 1, 0, 0]);
  });
});

// ─── Historique ──────────────────────────────────────────────────────────────

describe("historique en base (computeHorseHistory)", () => {
  const runs: PastRun[] = [
    { date: "2026-03-01", position: 1, fieldSize: 11, distance: 2100, going: "Bon", racecourse: "VIN", prize: 30000, jockeyId: "J1", shoeing: "DEFERRE_ANTERIEURS_POSTERIEURS" },
    { date: "2026-02-01", position: 6, fieldSize: 11, distance: 2700, going: "Souple", racecourse: "ENG", prize: 20000, jockeyId: "J2", shoeing: null },
    { date: "2025-11-15", position: null, fieldSize: 14, distance: 2150, going: "bon", racecourse: "VIN", prize: 40000, jockeyId: "J1", shoeing: null },
    // Courses du jour et futures : doivent être ignorées (pas de fuite).
    { date: "2026-03-20", position: 1, fieldSize: 10, distance: 2100, going: "Bon", racecourse: "VIN", prize: 90000, jockeyId: "J1" },
    { date: "2026-04-10", position: 1, fieldSize: 10, distance: 2100, going: "Bon", racecourse: "VIN", prize: 90000, jockeyId: "J1" },
  ];
  const today = { date: "2026-03-20", distance: 2100, going: "BON", racecourse: "VIN", prize: 60000, jockeyId: "J1" };

  it("ne lit que les courses strictement antérieures", () => {
    const h = computeHorseHistory(runs, today);
    assert.equal(h.runs, 3);
    assert.equal(h.daysSinceLast, 19);
    assert.equal(h.runs90d, 2);
  });

  it("places relatives, aptitudes, catégorie, couple", () => {
    const h = computeHorseHistory(runs, today);
    assert.equal(h.bestRelFinish, 0);
    assert.ok(Math.abs(h.avgRelFinish! - (0 + 0.5 + 1) / 3) < 1e-12);
    assert.deepEqual([h.distanceRuns, h.distanceTop3], [2, 1]);
    assert.deepEqual([h.goingRuns, h.goingTop3], [2, 1]);
    assert.deepEqual([h.courseRuns, h.courseTop3], [2, 1]);
    assert.deepEqual([h.comboRuns, h.comboTop3], [2, 1]);
    assert.ok(Math.abs(h.classChange! - Math.log(60000 / 30000)) < 1e-12);
    assert.equal(h.lastShoeing, "DEFERRE_ANTERIEURS_POSTERIEURS");
  });

  it("aucune course : historique vide, variables neutres et indicateur", () => {
    const h = computeHorseHistory([], today);
    assert.equal(h.runs, 0);
    const [x] = computeFeatures([{ number: 1, history: h }], "Trot", ["historyMissing", "bestRelFinish", "classMissing", "runs90d"]);
    assert.deepEqual(x, [1, 0.5, 1, 0]);
    const [y] = computeFeatures([{ number: 1 }], "Trot", ["historyMissing", "bestRelFinish", "classMissing", "runs90d"]);
    assert.deepEqual(y, x);
  });

  it("lignes SQL → courses passées", () => {
    const run = pastRunFromRow({ horse_id: "H", race_date: "2026-01-02", position: 3, field_size: 12, distance: "2 850 m", going: "Bon", racecourse: "x", prize: "25000", jockey_id: "J", shoeing: null, reduction_km: "72500" });
    assert.deepEqual(run, { date: "2026-01-02", position: 3, fieldSize: 12, distance: 2850, going: "Bon", racecourse: "x", prize: 25000, jockeyId: "J", shoeing: null, reductionKm: "72500" });
    assert.equal(parseDistance("abc"), null);
  });
});

describe("jeu de données point-in-time (buildDataset)", () => {
  it("une course n'entre dans l'historique qu'après son jour", () => {
    const row = (race: string, date: string, horse: string, number: number, pos: number): DatasetRow =>
      ({
        race_id: race, race_date: date, discipline: "Trot", specialty: "TROT_ATTELE", start_type: null, distance: "2100", going: "Bon", prize: "10000",
        racecourse: "C", horse_id: horse, number, music: null, earnings: 0, age: 5, sex: "MALES", equipment: null, handicapDistance: 2100,
        draw: null, weight: null, shoeing: null, blinkers: null, jockey_id: "J", trainer_id: "T", odds: 5, pos,
      }) as DatasetRow;
    const horses = ["A", "B", "C", "D"];
    const rows = [
      ...horses.map((h, i) => row("R1", "2026-01-01", h, i + 1, i + 1)),
      ...horses.map((h, i) => row("R2", "2026-01-01", h, i + 1, 4 - i)),
      ...horses.map((h, i) => row("R3", "2026-01-05", h, i + 1, i + 1)),
    ];
    const races = buildDataset(rows);
    assert.equal(races.length, 3);
    // Même jour : aucune trace de R1 dans R2.
    assert.equal(races[1].field[0].history?.runs, 0);
    // Quatre jours plus tard : les deux courses du 1er janvier.
    assert.equal(races[2].field[0].history?.runs, 2);
    assert.equal(races[2].field[0].history?.daysSinceLast, 4);
    assert.equal(races[2].field[0].jockeyRuns, 8);
    assert.equal(races[2].context.specialty, "TROT_ATTELE");
  });

  it("le chrono d'une course n'est lu que par les courses des jours suivants", () => {
    const row = (race: string, date: string, horse: string, number: number, km: string | null): DatasetRow =>
      ({
        race_id: race, race_date: date, discipline: "Trot", specialty: "TROT_ATTELE", start_type: null, distance: "2100", going: null, prize: "10000",
        racecourse: "C", horse_id: horse, number, music: null, earnings: 0, age: 5, sex: "MALES", equipment: null, handicapDistance: 2100,
        draw: null, weight: null, shoeing: null, blinkers: null, jockey_id: "J", trainer_id: "T", odds: 5, pos: number, reduction_km: km,
      }) as DatasetRow;
    const horses = ["A", "B", "C", "D"];
    const races = buildDataset([
      ...horses.map((h, i) => row("R1", "2026-01-01", h, i + 1, String(72000 + i * 1000))),
      ...horses.map((h, i) => row("R2", "2026-01-01", h, i + 1, "60000")),
      ...horses.map((h, i) => row("R3", "2026-01-05", h, i + 1, null)),
    ]);
    const names = ["chronoBest", "chronoLast", "chronoMissing"] as const;
    const chrono = (r: number) => computeFeatures(races[r].field, "Trot", names, races[r].context);
    // Jour même : ni le chrono de la course, ni celui d'une course plus tôt le même jour.
    assert.deepEqual(chrono(1)[0], [0, 0, 1]);
    // Plus tard : meilleur chrono 60"0 pour tous (écart nul) ; dernier chrono de A 72"0 contre 73"5 en moyenne.
    assert.equal(races[2].field[0].history?.bestKm, 60);
    assert.deepEqual(chrono(2)[0], [0, 1.5, 0]);
    // Au plat, la variable reste nulle même avec un historique chronométré.
    assert.deepEqual(computeFeatures(races[2].field, "Plat", names, races[2].context)[0], [0, 0, 0]);
  });
});

// ─── Logit éclaté ────────────────────────────────────────────────────────────

describe("logit éclaté", () => {
  const d = 2;
  const race = (rows: number[][], order: number[]): RankedRace => ({ z: Float64Array.from(rows.flat()), n: rows.length, order });
  const races = [
    race([[1, 0], [0, 1], [-1, 0], [0, -1]], [0, 1, 2]),
    race([[0.5, 0.5], [2, -1], [-0.5, 1], [0, 0], [1, 1]], [1, 4, 0]),
    race([[0, 0], [1, 2], [-1, -1]], [2, 0, 1]),
  ];

  it("perte d'un exemple jouet calculée à la main", () => {
    const { loss } = explodedObjective([race([[1], [0], [-1]], [0, 1])], 1, [0], 0, [1, 0.5]);
    // β = 0 : étape 1 log 3, étape 2 log 2 pondérée 0,5.
    assert.ok(Math.abs(loss - (Math.log(3) + 0.5 * Math.log(2))) < 1e-12);
  });

  it("gradient et hessienne = différences finies", () => {
    const beta = [0.3, -0.7];
    const lambda = 0.01;
    const { grad, hess } = explodedObjective(races, d, beta, lambda);
    const h = 1e-6;
    for (let j = 0; j < d; j++) {
      const up = [...beta];
      const dn = [...beta];
      up[j] += h;
      dn[j] -= h;
      const fd = (explodedObjective(races, d, up, lambda).loss - explodedObjective(races, d, dn, lambda).loss) / (2 * h);
      assert.ok(Math.abs(fd - grad[j]) < 1e-6, `grad ${j}: ${fd} vs ${grad[j]}`);
      const gUp = explodedObjective(races, d, up, lambda).grad;
      const gDn = explodedObjective(races, d, dn, lambda).grad;
      for (let k = 0; k < d; k++) {
        const fdh = (gUp[k] - gDn[k]) / (2 * h);
        assert.ok(Math.abs(fdh - hess![j * d + k]) < 1e-5, `hess ${j},${k}`);
      }
    }
  });

  it("une seule étape = logit conditionnel sur le gagnant", () => {
    const beta = [0.2, 0.4];
    const { loss } = explodedObjective(races, d, beta, 0, [1]);
    let expected = 0;
    for (const r of races) {
      const eta = Array.from({ length: r.n }, (_, i) => beta[0] * r.z[i * d] + beta[1] * r.z[i * d + 1]);
      expected += Math.log(eta.reduce((s, e) => s + Math.exp(e), 0)) - eta[r.order[0]];
    }
    assert.ok(Math.abs(loss - expected / races.length) < 1e-12);
  });

  it("Newton annule le gradient et Cholesky résout le système", () => {
    const { beta } = fitExplodedLogit(races, d, { lambda: 0.05 });
    const { grad } = explodedObjective(races, d, beta, 0.05);
    assert.ok(Math.hypot(...grad) < 1e-6, `|grad| = ${Math.hypot(...grad)}`);
    const x = choleskySolve(Float64Array.from([4, 2, 2, 3]), Float64Array.from([2, 1]), 2);
    assert.ok(Math.abs(4 * x[0] + 2 * x[1] - 2) < 1e-12 && Math.abs(2 * x[0] + 3 * x[1] - 1) < 1e-12);
  });
});
