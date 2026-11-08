import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { PressHorse } from "../src/lib/press-consensus";
import { pressComment, pressSummary, type PressSummaryInput } from "../src/lib/press-summary";

function row(number: number, ai: number | null, ranks: number[], sources = 4, category: PressHorse["category"] = null): PressSummaryInput {
  const citations = ranks.map((rank, i) => ({ source: `s${i}`, rank }));
  const meanRank = ranks.length ? ranks.reduce((a, b) => a + b, 0) / ranks.length : null;
  return {
    number,
    name: `Cheval ${number}`,
    ai,
    press: { number, citations, sources, share: ranks.length / sources, sitesScore: ranks.length / sources, meanRank, marketRank: null, market: null, category },
  };
}

describe("pressSummary", () => {
  const rows = [row(1, 10, [1, 1, 2, 1]), row(2, 30, [2, 3]), row(3, 25, []), row(4, 5, [3, 2, 1, 2]), row(5, null, [5])];

  test("classe la presse par citations puis rang moyen", () => {
    const s = pressSummary(rows);
    assert.deepEqual(s.rows.map((r) => r.number), [1, 4, 2, 5, 3]);
    assert.deepEqual(s.topPress.map((r) => r.number), [1, 4, 2]);
  });

  test("classe l'IA sans les chevaux sans probabilité", () => {
    const s = pressSummary(rows);
    assert.deepEqual(s.topAi.map((r) => r.number), [2, 3, 1]);
    assert.equal(s.aiRank.has(5), false);
  });

  test("retient le moins cité des quatre premiers de l'IA", () => {
    assert.equal(pressSummary(rows).watch?.number, 3);
  });

  test("ne signale personne quand l'IA et la presse s'accordent", () => {
    assert.equal(pressSummary([row(1, 40, [1, 1, 1, 1]), row(2, 30, [2, 2, 2])]).watch, null);
  });

  test("le top presse n'inclut jamais un cheval que personne ne cite", () => {
    assert.deepEqual(pressSummary([row(1, 40, []), row(2, 30, [])]).topPress, []);
  });
});

describe("pressComment", () => {
  test("donne la priorité à la famille presse × marché", () => {
    assert.equal(pressComment(row(1, 30, [1, 1, 1, 1], 4, "consensus"), 1), "Presse et marché d'accord");
  });

  test("décrit la présence dans la presse et l'avis de l'IA", () => {
    assert.equal(pressComment(row(1, 30, [], 4), 2), "Peu cité, bien vu par l'IA");
    assert.equal(pressComment(row(1, 5, [1, 2, 3, 4]), 9), "Cité par tous les sites");
    assert.equal(pressComment(row(1, 5, [1, 2, 3]), 9), "Très cité par la presse");
    assert.equal(pressComment(row(1, 5, []), 9), "Absent des sélections");
    assert.equal(pressComment(row(1, 5, [1, 2]), 9), "");
  });
});
