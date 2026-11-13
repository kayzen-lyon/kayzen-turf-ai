/**
 * Calendrier des passes de collecte presse lancées par la boucle en direct
 * (scripts/live-refresh.ts), et filtre des sélections encore manquantes.
 *
 * POURQUOI : la collecte ne tournait qu'avec l'import PMU, prévu à 05 h 30 et
 * 18 h 30 (Paris). GitHub déclenche ces passages avec des heures de retard
 * (13 h 28 le 13/11/2026, 14 h 03 la veille) : comme seules les courses pas
 * encore parties sont écrites, toutes les courses du matin restaient sans
 * pronostic presse. La boucle en direct, elle, tourne en continu.
 *
 * Fonctions pures : l'horloge est passée en paramètre.
 */

/** Écart minimal entre deux passes de la boucle. */
export const PRESS_PASS_INTERVAL_MS = 150 * 60_000;

/** Temps à garder avant la fin de la boucle pour laisser finir une passe. */
export const PRESS_PASS_MARGIN_MS = 40 * 60_000;

/** Avant cette heure (Paris), les sites n'ont pas publié leurs sélections du jour. */
export const PRESS_FIRST_HOUR = 6;

/** À partir de cette heure (Paris), les sélections du lendemain sont relevées aussi. */
export const PRESS_TOMORROW_HOUR = 18;

/** Heure de Paris (0 à 23) à l'instant `now`. */
export function parisHour(now = Date.now()) {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Paris", hourCycle: "h23", hour: "2-digit" }).format(new Date(now)));
}

/**
 * Faut-il lancer une passe maintenant, et relever aussi le lendemain ?
 * @param {{ now: number, lastPassAt: number|null, deadline: number }} args
 * @returns {{ run: boolean, tomorrow: boolean }}
 */
export function pressPassPlan({ now, lastPassAt, deadline }) {
  const hour = parisHour(now);
  const due = lastPassAt === null || now - lastPassAt >= PRESS_PASS_INTERVAL_MS;
  const run = due && hour >= PRESS_FIRST_HOUR && deadline - now >= PRESS_PASS_MARGIN_MS;
  return { run, tomorrow: run && hour >= PRESS_TOMORROW_HOUR };
}

export function selectionKey(raceId, source) {
  return `${raceId}|${source}`;
}

/**
 * Courses pour lesquelles `source` n'a encore aucune sélection enregistrée.
 * @template {{ id: string }} R
 * @param {R[]} races
 * @param {Set<string>} existing clés `selectionKey(raceId, source)`
 * @param {string} source
 * @returns {R[]}
 */
export function racesMissingSource(races, existing, source) {
  return races.filter((race) => !existing.has(selectionKey(race.id, source)));
}
