import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PRESS_PASS_INTERVAL_MS,
  PRESS_PASS_MARGIN_MS,
  parisHour,
  pressPassPlan,
  racesMissingSource,
  selectionKey,
} from "../scripts/lib/press-sources/schedule.mjs";

const MINUTE = 60_000;
// 13/11/2026 : heure d'hiver, Paris = UTC + 1.
const at = (iso) => Date.parse(iso);

describe("collecte presse — passes en journée", () => {
  it("ne garde que les courses sans sélection de la source", () => {
    const races = [{ id: "2026-11-13-R1-C1" }, { id: "2026-11-13-R1-C2" }, { id: "2026-11-13-R2-C1" }];
    const existing = new Set([selectionKey("2026-11-13-R1-C1", "geny"), selectionKey("2026-11-13-R1-C2", "zeturf")]);
    assert.deepEqual(racesMissingSource(races, existing, "geny").map((race) => race.id), ["2026-11-13-R1-C2", "2026-11-13-R2-C1"]);
    assert.deepEqual(racesMissingSource(races, existing, "canalturf").length, 3);
    assert.deepEqual(racesMissingSource(races, new Set(), "geny"), races);
  });

  it("lit l'heure de Paris, été comme hiver", () => {
    assert.equal(parisHour(at("2026-11-13T10:17:00Z")), 11);
    assert.equal(parisHour(at("2026-07-14T10:17:00Z")), 12);
    assert.equal(parisHour(at("2026-11-13T23:30:00Z")), 0);
  });

  it("lance une passe au démarrage de la boucle, en journée", () => {
    const now = at("2026-11-13T07:00:00Z"); // 08 h à Paris
    assert.deepEqual(pressPassPlan({ now, lastPassAt: null, deadline: now + 330 * MINUTE }), { run: true, tomorrow: false });
  });

  it("attend l'intervalle entre deux passes", () => {
    const now = at("2026-11-13T10:00:00Z");
    const deadline = now + 300 * MINUTE;
    assert.equal(pressPassPlan({ now, lastPassAt: now - PRESS_PASS_INTERVAL_MS + MINUTE, deadline }).run, false);
    assert.equal(pressPassPlan({ now, lastPassAt: now - PRESS_PASS_INTERVAL_MS, deadline }).run, true);
  });

  it("ne lance rien la nuit : les sites n'ont pas encore publié", () => {
    const now = at("2026-11-13T02:00:00Z"); // 03 h à Paris
    assert.equal(pressPassPlan({ now, lastPassAt: null, deadline: now + 330 * MINUTE }).run, false);
  });

  it("ne lance rien trop près de la fin de la boucle", () => {
    const now = at("2026-11-13T10:00:00Z");
    assert.equal(pressPassPlan({ now, lastPassAt: null, deadline: now + PRESS_PASS_MARGIN_MS - MINUTE }).run, false);
    assert.equal(pressPassPlan({ now, lastPassAt: null, deadline: now + PRESS_PASS_MARGIN_MS }).run, true);
  });

  it("relève aussi le lendemain à partir de 18 h à Paris", () => {
    const evening = at("2026-11-13T17:05:00Z"); // 18 h 05 à Paris
    assert.deepEqual(pressPassPlan({ now: evening, lastPassAt: null, deadline: evening + 330 * MINUTE }), { run: true, tomorrow: true });
    const afternoon = at("2026-11-13T15:00:00Z");
    assert.equal(pressPassPlan({ now: afternoon, lastPassAt: null, deadline: afternoon + 330 * MINUTE }).tomorrow, false);
  });
});
