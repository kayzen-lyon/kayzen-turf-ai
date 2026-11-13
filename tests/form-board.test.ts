import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildFormBoard, bestChrono, formRating, formatKmTime, formatRaceTime, weightReading, type BoardRunner } from "../src/lib/performances/form-board";
import { parsePerformances, type DetailedRun } from "../src/lib/performances/pmu-performances";

function run(over: Partial<DetailedRun>): DetailedRun {
  return {
    date: "2026-10-20",
    racecourse: "AUTEUIL",
    raceName: "PRIX TEST",
    discipline: "haies",
    distance: 3600,
    going: "Très souple",
    fieldSize: 12,
    position: 3,
    status: null,
    weightKg: 68,
    kmTimeMs: 76_000,
    ...over,
  };
}

describe("parsePerformances — réponse PMU performances-detaillees", () => {
  const payload = {
    participants: [
      {
        numPmu: 4,
        coursesCourues: [
          {
            date: Date.parse("2026-10-03T12:00:00Z"),
            timezoneOffset: 7_200_000,
            hippodrome: "AUTEUIL",
            nomPrix: "PRIX ROYAL JUNIOR",
            discipline: "HAIE",
            distance: 3500,
            nbParticipants: 14,
            tempsDuPremier: 264_530,
            etatTerrain: "Très souple",
            participants: [
              { numPmu: 2, place: { place: 1, rawValue: "DP", statusArrivee: "PLACE" }, itsHim: false, poidsJockey: 69, reductionKilometrique: 75_580 },
              { numPmu: 7, place: { place: 4, rawValue: "DP", statusArrivee: "PLACE" }, itsHim: true, poidsJockey: 67, reductionKilometrique: 76_100 },
            ],
          },
          {
            date: Date.parse("2026-09-01T12:00:00Z"),
            timezoneOffset: 7_200_000,
            hippodrome: "VINCENNES",
            discipline: "ATTELE",
            distance: 2700,
            nbParticipants: 12,
            tempsDuPremier: 204_300,
            participants: [{ numPmu: 2, place: { place: null, rawValue: "AI", statusArrivee: "DISQUALIFIE_POUR_ALLURE_IRREGULIERE" }, itsHim: true, poidsJockey: null, reductionKilometrique: null, distanceParcourue: 2725 }],
          },
          // Vainqueur sans réduction publiée : le chrono se déduit du temps du premier.
          { date: Date.parse("2026-08-01T12:00:00Z"), hippodrome: "SHA TIN", discipline: "PLAT", distance: 1200, nbParticipants: 14, tempsDuPremier: 69_600, participants: [{ place: { place: 1 }, itsHim: true, poidsJockey: 57.5 }] },
          // Course sans le cheval repéré : ignorée.
          { date: 1, hippodrome: "X", discipline: "PLAT", distance: 1600, participants: [{ place: { place: 1 }, itsHim: false }] },
        ],
      },
    ],
  };

  it("garde date, hippodrome, terrain, place, poids et chrono du cheval", () => {
    const runs = parsePerformances(payload).get(4)!;
    assert.equal(runs.length, 3);
    assert.deepEqual(runs[0], {
      date: "2026-10-03",
      racecourse: "AUTEUIL",
      raceName: "PRIX ROYAL JUNIOR",
      discipline: "haies",
      distance: 3500,
      going: "Très souple",
      fieldSize: 14,
      position: 4,
      status: null,
      weightKg: 67,
      kmTimeMs: 76_100,
    });
  });

  it("lit la distance parcourue au trot et le motif de non-classement", () => {
    const trot = parsePerformances(payload).get(4)![1];
    assert.equal(trot.discipline, "attele");
    assert.equal(trot.distance, 2725);
    assert.equal(trot.position, null);
    assert.equal(trot.status, "AI");
    assert.equal(trot.kmTimeMs, null);
  });

  it("déduit le chrono du vainqueur du temps du premier", () => {
    const winner = parsePerformances(payload).get(4)![2];
    assert.equal(winner.kmTimeMs, 58_000);
    assert.equal(winner.weightKg, 57.5);
  });

  it("rend une liste vide sur une réponse illisible", () => {
    assert.equal(parsePerformances(null).size, 0);
    assert.equal(parsePerformances({ participants: "x" }).size, 0);
  });
});

describe("formatage des chronos", () => {
  it("écrit la réduction kilométrique et le temps total", () => {
    assert.equal(formatKmTime(75_580), "1'15\"6");
    assert.equal(formatKmTime(58_000), "58\"0");
    assert.equal(formatKmTime(null), "—");
    assert.equal(formatRaceTime(264_530), "4'24\"5");
  });
});

describe("bestChrono — meilleur chrono sur la distance du jour", () => {
  const today = { discipline: "Obstacle" as const, specialty: "Haies", distance: 3600 };

  it("retient le plus rapide parmi les courses de même spécialité et de distance proche", () => {
    const best = bestChrono(
      [
        run({ date: "2026-10-20", distance: 3500, kmTimeMs: 76_100 }),
        run({ date: "2026-09-10", distance: 3600, kmTimeMs: 75_200, racecourse: "COMPIEGNE", going: "Bon" }),
        run({ date: "2026-08-01", distance: 4400, kmTimeMs: 70_000 }), // trop loin de la distance
        run({ date: "2026-07-01", distance: 3600, kmTimeMs: 71_000, discipline: "steeple" }), // autre spécialité
        run({ date: "2026-06-01", distance: 3600, kmTimeMs: null }),
      ],
      today,
    );
    assert.equal(best?.kmTimeMs, 75_200);
    assert.equal(best?.racecourse, "COMPIEGNE");
    assert.equal(best?.going, "Bon");
    assert.equal(best?.totalMs, 270_720);
  });

  it("rend null sans course chronométrée sur la distance", () => {
    assert.equal(bestChrono([run({ distance: 4400 })], today), null);
    assert.equal(bestChrono([], today), null);
  });

  it("ne mélange pas trot attelé et trot monté", () => {
    const trot = { discipline: "Trot" as const, specialty: "Attelé", distance: 2700 };
    const runs = [run({ discipline: "monte", distance: 2700, kmTimeMs: 73_000 }), run({ discipline: "attele", distance: 2850, kmTimeMs: 74_500 })];
    assert.equal(bestChrono(runs, trot)?.kmTimeMs, 74_500);
  });
});

describe("weightReading — poids du jour face aux dernières courses", () => {
  it("signale un cheval allégé ou chargé d'au moins un kilo", () => {
    const runs = [run({ weightKg: 68 }), run({ weightKg: 69 }), run({ weightKg: 70 }), run({ weightKg: 60 })];
    assert.deepEqual(weightReading(66, runs), { todayKg: 66, recent: [68, 69, 70], referenceKg: 69, deltaKg: -3, trend: "allege" });
    assert.equal(weightReading(71, runs).trend, "charge");
    assert.equal(weightReading(69.5, runs).trend, "stable");
  });

  it("ne conclut rien sans poids du jour ou sans poids passés", () => {
    assert.equal(weightReading(null, [run({})]).trend, null);
    assert.equal(weightReading(66, [run({ weightKg: null })]).trend, null);
  });
});

describe("formRating — indicateur de forme", () => {
  const today = "2026-11-14";

  it("classe en bonne forme un cheval régulier, en progrès et frais", () => {
    const rating = formRating(
      [
        run({ date: "2026-10-28", position: 1 }),
        run({ date: "2026-10-05", position: 2 }),
        run({ date: "2026-09-10", position: 4 }),
        run({ date: "2026-08-15", position: 6 }),
      ],
      today,
    );
    assert.equal(rating.level, "bonne");
    assert.equal(rating.daysSinceLast, 17);
    assert.ok(rating.score! >= 70);
  });

  it("classe en mauvaise forme un cheval en baisse qui ne finit plus ses courses", () => {
    const rating = formRating(
      [
        run({ date: "2026-11-10", position: null, status: "T" }),
        run({ date: "2026-10-30", position: 11 }),
        run({ date: "2026-10-01", position: 10 }),
        run({ date: "2026-09-01", position: 5 }),
      ],
      today,
    );
    assert.equal(rating.level, "mauvaise");
    assert.ok(rating.score! < 45);
  });

  it("pénalise une rentrée après une longue absence", () => {
    const fresh = formRating([run({ date: "2026-10-28", position: 2 }), run({ date: "2026-10-01", position: 2 })], today);
    const back = formRating([run({ date: "2026-05-01", position: 2 }), run({ date: "2026-04-01", position: 2 })], today);
    assert.ok(back.score! < fresh.score!);
    assert.ok(back.reasons.some((reason) => reason.includes("rentrée")));
  });

  it("ne note pas un cheval sans course connue, et ignore les courses du jour ou postérieures", () => {
    assert.deepEqual(formRating([], today).level, "inconnue");
    assert.equal(formRating([run({ date: "2026-11-14", position: 1 })], today).level, "inconnue");
  });
});

describe("buildFormBoard — tableau de la course", () => {
  const race = { date: "2026-11-14", discipline: "Obstacle" as const, specialty: "Haies", distance: 3600 };
  const runner = (number: number, over: Partial<BoardRunner> = {}): BoardRunner => ({
    number,
    name: `CHEVAL ${number}`,
    jockey: "J",
    trainer: "E",
    odds: 5,
    weightKg: 67,
    nonRunner: false,
    ...over,
  });

  it("classe du meilleur chrono au moins bon, les chevaux sans chrono à la fin", () => {
    const board = buildFormBoard(
      race,
      [runner(1), runner(2), runner(3), runner(4, { nonRunner: true })],
      new Map([
        [1, [run({ kmTimeMs: 76_500 })]],
        [2, [run({ kmTimeMs: 75_000 })]],
        [3, [run({ distance: 4400 })]],
        [4, [run({ kmTimeMs: 70_000 })]],
      ]),
    );
    assert.deepEqual(board.rows.map((row) => row.number), [2, 1, 3]);
    assert.deepEqual(board.rows.map((row) => row.chronoRank), [1, 2, null]);
    assert.equal(board.timed, 2);
    assert.equal(board.fastest?.number, 2);
  });

  it("repère un cheval rapide et en forme que le marché ne place pas dans ses trois premiers", () => {
    const good = [run({ date: "2026-10-28", position: 1, kmTimeMs: 74_000 }), run({ date: "2026-10-05", position: 2 }), run({ date: "2026-09-10", position: 3 })];
    const board = buildFormBoard(
      race,
      [runner(1, { odds: 2 }), runner(2, { odds: 3 }), runner(3, { odds: 4 }), runner(4, { odds: 18 })],
      new Map([
        [1, [run({ kmTimeMs: 77_000 })]],
        [2, [run({ kmTimeMs: 77_500 })]],
        [3, [run({ kmTimeMs: 78_000 })]],
        [4, good],
      ]),
    );
    assert.deepEqual(board.overlooked.map((row) => row.number), [4]);
  });
});
