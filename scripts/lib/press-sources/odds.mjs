/**
 * Cotes du simple gagnant publiées par les opérateurs partenaires sur les pages
 * course que le robot lit déjà pour les sélections presse, et cadence des relevés.
 *
 * - ZEturf : bloc `cotesInfos` de `Course.init({ … })`, une entrée par numéro :
 *   `"1":{"odds":{"reference":45.6,"SG":4.3,…}}`. `reference` est la cote de
 *   référence de ZEturf (relevée à 10 h 30, `referenceDateTime`), `SG` la cote
 *   du simple gagnant au moment de la lecture.
 * - Genybet : partants du flux Next.js de geny.com, `"numero":13,…,"coteGeny":1.6`
 *   (`cotePmu` est ignorée : la cote PMU vient directement de l'API PMU).
 *
 * Seuls les numéros et les cotes sont gardés. Fonctions pures, sans réseau.
 */

import { decodeNextFlight } from "./geny.mjs";
import { readBalancedJson } from "./parse-utils.mjs";

function odds(value) {
  const n = Number(value);
  return value != null && Number.isFinite(n) && n > 1 ? n : null;
}

/**
 * Page course ZEturf → `{ numbers, odds, reference }`, ou `null` sans cote.
 * @param {string} html
 */
export function parseZeturfOdds(html) {
  const text = String(html ?? "");
  const marker = text.indexOf("cotesInfos:");
  if (marker === -1) return null;
  const start = text.indexOf("{", marker);
  const data = start === -1 ? null : readBalancedJson(text, start);
  if (!data || typeof data !== "object") return null;
  const rows = Object.entries(data)
    .filter(([key, value]) => /^\d+$/.test(key) && value && typeof value === "object" && value.odds)
    .map(([key, value]) => ({ number: Number(key), odds: odds(value.odds.SG), reference: odds(value.odds.reference) }))
    .sort((a, b) => a.number - b.number);
  if (!rows.some((row) => row.odds !== null)) return null;
  return {
    numbers: rows.map((row) => row.number),
    odds: rows.map((row) => row.odds),
    reference: rows.some((row) => row.reference !== null) ? rows.map((row) => row.reference) : null,
  };
}

/**
 * Page course Geny → `{ numbers, odds }` (cotes Genybet), ou `null` sans cote.
 * @param {string} html
 */
export function parseGenyOdds(html) {
  const payload = decodeNextFlight(html);
  const byNumber = new Map();
  let index = payload.indexOf('{"idParticipation"');
  while (index !== -1) {
    const runner = readBalancedJson(payload, index);
    if (runner && Number.isInteger(runner.numero) && "coteGeny" in runner) byNumber.set(runner.numero, odds(runner.coteGeny));
    index = payload.indexOf('{"idParticipation"', index + 18);
  }
  const numbers = [...byNumber.keys()].sort((a, b) => a - b);
  const values = numbers.map((number) => byNumber.get(number));
  return values.some((value) => value !== null) ? { numbers, odds: values } : null;
}

/**
 * Paliers de relevé d'une course, en minutes avant le départ : un relevé est dû
 * quand la course a franchi un palier depuis le dernier relevé. Cinq relevés au
 * plus par course et par opérateur — le matin, puis H-60, H-15, H-5 et H-2.
 */
export const ODDS_STAGES_MIN = [60, 15, 5, 2];

/** En deçà, le relevé arriverait après la clôture des paris : il n'est plus lancé. */
export const ODDS_LAST_CALL_MIN = 0.25;

/**
 * Faut-il relever la course maintenant ?
 * @param {number} minutesToStart minutes avant le départ
 * @param {number|null} lastMinutesToStart minutes avant le départ lors du dernier relevé, `null` si aucun
 */
export function oddsDue(minutesToStart, lastMinutesToStart) {
  if (!Number.isFinite(minutesToStart) || minutesToStart < ODDS_LAST_CALL_MIN) return false;
  if (lastMinutesToStart === null) return true;
  return ODDS_STAGES_MIN.some((stage) => minutesToStart <= stage && lastMinutesToStart > stage);
}
