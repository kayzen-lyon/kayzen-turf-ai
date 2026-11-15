import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { oddsDue, parseGenyOdds, parseZeturfOdds } from "../scripts/lib/press-sources/odds.mjs";

describe("cotes des opérateurs — lecture des pages", () => {
  it("lit la cote de référence et la cote actuelle de ZEturf", () => {
    const html = `<script>Course.init( { reunionId: 1, cotesInfos: {"referenceDateTime":"2026-11-15T10:30:00+01:00","meilleureCoteSG":{"reference":1.9,"live":3.1},"displayedColumns":{"hasSG":1},"2":{"odds":{"reference":1.9,"SG":3.1,"SPMin":1.2},"oddsprogress_single":"plus"},"1":{"odds":{"reference":45.6,"SG":4.3}},"10":{"odds":{"reference":null,"SG":0}}}, autre: 1 });</script>`;
    assert.deepEqual(parseZeturfOdds(html), { numbers: [1, 2, 10], odds: [4.3, 3.1, null], reference: [45.6, 1.9, null] });
  });

  it("rend null quand ZEturf ne publie aucune cote", () => {
    assert.equal(parseZeturfOdds("<html>rien</html>"), null);
    assert.equal(parseZeturfOdds(`cotesInfos: {"displayedColumns":{"hasSG":1},"1":{"odds":{"reference":null,"SG":null}}}`), null);
  });

  it("lit la cote Genybet de chaque partant dans le flux Next.js de Geny", () => {
    const flight = JSON.stringify(
      `x:[{"idParticipation":1,"numero":13,"cheval":{"nom":"A"},"cotePmu":2.3,"coteGeny":1.6},{"idParticipation":2,"numero":3,"cotePmu":6.5,"coteGeny":12.2},{"idParticipation":3,"numero":7,"cotePmu":null,"coteGeny":null},{"idParticipation":9,"numero":13,"nomCheval":"A"}]`,
    );
    const html = `<script>self.__next_f.push([1,${flight}])</script>`;
    assert.deepEqual(parseGenyOdds(html), { numbers: [3, 7, 13], odds: [12.2, null, 1.6] });
    assert.equal(parseGenyOdds("<html></html>"), null);
  });
});

describe("cotes des opérateurs — cadence des relevés", () => {
  it("relève une course jamais vue, puis à chaque palier franchi", () => {
    assert.equal(oddsDue(300, null), true);
    assert.equal(oddsDue(200, 300), false);
    assert.equal(oddsDue(59, 300), true);
    assert.equal(oddsDue(40, 59), false);
    assert.equal(oddsDue(14.5, 59), true);
    assert.equal(oddsDue(4.9, 14.5), true);
    assert.equal(oddsDue(3, 4.9), false);
    assert.equal(oddsDue(1.9, 4.9), true);
    assert.equal(oddsDue(1, 1.9), false);
  });

  it("ne relève plus une course partie ou sur le point de partir", () => {
    assert.equal(oddsDue(0.1, 4.9), false);
    assert.equal(oddsDue(-3, null), false);
  });
});
