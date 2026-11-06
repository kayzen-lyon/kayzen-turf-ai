// Tests des fonctions pures de scripts/lib/pmu-integrity.mjs : gel des données
// d'avant-course, ex aequo, musique, type de départ.
// Lancer : npm test  (node --test, sans framework)

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ENTRY_COLUMNS,
  arrivalPlacings,
  blinkersFromParticipant,
  entryUpsertParams,
  entryUpsertSql,
  realizedKm,
  hasRaceStarted,
  parseMusicSignal,
  preRaceConnectionStats,
  prizeFromCourse,
  startTypeFromCourse,
  tokenizeMusic,
} from "../scripts/lib/pmu-integrity.mjs";
import { tokenizeMusic as tokenizeMusicTs } from "../src/lib/prediction-math.ts";

describe("arrivalPlacings — ex aequo", () => {
  it("numérote une arrivée sans ex aequo", () => {
    assert.deepEqual(arrivalPlacings([[2], [11], [16]]), [
      { number: 2, position: 1, won: true },
      { number: 11, position: 2, won: false },
      { number: 16, position: 3, won: false },
    ]);
  });

  it("donne la place du groupe à tous les ex aequo, le suivant saute une place", () => {
    assert.deepEqual(arrivalPlacings([[2], [11, 16], [4]]), [
      { number: 2, position: 1, won: true },
      { number: 11, position: 2, won: false },
      { number: 16, position: 2, won: false },
      { number: 4, position: 4, won: false },
    ]);
  });

  it("déclare gagnants tous les chevaux d'un ex aequo pour la victoire", () => {
    const placings = arrivalPlacings([[7, 3], [5]]);
    assert.deepEqual(placings.filter((p) => p.won).map((p) => p.number), [7, 3]);
    assert.equal(placings.find((p) => p.number === 5).position, 3);
  });

  it("tolère des numéros isolés et des entrées vides", () => {
    assert.deepEqual(arrivalPlacings([4, [], [9]]), [
      { number: 4, position: 1, won: true },
      { number: 9, position: 2, won: false },
    ]);
    assert.deepEqual(arrivalPlacings(undefined), []);
  });
});

describe("tokenizeMusic — portage identique au site", () => {
  const samples = [
    "4aDaDa3a0a8a3a0aDaDa",
    "4a6a4a8a5a5a0a(25)8a2a",
    "0a(25)2a1a1a9a9a1aDaDa",
    "Da1aDa0aDm4a6a5aDa6a",
    "7A3A0A198A",
    "1p0p0p0p",
    "Ret3h(24)2s",
    "",
    null,
  ];

  for (const music of samples) {
    it(`même lecture que prediction-math pour « ${music} »`, () => {
      // La version du site garde aussi la lettre de discipline (modèle v2) ;
      // l'import n'en a pas besoin : on compare places et incidents.
      const strip = (tokens) => tokens.map((t) => Object.fromEntries(Object.entries(t).filter(([k]) => k !== "discipline")));
      assert.deepEqual(tokenizeMusic(music), strip(tokenizeMusicTs(music)));
      assert.deepEqual(tokenizeMusic(music, 5), strip(tokenizeMusicTs(music, 5)));
    });
  }

  it("ne compte plus « (25) » comme deux places", () => {
    assert.deepEqual(tokenizeMusic("1a(25)2a"), [
      { kind: "pos", value: 1 },
      { kind: "pos", value: 2 },
    ]);
  });
});

describe("parseMusicSignal", () => {
  it("garde les valeurs par défaut sans musique", () => {
    assert.equal(parseMusicSignal(null), 0.08);
    assert.equal(parseMusicSignal("(25)"), 0.05);
  });

  it("un non-placé (« 0 ») pèse au lieu de disparaître", () => {
    // Ancienne lecture : « 0 » ignoré, la forme valait celle d'un gagnant.
    assert.ok(parseMusicSignal("1a0a0a0a") < parseMusicSignal("1a1a1a1a"));
  });

  it("les incidents comptent comme la plus mauvaise valeur", () => {
    assert.equal(parseMusicSignal("DaDaDa"), 0.02);
  });

  it("l'année « (25) » ne fausse plus la moyenne", () => {
    assert.equal(parseMusicSignal("1a(25)1a"), parseMusicSignal("1a1a"));
  });
});

describe("startTypeFromCourse", () => {
  it("détecte l'autostart dans le texte des conditions", () => {
    const course = { specialite: "TROT_ATTELE", conditions: "PRIX ANGELINA Course E Départ à l'Autostart 35.000. - Attelé, femelles." };
    assert.equal(startTypeFromCourse(course), "autostart");
  });

  it("un trot sans mention part à la volte", () => {
    const course = { specialite: "TROT_ATTELE", conditions: "PRIX BETELGEUSE Course F AMATEURS 12.000. - Attelé. - Recul de 25 m. à 65.000" };
    assert.equal(startTypeFromCourse(course), "volte");
    assert.equal(startTypeFromCourse({ specialite: "TROT_MONTE", conditions: "PRIX X - Monté." }), "volte");
  });

  it("rien hors trot, rien sans conditions", () => {
    assert.equal(startTypeFromCourse({ specialite: "PLAT", conditions: "Autostart" }), null);
    assert.equal(startTypeFromCourse({ specialite: "TROT_ATTELE" }), null);
  });
});

describe("prizeFromCourse", () => {
  it("lit montantPrix en euros", () => {
    assert.equal(prizeFromCourse({ montantPrix: 12000 }), 12000);
    assert.equal(prizeFromCourse({}), null);
    assert.equal(prizeFromCourse({ montantPrix: 0 }), null);
  });
});

describe("hasRaceStarted", () => {
  const now = Date.UTC(2026, 9, 6, 14, 0);

  it("arrivée publiée : partie", () => {
    assert.equal(hasRaceStarted({ heureDepart: now + 3_600_000, ordreArrivee: [[1]] }, now), true);
  });

  it("heure passée : partie ; heure à venir : non", () => {
    assert.equal(hasRaceStarted({ heureDepart: now - 60_000 }, now), true);
    assert.equal(hasRaceStarted({ heureDepart: now + 60_000, ordreArrivee: [] }, now), false);
  });

  it("heure illisible et pas d'arrivée : non partie", () => {
    assert.equal(hasRaceStarted({}, now), false);
  });
});

describe("blinkersFromParticipant", () => {
  it("ne prend jamais le déferrage pour des œillères", () => {
    assert.equal(blinkersFromParticipant({ deferre: "DEFERRE_ANTERIEURS" }), null);
    assert.equal(blinkersFromParticipant({ oeilleres: "OEILLERES_AUSTRALIENNES", deferre: "DEFERRE_ANTERIEURS" }), "OEILLERES_AUSTRALIENNES");
    assert.equal(blinkersFromParticipant({ oeilleres: "SANS_OEILLERES" }), "SANS_OEILLERES");
  });
});

describe("preRaceConnectionStats", () => {
  const stats = new Map([
    ["jockey j1", { runs: 120, wins: 18 }],
    ["trainer t1", { runs: 40, wins: 5 }],
  ]);

  it("copie les totaux connus tant que la course n'est pas partie", () => {
    assert.deepEqual(preRaceConnectionStats(stats, "j1", "t1", false), {
      jockeyRunsPre: 120,
      jockeyWinsPre: 18,
      trainerRunsPre: 40,
      trainerWinsPre: 5,
    });
  });

  it("n'écrit rien pour une course partie (les totaux contiennent l'avenir)", () => {
    assert.deepEqual(preRaceConnectionStats(stats, "j1", "t1", true), {
      jockeyRunsPre: null,
      jockeyWinsPre: null,
      trainerRunsPre: null,
      trainerWinsPre: null,
    });
  });
});

describe("entryUpsertSql — gel des données d'avant-course", () => {
  const frozen = ["music", "earnings", "equipment", "blinkers", "weight", "draw", "shoeing", "odds", "odds_source", "win_probability", "kz_score", "factors"];

  it("course pas partie : tout est rafraîchi", () => {
    const query = entryUpsertSql(false);
    for (const column of frozen) assert.match(query, new RegExp(`\\b${column} = excluded\\.${column}\\b`), column);
  });

  it("course partie : l'origine de la cote suit la cote gelée", () => {
    assert.match(entryUpsertSql(true), /odds_source = case when entries\.odds is null then excluded\.odds_source else entries\.odds_source end/);
  });

  it("course partie : les valeurs en base sont conservées, seules les vides sont complétées", () => {
    const query = entryUpsertSql(true);
    for (const column of frozen.filter((c) => c !== "odds_source")) assert.match(query, new RegExp(`\\b${column} = coalesce\\(entries\\.${column}, excluded\\.${column}\\)`), column);
  });

  it("réduction kilométrique et speed_figure : la première valeur fait foi, partie ou non", () => {
    for (const started of [false, true]) {
      const query = entryUpsertSql(started);
      assert.match(query, /reduction_km = coalesce\(entries\.reduction_km, excluded\.reduction_km\)/);
      assert.match(query, /speed_figure = coalesce\(entries\.speed_figure, excluded\.speed_figure\)/);
    }
  });

  it("chrono réalisé : la dernière valeur publiée, sans effacer la précédente", () => {
    for (const started of [false, true]) {
      assert.match(entryUpsertSql(started), /realized_km = coalesce\(excluded\.realized_km, entries\.realized_km\)/);
    }
  });

  it("chrono réalisé : rien sans arrivée, rien hors plage", () => {
    const arrival = [[3], [1]];
    assert.equal(realizedKm({ reductionKilometrique: 74300 }, arrival), 74300);
    assert.equal(realizedKm({ reductionKilometrique: 74300 }, []), null);
    assert.equal(realizedKm({ reductionKilometrique: 74300 }, undefined), null);
    assert.equal(realizedKm({ reductionKilometrique: 0 }, arrival), null);
    assert.equal(realizedKm({}, arrival), null);
  });

  it("statistiques d'avant-course : la plus récente, sans jamais effacer la valeur figée", () => {
    assert.match(entryUpsertSql(true), /jockey_runs_pre = coalesce\(excluded\.jockey_runs_pre, entries\.jockey_runs_pre\)/);
  });

  it("l'identité du partant (driver, entraîneur) reste à jour", () => {
    assert.match(entryUpsertSql(true), /jockey_id = excluded\.jockey_id/);
  });

  it("un paramètre par colonne, dans l'ordre", () => {
    const query = entryUpsertSql(false);
    assert.ok(query.includes(`$${ENTRY_COLUMNS.length})`));
    const values = Object.fromEntries(ENTRY_COLUMNS.map((column, index) => [column, index]));
    assert.deepEqual(entryUpsertParams(values), ENTRY_COLUMNS.map((_, index) => index));
    assert.throws(() => entryUpsertParams({ id: "x" }), /manquante/);
  });
});
