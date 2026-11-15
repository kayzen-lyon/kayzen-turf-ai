import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildOperatorTable, compareOperators, rankByOdds, type OddsSnapshot } from "../src/lib/operator-board";

const START = "2026-11-16T15:05:00.000Z";
const at = (minutesBeforeStart: number) => new Date(Date.parse(START) - minutesBeforeStart * 60_000).toISOString();

function snap(minutesBeforeStart: number, odds: Array<number | null>, extra: Partial<OddsSnapshot> = {}): OddsSnapshot {
  return { observedAt: at(minutesBeforeStart), numbers: [1, 2, 3, 4], odds, ...extra };
}

describe("rankByOdds", () => {
  it("classe de la plus petite cote à la plus grande, sans rang pour une cote absente", () => {
    assert.deepEqual([...rankByOdds([1, 2, 3, 4], [5, 2.5, null, 2.5])], [[2, 1], [4, 2], [1, 3]]);
  });
});

describe("buildOperatorTable", () => {
  const snapshots = [snap(300, [3.8, 5.5, 6, 7.2]), snap(60, [3.4, 5.2, 6.4, 7]), snap(1.5, [3.1, 5, 6.5, 4.9])];

  it("garde le classement du matin et le compare au classement actuel", () => {
    const table = buildOperatorTable({ snapshots, startAt: START });
    assert.deepEqual(table.rows.map((r) => r.number), [1, 4, 2, 3]);
    const four = table.rows.find((r) => r.number === 4)!;
    assert.equal(four.morningOdds, 7.2);
    assert.equal(four.morningRank, 4);
    assert.equal(four.currentOdds, 4.9);
    assert.equal(four.currentRank, 2);
    assert.equal(four.rankGain, 2);
    assert.equal(four.direction, "baisse");
    assert.equal(four.change, -2.3);
    assert.equal(table.morningAt, at(300));
    assert.equal(table.currentAt, at(1.5));
  });

  it("signale une hausse, et tient un écart infime pour stable", () => {
    const table = buildOperatorTable({ snapshots: [snap(300, [3.8, 5.5, 6, 7.2]), snap(30, [3.8, 5.5, 6.5, 7.2])], startAt: START });
    assert.equal(table.rows.find((r) => r.number === 3)!.direction, "hausse");
    assert.equal(table.rows.find((r) => r.number === 3)!.change, 0.5);
    assert.equal(table.rows.find((r) => r.number === 1)!.direction, "stable");
  });

  it("ne remplit le classement final qu'avec un relevé des deux dernières minutes", () => {
    const early = buildOperatorTable({ snapshots: snapshots.slice(0, 2), startAt: START });
    assert.equal(early.finalAt, null);
    assert.ok(early.rows.every((r) => r.finalRank === null && r.finalOdds === null));

    const late = buildOperatorTable({ snapshots, startAt: START });
    assert.equal(late.finalAt, at(1.5));
    assert.deepEqual(late.rows.map((r) => r.finalRank), [1, 2, 3, 4]);
  });

  it("ignore un relevé fait après le départ, sauf s'il est marqué comme cote de clôture", () => {
    const after = snap(-10, [9, 9, 9, 2]);
    const ignored = buildOperatorTable({ snapshots: [...snapshots, after], startAt: START });
    assert.equal(ignored.rows.find((r) => r.number === 4)!.currentOdds, 4.9);

    const closing = buildOperatorTable({ snapshots: [...snapshots.slice(0, 2), { ...after, closing: true }], startAt: START });
    assert.equal(closing.rows.find((r) => r.number === 4)!.finalRank, 1);
    assert.equal(closing.rows.find((r) => r.number === 4)!.currentOdds, 2);
  });

  it("prend la cote de référence publiée par l'opérateur comme cote du matin", () => {
    const table = buildOperatorTable({ snapshots: [snap(20, [3, 5, 6, 7], { reference: [4, 4.5, null, 8] })], startAt: START });
    const one = table.rows.find((r) => r.number === 1)!;
    assert.equal(one.morningOdds, 4);
    assert.equal(one.morningRank, 1);
    assert.equal(table.rows.find((r) => r.number === 3)!.morningRank, null);
    assert.equal(table.morningAt, null);
    assert.equal(table.morningFromOperator, true);
  });

  it("n'appelle pas « matin » un unique relevé : pas d'évolution à afficher", () => {
    const table = buildOperatorTable({ snapshots: [snap(20, [3, 5, 6, 7])], startAt: START });
    assert.ok(table.rows.every((r) => r.morningOdds === null && r.direction === null));
    assert.equal(table.rows[0].currentOdds, 3);
  });

  it("retire les non-partants et rend un tableau vide sans relevé", () => {
    const table = buildOperatorTable({ snapshots, startAt: START, nonRunners: [1] });
    assert.deepEqual(table.rows.map((r) => r.number), [4, 2, 3]);
    assert.equal(table.rows[0].currentRank, 1);
    assert.deepEqual(buildOperatorTable({ snapshots: [], startAt: START }).rows, []);
  });
});

describe("compareOperators", () => {
  it("met côte à côte le rang actuel de chaque opérateur et repère la meilleure cote", () => {
    const pmu = buildOperatorTable({ snapshots: [snap(5, [3, 5, 6, 7])], startAt: START });
    const zeturf = buildOperatorTable({ snapshots: [snap(5, [3.4, 4.2, 6.5, null])], startAt: START });
    const rows = compareOperators([{ key: "pmu", table: pmu }, { key: "zeturf", table: zeturf }]);
    const two = rows.find((r) => r.number === 2)!;
    assert.deepEqual(two.ranks, { pmu: 2, zeturf: 2 });
    assert.deepEqual(two.best, { key: "pmu", odds: 5 });
    assert.equal(two.rankSpread, 0);
    const four = rows.find((r) => r.number === 4)!;
    assert.deepEqual(four.ranks, { pmu: 4, zeturf: null });
    assert.equal(four.rankSpread, null);
  });
});
