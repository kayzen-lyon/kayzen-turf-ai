import type { ReactNode } from "react";
import { ACCORD_MAX_GAP_PTS, CONFRONT_MIN_PCT } from "@/lib/confrontation";
import type { HorseRow } from "@/lib/course-view-model";
import { OddsCell } from "@/components/course/live-extras";
import { formatOdds } from "@/lib/format";
import type { LexiqueTerm } from "@/lib/lexique";
import { FLOW_ACCEL_PTS, FLOW_TREND_PTS, MVT_NOISE_PCT, STRONG_MONEY_PTS } from "@/lib/market";
import type { RaceAnalysis } from "@/lib/types";
import { AccelCell, FlowCell, MoveCell, SignalBadges, gapClass, rate } from "@/components/course/field-cells";
import { MusicSparkline } from "@/components/course/music-sparkline";
import { pct, signedPct, signedPts } from "@/components/course/shared";
import { ScoreCell, SurpriseBadge } from "@/components/course/surprise-cells";
import { Term } from "@/components/course/term";
import { SURPRISE_MIN_RATIO } from "@/lib/surprise";

const EUROS = new Intl.NumberFormat("fr-FR");

/**
 * Colonnes, légendes et notes de chaque lecture du tableau des partants.
 * Un en-tête qui porte un `term` renvoie à sa définition du lexique.
 */

export const TABS = ["Classement IA", "Analyse complète", "Confrontation", "MVT", "Cotes & Marché", "Forme"] as const;
export type Tab = (typeof TABS)[number];

export const TAB_LABELS: Record<Tab, string> = {
  "Classement IA": "Classement IA",
  "Analyse complète": "Analyse complète",
  Confrontation: "IA × Marché",
  MVT: "MVT & argent",
  "Cotes & Marché": "Cotes & Marché",
  Forme: "Forme",
};

export function tabId(tab: Tab) {
  return `onglet-${tab.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

export type Column = { label: string; title?: string; term?: LexiqueTerm; align?: "right"; render: (row: HorseRow) => ReactNode };

export const CAPTIONS: Record<Tab, string> = {
  "Classement IA": "Classement : probabilité de l'IA sans cote, probabilité du marché, écart et probabilité retenue",
  "Analyse complète":
    "Analyse complète : IA, marché, écart, mouvement de cote, argent, forme, score de surprise sur 100 et alerte",
  Confrontation: "Confrontation IA × marché : accord, favoris de l'IA, favoris du marché, et signaux d'argent",
  MVT: "Classement du marché, du cheval le plus joué au plus délaissé : mouvement de cote depuis le matin et part des mises",
  "Cotes & Marché": "Cotes, cote juste, espérance et parts des enjeux PMU",
  Forme: "Forme récente, gains et entourage",
};

export const FOOTNOTES: Record<Tab, ReactNode> = {
  "Classement IA": (
    <>
      IA : probabilité de victoire estimée sans jamais voir la cote (forme, gains, entourage). Marché : cote PMU,{" "}
      <Term name="Marge du PMU (devig)">marge du PMU retirée</Term>. Retenue : le marché recalibré sur les arrivées réelles — l&apos;IA ne l&apos;améliore pas
      contre la cote finale, elle est affichée à part. C&apos;est la retenue qui fait le classement.
    </>
  ),
  "Analyse complète": (
    <>
      <Term name="Score de surprise">Score de surprise</Term> sur 100 : écart IA / marché (40 pts), rang de l&apos;IA (15), forme sur les cinq
      dernières courses (15), entourage (10), marché du jour — MVT et argent (20). Alerte seulement si l&apos;IA voit le cheval au moins{" "}
      {String(SURPRISE_MIN_RATIO).replace(".", ",")} fois au-dessus du marché : Sous-coté IA sous 10/1, Surprise IA de 10/1 à 30/1, Tocard malin
      au-delà (signal fort seulement), trois au plus par course. Le score décrit un désaccord avec le marché, il n&apos;annonce pas plus de
      gagnants que la cote finale.
    </>
  ),
  Confrontation: (
    <>
      Seuls les chevaux à au moins {CONFRONT_MIN_PCT} % pour l&apos;IA ou pour le marché sont classés. Accord : écart de {ACCORD_MAX_GAP_PTS} points
      au plus, ou rapport IA ÷ marché entre 0,8 et 1,25. <Term name="Argent entrant / sortant">Argent entrant</Term> : +{STRONG_MONEY_PTS} points de
      part des mises en 15 min ; argent sortant : −{STRONG_MONEY_PTS} points. Accélération : +{FLOW_ACCEL_PTS} point en 5 min, plus vite que sur les
      10 minutes d&apos;avant. <Term name="Smart money">Smart money</Term> : argent qui entre, cote qui baisse et IA favorable ou d&apos;accord — le PMU
      ne publie pas qui mise : c&apos;est un argent que notre modèle indépendant confirme, pas « l&apos;argent des initiés ».
    </>
  ),
  MVT: (
    <>
      Classement du marché, du plus joué au plus délaissé. <Term name="MVT">MVT</Term> — cote du matin : premier relevé du jour ; une variation sous ±
      {MVT_NOISE_PCT} % est tenue pour du bruit, une cote qui baisse signifie que le cheval est joué. Argent : part du cheval dans le pool simple gagnant
      du PMU, sa variation sur 15 min (flèche au-delà de ±{String(FLOW_TREND_PTS).replace(".", ",")} pt) et l&apos;accélération sur 5 min (éclair à +
      {FLOW_ACCEL_PTS} pt). Le PMU publie les enjeux par cheval, jamais par parieur : une part qui monte dit que le cheval est joué, pas par qui.
    </>
  ),
  "Cotes & Marché": (
    <>
      Espérance : gain moyen d&apos;un pari gagnant de 1 € à la cote affichée, selon la probabilité retenue — le prélèvement du PMU la rend presque
      toujours négative. <Term name="Cote juste">Cote juste</Term> : inverse de la probabilité retenue. Part des mises : part du cheval dans le pool
      simple gagnant du PMU, et sa variation sur 15 min.
    </>
  ),
  Forme:
    "Courbe : huit dernières courses, la plus récente à droite (dans le texte de la musique, elle est à gauche). Réussite : part des victoires du jockey/driver et de l'entraîneur sur notre historique.",
};

export const COLUMNS: Record<Tab, (race: RaceAnalysis) => Column[]> = {
  "Classement IA": () => [
    { label: "IA", title: "Probabilité de victoire selon l'IA, sans cote", align: "right", render: (r) => pct(r.ai, 1) },
    { label: "Marché", title: "Probabilité implicite de la cote, marge retirée", align: "right", render: (r) => pct(r.market, 1) },
    { label: "Écart", title: "IA moins marché, en points", align: "right", render: (r) => <span className={gapClass(r.gap)}>{signedPts(r.gap)}</span> },
    { label: "Retenue", title: "Probabilité de victoire retenue pour le classement", align: "right", render: (r) => <span className="font-bold text-fg">{pct(r.horse.winProbability, 1)}</span> },
    { label: "Top 3", term: "Top 3", align: "right", render: (r) => pct(r.horse.top3Probability) },
    { label: "Cote", align: "right", render: (r) => <OddsCell number={r.horse.number} odds={r.horse.odds} /> },
  ],
  "Analyse complète": () => [
    { label: "IA", title: "Probabilité de victoire selon l'IA, sans cote", align: "right", render: (r) => pct(r.ai, 0) },
    { label: "Marché", title: "Probabilité implicite de la cote, marge retirée", align: "right", render: (r) => pct(r.market, 0) },
    { label: "Écart", title: "IA moins marché, en points", align: "right", render: (r) => <span className={gapClass(r.gap)}>{signedPts(r.gap, 0)}</span> },
    { label: "Score", term: "Score de surprise", align: "right", render: (r) => <ScoreCell surprise={r.surprise} /> },
    { label: "Alerte", title: "Sous-coté IA, Surprise IA, Tocard malin ou À surveiller", render: (r) => <SurpriseBadge alert={r.surprise.alert} /> },
    { label: "Cote", align: "right", render: (r) => <OddsCell number={r.horse.number} odds={r.horse.odds} /> },
    { label: "MVT", term: "MVT", render: (r) => <MoveCell row={r} /> },
    { label: "Argent", title: "Variation de la part des mises sur 15 min", align: "right", render: (r) => <FlowCell row={r} /> },
    { label: "Forme", title: "Huit dernières courses, la plus récente à droite", render: (r) => <MusicSparkline music={r.horse.music} /> },
  ],
  Confrontation: () => [
    { label: "IA", title: "Probabilité de victoire selon l'IA, sans cote", align: "right", render: (r) => pct(r.ai, 1) },
    { label: "Marché", title: "Probabilité implicite de la cote, marge retirée", align: "right", render: (r) => pct(r.market, 1) },
    { label: "Écart", title: "IA moins marché, en points", align: "right", render: (r) => <span className={gapClass(r.gap)}>{signedPts(r.gap)}</span> },
    { label: "Cote", align: "right", render: (r) => <OddsCell number={r.horse.number} odds={r.horse.odds} /> },
    { label: "MVT", term: "MVT", render: (r) => <MoveCell row={r} /> },
    { label: "Argent 15 min", title: "Variation de la part des mises sur 15 min", align: "right", render: (r) => <FlowCell row={r} /> },
    { label: "Signaux", title: "Argent entrant ou sortant, accélération des mises, smart money", render: (r) => <SignalBadges row={r} /> },
  ],
  MVT: () => [
    { label: "Cote du matin", align: "right", render: (r) => formatOdds(r.movement.reference ?? NaN, 1) },
    { label: "Cote actuelle", align: "right", render: (r) => <OddsCell number={r.horse.number} odds={r.movement.current ?? NaN} /> },
    {
      label: "Variation",
      align: "right",
      render: (r) => (
        <span className={r.movement.direction === "joue" ? "font-bold text-accent-text" : r.movement.direction === "delaisse" ? "font-bold text-danger" : "text-muted"}>
          {signedPct(r.movement.changePct)}
        </span>
      ),
    },
    { label: "Tendance", render: (r) => <MoveCell row={r} /> },
    { label: "Part des mises", title: "Part du cheval dans le pool simple gagnant du PMU", align: "right", render: (r) => pct(r.flow.share, 1) },
    { label: "Argent 15 min", title: "Variation de la part des mises sur 15 min", align: "right", render: (r) => <FlowCell row={r} /> },
    { label: "5 min", title: "Accélération : variation sur les 5 dernières minutes", align: "right", render: (r) => <AccelCell row={r} /> },
    { label: "Rg IA", title: "Rang au classement IA", align: "right", render: (r) => r.rank },
  ],
  "Cotes & Marché": () => [
    { label: "Cote", align: "right", render: (r) => <OddsCell number={r.horse.number} odds={r.horse.odds} /> },
    { label: "Cote juste", term: "Cote juste", align: "right", render: (r) => formatOdds(r.horse.fairOdds, 1) },
    {
      label: "Espérance",
      align: "right",
      render: (r) => <span className={r.expectedValue !== null && r.expectedValue > 0 ? "font-bold text-accent-text" : "text-danger"}>{signedPct(r.expectedValue)}</span>,
    },
    { label: "Part des mises", align: "right", render: (r) => pct(r.flow.share, 1) },
    {
      label: "Sur 15 min",
      align: "right",
      render: (r) => <span className={r.flow.strong ? "font-bold text-accent-text" : "text-muted"}>{signedPts(r.flow.delta15)}</span>,
    },
  ],
  Forme: (race) => [
    { label: "Musique", render: (r) => <MusicSparkline music={r.horse.music} /> },
    { label: "Âge", align: "right", render: (r) => `${r.horse.sex?.slice(0, 1) ?? ""}${r.horse.age ?? "—"}` },
    { label: "Gains", align: "right", render: (r) => (r.horse.earnings ? `${EUROS.format(Math.round(r.horse.earnings))} €` : "—") },
    { label: race.discipline === "Trot" ? "Driver" : "Jockey", render: (r) => <span className="text-xs text-muted">{r.horse.jockey} · {rate(r.horse.jockeyWins, r.horse.jockeyRuns)}</span> },
    { label: "Entraîneur", render: (r) => <span className="text-xs text-muted">{r.horse.trainer} · {rate(r.horse.trainerWins, r.horse.trainerRuns)}</span> },
  ],
};
