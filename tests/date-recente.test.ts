import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { schemaDate, schemaDateRecente } from "../src/lib/validation";

function jour(decalage: number) {
  const [a, m, j] = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date()).split("-").map(Number);
  return new Date(Date.UTC(a!, m! - 1, j! + decalage)).toISOString().slice(0, 10);
}

describe("schemaDateRecente", () => {
  it("accepte la semaine passée et la semaine à venir", () => {
    for (const d of [-7, -1, 0, 1, 7]) assert.equal(schemaDateRecente.safeParse(jour(d)).success, true, `J${d}`);
  });

  it("refuse l'historique ancien, que schemaDate accepte encore", () => {
    assert.equal(schemaDate.safeParse(jour(-30)).success, true);
    assert.equal(schemaDateRecente.safeParse(jour(-8)).success, false);
    assert.equal(schemaDateRecente.safeParse("2024-03-01").success, false);
  });

  it("garde les contrôles de schemaDate", () => {
    assert.equal(schemaDateRecente.safeParse(jour(8)).success, false);
    assert.equal(schemaDateRecente.safeParse("2026-02-31").success, false);
  });
});
