/**
 * MARCHÉ PAR OPÉRATEUR — un tableau indépendant par opérateur (ZEturf, Genybet,
 * PMU+) : classement et cote du matin, cote actuelle, évolution, classement
 * actuel, classement final des deux dernières minutes.
 *
 * Définitions, publiées telles quelles sur /methode :
 *
 *   Matin      cote de référence publiée par l'opérateur quand elle existe
 *              (ZEturf : sa cote de 10 h 30 ; PMU : sa cote de référence),
 *              sinon notre premier relevé du jour. Un unique relevé n'est pas
 *              un « matin » : sans second relevé, aucune évolution n'est
 *              affichée.
 *   Actuelle   dernier relevé fait avant le départ.
 *   Évolution  cote actuelle − cote du matin. Une cote qui BAISSE veut dire que
 *              le cheval est joué ; une cote qui monte, qu'il est délaissé. En
 *              dessous de `STABLE_PCT` % d'écart, la cote est dite stable.
 *   Rang       place du cheval par la cote chez cet opérateur (1 = favori).
 *   Final      classement au dernier relevé fait dans les `FINAL_WINDOW_MIN`
 *              dernières minutes avant le départ ; vide tant qu'il n'existe pas.
 *
 * Chaque opérateur a ses propres parieurs et ses propres cotes : les tableaux
 * ne sont jamais fusionnés. Fonctions pures.
 */

export type OperatorKey = "zeturf" | "genybet" | "pmu";

export const OPERATOR_LABELS: Record<OperatorKey, string> = { zeturf: "ZEturf", genybet: "Genybet", pmu: "PMU+" };

export const OPERATOR_ORDER: OperatorKey[] = ["zeturf", "genybet", "pmu"];

/** Fenêtre du classement final, en minutes avant le départ. */
export const FINAL_WINDOW_MIN = 2;

/** Tolérance sur la fenêtre finale : un relevé prévu à H-2 part rarement à la seconde. */
const FINAL_TOLERANCE_MS = 45_000;

/** Sous cet écart relatif (%), la cote est dite stable. */
export const STABLE_PCT = 2;

export type OddsSnapshot = {
  observedAt: string;
  numbers: number[];
  odds: Array<number | null>;
  /** Cote du matin publiée par l'opérateur lui-même, si elle existe. */
  reference?: Array<number | null> | null;
  /** Cote de clôture lue après le départ (PMU) : elle vaut classement final. */
  closing?: boolean;
};

export type OddsDirection = "baisse" | "hausse" | "stable";

export type OperatorRow = {
  number: number;
  morningOdds: number | null;
  morningRank: number | null;
  currentOdds: number | null;
  currentRank: number | null;
  /** Cote actuelle − cote du matin. */
  change: number | null;
  changePct: number | null;
  direction: OddsDirection | null;
  /** Places gagnées depuis le matin (positif = le cheval a progressé au classement). */
  rankGain: number | null;
  finalOdds: number | null;
  finalRank: number | null;
};

export type OperatorTable = {
  rows: OperatorRow[];
  /** Heure de notre premier relevé (ISO) quand il sert de cote du matin, sinon `null`. */
  morningAt: string | null;
  /** La cote du matin est celle que l'opérateur publie lui-même. */
  morningFromOperator: boolean;
  currentAt: string | null;
  finalAt: string | null;
};

function valid(odds: number | null | undefined): odds is number {
  return typeof odds === "number" && Number.isFinite(odds) && odds > 1;
}

/** Rang par la cote (1 = favori) ; à cote égale, le plus petit numéro d'abord. */
export function rankByOdds(numbers: readonly number[], odds: ReadonlyArray<number | null>): Map<number, number> {
  const priced = numbers
    .map((number, i) => ({ number, odds: odds[i] }))
    .filter((r): r is { number: number; odds: number } => valid(r.odds))
    .sort((a, b) => a.odds - b.odds || a.number - b.number);
  return new Map(priced.map((r, i) => [r.number, i + 1]));
}

function oddsOf(snapshot: { numbers: number[]; odds: Array<number | null> } | null, number: number): number | null {
  if (!snapshot) return null;
  const value = snapshot.odds[snapshot.numbers.indexOf(number)];
  return valid(value) ? value : null;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export function buildOperatorTable(input: {
  /** Relevés, dans n'importe quel ordre. */
  snapshots: readonly OddsSnapshot[];
  /** Heure de départ (ISO), `null` si inconnue. */
  startAt: string | null;
  nonRunners?: readonly number[];
}): OperatorTable {
  const start = input.startAt ? Date.parse(input.startAt) : NaN;
  const out = new Set(input.nonRunners ?? []);
  const strip = <T extends { numbers: number[]; odds: Array<number | null> }>(s: T): T => {
    const keep = s.numbers.map((n) => !out.has(n));
    return { ...s, numbers: s.numbers.filter((_, i) => keep[i]), odds: s.odds.filter((_, i) => keep[i]) };
  };

  // Avant le départ uniquement : après, seule une cote de clôture explicite compte.
  const usable = [...input.snapshots]
    .filter((s) => s.numbers.length > 0 && (s.closing || !Number.isFinite(start) || Date.parse(s.observedAt) <= start))
    .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  if (usable.length === 0) return { rows: [], morningAt: null, morningFromOperator: false, currentAt: null, finalAt: null };

  const first = usable[0];
  const current = strip(usable[usable.length - 1]);
  const withReference = usable.find((s) => s.reference?.some(valid));
  const morning = withReference
    ? strip({ numbers: withReference.numbers, odds: withReference.reference as Array<number | null> })
    : usable.length > 1
      ? strip(first)
      : null;

  const finalSource =
    [...usable].reverse().find((s) => s.closing || (Number.isFinite(start) && start - Date.parse(s.observedAt) <= FINAL_WINDOW_MIN * 60_000 + FINAL_TOLERANCE_MS)) ??
    null;
  const final = finalSource ? strip(finalSource) : null;

  const morningRanks = morning ? rankByOdds(morning.numbers, morning.odds) : new Map<number, number>();
  const currentRanks = rankByOdds(current.numbers, current.odds);
  const finalRanks = final ? rankByOdds(final.numbers, final.odds) : new Map<number, number>();

  const rows = current.numbers.map((number): OperatorRow => {
    const morningOdds = oddsOf(morning, number);
    const currentOdds = oddsOf(current, number);
    const change = morningOdds !== null && currentOdds !== null ? round1(currentOdds - morningOdds) : null;
    const changePct = change !== null && morningOdds !== null ? ((currentOdds as number) / morningOdds - 1) * 100 : null;
    const morningRank = morningRanks.get(number) ?? null;
    const currentRank = currentRanks.get(number) ?? null;
    return {
      number,
      morningOdds,
      morningRank,
      currentOdds,
      currentRank,
      change,
      changePct,
      direction: changePct === null ? null : Math.abs(changePct) < STABLE_PCT ? "stable" : changePct < 0 ? "baisse" : "hausse",
      rankGain: morningRank !== null && currentRank !== null ? morningRank - currentRank : null,
      finalOdds: oddsOf(final, number),
      finalRank: finalRanks.get(number) ?? null,
    };
  });

  rows.sort((a, b) => (a.currentRank ?? Infinity) - (b.currentRank ?? Infinity) || a.number - b.number);

  return {
    rows,
    morningAt: morning && !withReference ? first.observedAt : null,
    morningFromOperator: Boolean(withReference),
    currentAt: usable[usable.length - 1].observedAt,
    finalAt: finalSource?.observedAt ?? null,
  };
}

export type OperatorComparisonRow = {
  number: number;
  ranks: Partial<Record<OperatorKey, number | null>>;
  odds: Partial<Record<OperatorKey, number | null>>;
  /** Meilleure cote actuelle (la plus haute) et l'opérateur qui la propose. */
  best: { key: OperatorKey; odds: number } | null;
  /** Écart entre le meilleur et le moins bon rang, `null` si un opérateur manque. */
  rankSpread: number | null;
};

/** Rang et cote actuels de chaque cheval chez chaque opérateur, côte à côte. */
export function compareOperators(tables: ReadonlyArray<{ key: OperatorKey; table: OperatorTable }>): OperatorComparisonRow[] {
  const numbers = [...new Set(tables.flatMap((t) => t.table.rows.map((r) => r.number)))].sort((a, b) => a - b);
  return numbers.map((number) => {
    const ranks: OperatorComparisonRow["ranks"] = {};
    const odds: OperatorComparisonRow["odds"] = {};
    let best: OperatorComparisonRow["best"] = null;
    for (const { key, table } of tables) {
      const row = table.rows.find((r) => r.number === number);
      ranks[key] = row?.currentRank ?? null;
      odds[key] = row?.currentOdds ?? null;
      if (row?.currentOdds != null && (!best || row.currentOdds > best.odds)) best = { key, odds: row.currentOdds };
    }
    const known = Object.values(ranks).filter((r): r is number => r != null);
    return {
      number,
      ranks,
      odds,
      best,
      rankSpread: known.length === tables.length && known.length > 1 ? Math.max(...known) - Math.min(...known) : null,
    };
  });
}
