import type { PressCategory, PressHorse } from "@/lib/press-consensus";

/**
 * PRÉSENTATION PRESSE × IA — classement des partants par la presse, par l'IA,
 * et le cheval peu cité que l'IA place haut. Lecture seule de données déjà
 * calculées : aucune nouvelle règle de pronostic.
 */

export type PressSummaryInput = { number: number; name: string; ai: number | null; press: PressHorse };

/** Le moins cité des chevaux que l'IA met dans ses 4 premiers, s'il est cité par la moitié des sites au plus. */
export const WATCH_MAX_SHARE = 0.5;
export const WATCH_MAX_AI_RANK = 4;

export const PRESS_COMMENT_LABELS: Record<PressCategory, string> = {
  consensus: "Presse et marché d'accord",
  "sites-sans-marche": "Cité par la presse, délaissé par le marché",
  "marche-sans-sites": "Joué par le marché, négligé par la presse",
};

/** Classement presse : soutien des sites, puis meilleur rang moyen, puis numéro. */
export function comparePress(a: PressSummaryInput, b: PressSummaryInput): number {
  return (
    b.press.sitesScore - a.press.sitesScore ||
    (a.press.meanRank ?? Infinity) - (b.press.meanRank ?? Infinity) ||
    a.number - b.number
  );
}

function compareAi(a: PressSummaryInput, b: PressSummaryInput): number {
  return (b.ai ?? -Infinity) - (a.ai ?? -Infinity) || a.number - b.number;
}

export function pressSummary(rows: PressSummaryInput[]) {
  const byPress = [...rows].sort(comparePress);
  const byAi = rows.filter((r) => r.ai !== null).sort(compareAi);
  const aiRank = new Map(byAi.map((r, i) => [r.number, i + 1]));
  const watch =
    byAi
      .filter((r) => (aiRank.get(r.number) ?? Infinity) <= WATCH_MAX_AI_RANK && r.press.share <= WATCH_MAX_SHARE)
      .sort((a, b) => a.press.share - b.press.share || compareAi(a, b))[0] ?? null;
  return {
    rows: byPress,
    pressRank: new Map(byPress.map((r, i) => [r.number, i + 1])),
    aiRank,
    topPress: byPress.filter((r) => r.press.citations.length > 0).slice(0, 3),
    topAi: byAi.slice(0, 3),
    watch,
  };
}

/** Commentaire court d'un partant : sa famille presse × marché, sinon sa présence dans la presse et l'avis de l'IA. */
export function pressComment(row: PressSummaryInput, aiRank: number | undefined): string {
  if (row.press.category) return PRESS_COMMENT_LABELS[row.press.category];
  const { share } = row.press;
  if (aiRank !== undefined && aiRank <= WATCH_MAX_AI_RANK && share <= WATCH_MAX_SHARE) return "Peu cité, bien vu par l'IA";
  if (share === 1) return "Cité par tous les sites";
  if (share >= 0.75) return "Très cité par la presse";
  if (share === 0) return "Absent des sélections";
  return "";
}
