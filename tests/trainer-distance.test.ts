import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rankTrainers, TRAINER_MIN_RUNS, type TrainerDistanceRow } from "../src/lib/performances/trainer-distance";

const row = (name: string, runs: number, wins: number, places: number, numbers: number[] = [1]): TrainerDistanceRow => ({
  trainerId: name,
  name,
  numbers,
  runs,
  wins,
  places,
});

describe("rankTrainers — entraîneurs sur la distance", () => {
  it("classe par taux de victoire, puis par taux de places", () => {
    const ranked = rankTrainers([row("A", 20, 2, 8), row("B", 10, 3, 4), row("C", 40, 4, 20)]);
    assert.deepEqual(ranked.map((r) => r.name), ["B", "C", "A"]);
    assert.deepEqual(ranked.map((r) => r.rank), [1, 2, 3]);
    assert.equal(ranked[0].winRate, 30);
    assert.equal(ranked[0].placeRate, 40);
    assert.equal(ranked[0].reliable, true);
  });

  it("ne classe pas un entraîneur sur trop peu de courses devant les autres", () => {
    const ranked = rankTrainers([row("Chanceux", TRAINER_MIN_RUNS - 1, TRAINER_MIN_RUNS - 1, TRAINER_MIN_RUNS - 1), row("Solide", 30, 6, 15), row("Inconnu", 0, 0, 0)]);
    assert.deepEqual(ranked.map((r) => r.name), ["Solide", "Chanceux", "Inconnu"]);
    assert.deepEqual(ranked.map((r) => r.rank), [1, null, null]);
    assert.equal(ranked[1].reliable, false);
    assert.equal(ranked[2].winRate, null);
  });

  it("garde les numéros des chevaux de chaque entraîneur dans la course", () => {
    assert.deepEqual(rankTrainers([row("A", 12, 1, 3, [7, 2])])[0].numbers, [2, 7]);
  });
});
