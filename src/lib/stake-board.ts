/**
 * MISES PMU — types des relevés d'enjeux du simple gagnant, historisés dans
 * `stake_snapshots` par la boucle en direct (src/lib/live/stakes.ts).
 *
 * Le PMU tient deux masses distinctes : les paris en point de vente (PMU+,
 * `offline`) et les paris en ligne (`online`). La cote du matin de PMU+ sert au
 * tableau « Marché par opérateur » (src/lib/operator-board.ts). Le tableau
 * « Mises en direct PMU+ / PMU Play » qui lisait aussi ces relevés a été
 * remplacé par ce tableau le 15/11/2026.
 */

export const STAKE_WINDOW_MIN = 5;

/** Une source de mises pour tous les partants, en tableaux parallèles à `numbers`. */
export type StakeReading = {
  numbers: number[];
  stakeOffline: Array<number | null>;
  stakeOnline: Array<number | null>;
  oddsOffline: Array<number | null>;
  oddsOnline: Array<number | null>;
};

/** Cotes du matin, figées au premier relevé fait avant le recalage PMU de H-30. */
export type MorningOdds = {
  numbers: number[];
  refOffline: Array<number | null>;
  refOnline: Array<number | null>;
};
