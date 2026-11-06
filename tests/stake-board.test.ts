import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { aiStrengthScore, buildStakeBoard, type StakeReading } from "../src/lib/stake-board";

function reading(rows: Array<[number, number | null, number | null]>): StakeReading {
  return {
    numbers: rows.map((r) => r[0]),
    stakeOffline: rows.map((r) => r[1]),
    stakeOnline: rows.map((r) => r[2]),
    oddsOffline: rows.map(() => 5),
    oddsOnline: rows.map(() => 6),
  };
}

describe("buildStakeBoard", () => {
  const baseline = { minutes: 5, reading: reading([[1, 1000, 100], [2, 800, 200], [3, 100, 0]]) };

  it("additionne les deux sources et classe par argent reçu", () => {
    const board = buildStakeBoard({ live: reading([[1, 1100, 100], [2, 1200, 300], [3, 400, 0]]), baseline });
    assert.deepEqual(board.runners.map((r) => r.number), [2, 3, 1]);
    assert.equal(board.runners[0].total, 1500);
    assert.equal(board.runners[0].delta, 500);
    assert.equal(board.totalStake, 3100);
    assert.equal(board.windowMinutes, 5);
  });

  it("met une flèche rouge au cheval qui reçoit moins vite que la course", () => {
    const board = buildStakeBoard({ live: reading([[1, 1100, 100], [2, 1200, 300], [3, 400, 0]]), baseline });
    const one = board.runners.find((r) => r.number === 1)!;
    assert.equal(one.delta, 100);
    assert.equal(one.trend, "down");
    assert.equal(board.runners[0].trend, "up");
  });

  it("met une flèche rouge à un cheval sans nouvelle mise quand la course en reçoit", () => {
    const board = buildStakeBoard({ live: reading([[1, 1000, 100], [2, 900, 200], [3, 100, 0]]), baseline });
    assert.equal(board.runners.find((r) => r.number === 1)!.trend, "down");
  });

  it("reste stable quand rien ne bouge", () => {
    const board = buildStakeBoard({ live: baseline.reading, baseline });
    assert.ok(board.runners.every((r) => r.trend === "flat" && r.delta === 0));
  });

  it("sans relevé assez ancien, classe par mises cumulées et n'invente aucune évolution", () => {
    const board = buildStakeBoard({ live: reading([[1, 100, null], [2, 900, 50], [3, null, null]]) });
    assert.deepEqual(board.runners.map((r) => r.number), [2, 1, 3]);
    assert.ok(board.runners.every((r) => r.delta === null && r.trend === null));
    assert.equal(board.windowMinutes, null);
    assert.equal(board.runners[2].total, null);
  });

  it("ne compte pas dans la comparaison un cheval absent du relevé précédent", () => {
    const board = buildStakeBoard({ live: reading([[1, 1100, 100], [4, 5000, 0]]), baseline });
    const added = board.runners.find((r) => r.number === 4)!;
    assert.equal(added.delta, null);
    assert.equal(board.runners[0].number, 1);
    // Masse comparée : le seul n° 1, de 1 100 € à 1 200 €.
    assert.ok(Math.abs(board.poolDeltaPct! - (100 / 1100) * 100) < 1e-9);
  });

  it("lit la cote du matin figée, numéro par numéro", () => {
    const board = buildStakeBoard({
      live: reading([[2, 1, 1], [1, 1, 1]]),
      morning: { numbers: [1, 2], refOffline: [3.5, 7], refOnline: [4, null] },
    });
    const two = board.runners.find((r) => r.number === 2)!;
    assert.equal(two.morningOffline, 7);
    assert.equal(two.morningOnline, null);
  });
});

describe("aiStrengthScore", () => {
  it("vaut 50 à chance égale et gagne 14 points quand la chance double", () => {
    assert.equal(aiStrengthScore(10, 10), 50);
    assert.equal(aiStrengthScore(20, 10), 64);
    assert.equal(aiStrengthScore(5, 10), 36);
  });

  it("reste entre 1 et 99", () => {
    assert.equal(aiStrengthScore(90, 20), 99);
    assert.equal(aiStrengthScore(0.001, 8), 1);
  });

  it("ne note pas sans probabilité", () => {
    assert.equal(aiStrengthScore(null, 10), null);
    assert.equal(aiStrengthScore(0, 10), null);
    assert.equal(aiStrengthScore(NaN, 10), null);
  });
});
