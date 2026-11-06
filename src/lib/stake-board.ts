/**
 * TABLEAU DES MISES — enjeux réels par cheval, cotes et note de force de l'IA.
 *
 * Définitions, publiées telles quelles sur la page /methode :
 *
 *   Sources    deux masses PMU distinctes sur le simple gagnant : les paris en
 *              point de vente (PMU+) et les paris en ligne (PMU Play).
 *
 *   Évolution  euros reçus par le cheval depuis un relevé vieux d'au moins
 *              STAKE_WINDOW_MIN minutes. Dans un pari mutuel, les enjeux d'un
 *              cheval ne font que monter (hors annulations) : aucun cheval ne
 *              « perd » d'euros. La flèche dit donc s'il reçoit plus vite que
 *              la course (verte, sa part monte) ou moins vite (rouge, sa part
 *              baisse).
 *
 *   Note IA    probabilité du modèle fondamental, qui ne voit jamais la cote,
 *              rapportée à une chance égale entre partants, sur une échelle
 *              logarithmique : 50 = chance moyenne de la course, +14 points
 *              chaque fois que cette chance double.
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

export type StakeTrend = "up" | "down" | "flat";

export type StakeRunner = {
  number: number;
  morningOffline: number | null;
  currentOffline: number | null;
  morningOnline: number | null;
  currentOnline: number | null;
  /** Mises cumulées des deux sources (€), `null` si aucune n'est publiée. */
  total: number | null;
  /** Euros reçus sur la fenêtre, `null` sans relevé assez ancien. */
  delta: number | null;
  /** Évolution relative des mises du cheval sur la fenêtre (%). */
  deltaPct: number | null;
  trend: StakeTrend | null;
};

export type StakeBoard = {
  runners: StakeRunner[];
  /** Mises cumulées de la course (€). */
  totalStake: number;
  /** Évolution relative des mises de toute la course sur la fenêtre (%). */
  poolDeltaPct: number | null;
  /** Durée réelle de la fenêtre (min), `null` sans relevé assez ancien. */
  windowMinutes: number | null;
};

function at<T>(values: Array<T | null>, numbers: number[], number: number): T | null {
  const i = numbers.indexOf(number);
  return i === -1 ? null : (values[i] ?? null);
}

function sum(a: number | null, b: number | null): number | null {
  return a === null && b === null ? null : (a ?? 0) + (b ?? 0);
}

function totalOf(reading: StakeReading, number: number): number | null {
  return sum(at(reading.stakeOffline, reading.numbers, number), at(reading.stakeOnline, reading.numbers, number));
}

function trendOf(delta: number, deltaPct: number | null, poolDelta: number, poolPct: number | null): StakeTrend {
  if (delta < 0) return "down";
  if (delta === 0) return poolDelta > 0 ? "down" : "flat";
  if (deltaPct === null || poolPct === null) return "up";
  return deltaPct >= poolPct ? "up" : "down";
}

/**
 * Classement : le cheval qui a reçu le plus d'argent sur la fenêtre d'abord.
 * Sans relevé assez ancien, les mises cumulées départagent ; les chevaux sans
 * mise ferment la marche.
 */
export function compareStakeRunners(a: StakeRunner, b: StakeRunner): number {
  return (b.delta ?? -Infinity) - (a.delta ?? -Infinity) || (b.total ?? -Infinity) - (a.total ?? -Infinity) || a.number - b.number;
}

export function buildStakeBoard(input: {
  live: StakeReading;
  baseline?: { reading: StakeReading; minutes: number } | null;
  morning?: MorningOdds | null;
}): StakeBoard {
  const { live, baseline, morning } = input;
  const totals = live.numbers.map((n) => totalOf(live, n));
  const totalStake = totals.reduce<number>((acc, v) => acc + (v ?? 0), 0);

  // Masse de référence : uniquement les chevaux présents aux deux relevés, pour
  // qu'un non-partant retiré entre-temps ne fausse pas la comparaison.
  const previous = live.numbers.map((n) => (baseline ? totalOf(baseline.reading, n) : null));
  const poolBefore = previous.reduce<number>((acc, v) => acc + (v ?? 0), 0);
  const poolNow = totals.reduce<number>((acc, v, i) => acc + (previous[i] !== null ? (v ?? 0) : 0), 0);
  const hasBaseline = previous.some((v) => v !== null);
  const poolDelta = poolNow - poolBefore;
  const poolDeltaPct = hasBaseline && poolBefore > 0 ? (poolDelta / poolBefore) * 100 : null;

  const runners = live.numbers.map((number, i): StakeRunner => {
    const total = totals[i];
    const before = previous[i];
    const delta = total !== null && before !== null ? total - before : null;
    const deltaPct = delta !== null && before !== null && before > 0 ? (delta / before) * 100 : null;
    return {
      number,
      morningOffline: morning ? at(morning.refOffline, morning.numbers, number) : null,
      currentOffline: at(live.oddsOffline, live.numbers, number),
      morningOnline: morning ? at(morning.refOnline, morning.numbers, number) : null,
      currentOnline: at(live.oddsOnline, live.numbers, number),
      total,
      delta,
      deltaPct,
      trend: delta === null ? null : trendOf(delta, deltaPct, poolDelta, poolDeltaPct),
    };
  });

  return {
    runners: runners.sort(compareStakeRunners),
    totalStake,
    poolDeltaPct,
    windowMinutes: hasBaseline && baseline ? baseline.minutes : null,
  };
}

/** Note de force sur 100 (voir l'en-tête). `aiPct` : probabilité de l'IA, en %. */
export function aiStrengthScore(aiPct: number | null | undefined, fieldSize: number): number | null {
  if (aiPct == null || !Number.isFinite(aiPct) || aiPct <= 0 || fieldSize < 1) return null;
  const score = 50 + 20 * Math.log((aiPct / 100) * fieldSize);
  return Math.min(99, Math.max(1, Math.round(score)));
}
