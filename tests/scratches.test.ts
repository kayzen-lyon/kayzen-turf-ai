import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stagesFor } from "../src/lib/live/freeze";
import { planScratches } from "../src/lib/live/refresh-race";

describe("planScratches", () => {
  it("retire les non-partants déclarés par le PMU", () => {
    assert.deepEqual(planScratches([1, 2, 3, 4, 5, 6, 7, 8], [3]), [3]);
    // Petit peloton : 6 chevaux dont 2 retirés.
    assert.deepEqual(planScratches([1, 2, 3, 4, 5, 6], [3, 5]), [3, 5]);
  });

  it("ne retire jamais un cheval simplement absent d'une réponse incomplète", () => {
    // Le PMU liste 8 chevaux sur 10, tous partants : rien n'est déclaré.
    assert.deepEqual(planScratches([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], []), []);
  });

  it("ignore les numéros illisibles ou inconnus de la course", () => {
    assert.deepEqual(planScratches([1, 2, 3, 4], [Number.NaN, 0, 12, 2.5]), []);
    assert.deepEqual(planScratches([1, 2, 3, 4], [2, 2, Number.NaN]), [2]);
  });

  it("ignore une déclaration en masse, signe d'une réponse anormale", () => {
    assert.deepEqual(planScratches([1, 2, 3, 4, 5, 6], [1, 2, 3, 4]), []);
    assert.deepEqual(planScratches([1, 2, 3, 4, 5, 6], [1, 2, 3]), [1, 2, 3]);
  });

  it("ne retire rien quand tout le monde court", () => {
    assert.deepEqual(planScratches([1, 2, 3], []), []);
  });
});

describe("non-partant tardif et gel H-2", () => {
  it("réécrit H-2 à chaque passage du dernier quart d'heure, donc avec le peloton réduit", () => {
    for (let minutes = 0.5; minutes <= 15; minutes += 0.5) assert.ok(stagesFor(minutes).includes("H-2"), `${minutes} min`);
  });
});
