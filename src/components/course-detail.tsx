"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, ArrowLeft, Timer } from "lucide-react";
import { AllOddsChart } from "@/components/course/all-odds-chart";
import { AnalysisReport } from "@/components/course/analysis-report";
import { ArrivalRecap } from "@/components/course/arrival-recap";
import { CourseHeader } from "@/components/course/course-header";
import { FieldTable } from "@/components/course/field-table";
import { HorseCompare } from "@/components/course/horse-compare";
import { HorseSheet } from "@/components/course/horse-sheet";
import { OddsFlashProvider, TabCountdown } from "@/components/course/live-extras";
import type { RelaunchResult } from "@/components/course/live-status";
import { MagicSquarePanel } from "@/components/course/magic-square";
import { MarketPanel } from "@/components/course/market-panel";
import { NonRunners } from "@/components/course/non-runners";
import { SectionNavBar, SectionNavRail } from "@/components/course/section-nav";
import { PressPanel } from "@/components/course/press-panel";
import { StakeBoardPanel } from "@/components/course/stake-board";
import { SurprisePanel } from "@/components/course/surprise-panel";
import { PostRacePanel, SimulationPanel } from "@/components/course/side-panels";
import { TicketShare } from "@/components/course/ticket-share";
import { TicketTools } from "@/components/course/tools";
import { VerdictBanner } from "@/components/course/verdict-banner";
import { VisitChanges } from "@/components/course/visit-changes";
import { RaceSelectionPanel } from "@/components/race-selection";
import { diffAnalysis, hasChanges, snapshotAnalysis, type AnalysisDiff, type AnalysisSnapshot } from "@/lib/analysis-diff";
import type { Payout } from "@/lib/arrival-recap";
import { beginnerSummary } from "@/lib/beginner-summary";
import { buildBetRecommendations, buildXTickets, raceToContext } from "@/lib/bet-recommendations";
import { buildCourseViewModel } from "@/lib/course-view-model";
import { properName } from "@/lib/format";
import { COMPARE_MAX, toggleCompare } from "@/lib/horse-compare";
import type { MarketHistory } from "@/lib/market";
import { buildPostRaceAnalysis } from "@/lib/post-race-analysis";
import type { RaceIndexItem } from "@/lib/race-navigation";
import type { SignalRecord } from "@/lib/race-repository";
import { buildSelection } from "@/lib/selection";
import type { RaceAnalysis } from "@/lib/types";

/**
 * PAGE COURSE — le verdict d'abord, le détail à la demande.
 *
 *   1. en-tête : terrain et météo, âge des cotes (« Relancer l'analyse IA »
 *      jusqu'au départ), courses précédente / suivante, carte de la réunion ;
 *   1 bis. une fois l'arrivée publiée, l'arrivée et les rapports PMU ;
 *   1 ter. non-partants, changements depuis la dernière visite, et le panneau
 *      « Analyse réactualisée » après une relance ;
 *   2. verdict : une phrase pour débutant, puis la lecture et les tuiles ;
 *   3. notre sélection et un ticket par stratégie ;
 *   3 bis. « Chevaux cachés · Surprise IA » : les trois meilleures alertes du
 *      score de surprise, expliquées (lib/surprise) ;
 *   4. le tableau unique (Classement IA, Analyse complète, IA × Marché, MVT,
 *      Cotes & Marché, Forme), puis le comparateur et le carré magique 16 partants ;
 *   5. la fiche du cheval sélectionné ; à côté, son marché, les cotes de tous
 *      les partants et la simulation ;
 *   6. les tickets : copie au format PMU, partage en image, outils repliés ;
 *   7. tout en bas, les mises en direct PMU+ / PMU Play × force IA.
 *
 * Un sommaire (rail sur grand écran, pastilles sur mobile) suit la lecture.
 * Les blocs vivent sous src/components/course/.
 */

type CourseDetailProps = {
  race: RaceAnalysis;
  history?: MarketHistory;
  signals?: SignalRecord[];
  /** Programme allégé du jour, pour la navigation entre courses. */
  dayIndex?: RaceIndexItem[];
  /** Rapports officiels PMU, vides tant qu'ils ne sont pas publiés. */
  payouts?: Payout[];
  /** Comparaison des pronostics gelés (H-60 → départ), rendue côté serveur. */
  frozen?: ReactNode;
};

const EMPTY_HISTORY: MarketHistory = { odds: {}, pools: [] };
// Valeurs par défaut stables : un `[]` littéral en paramètre changeait à chaque
// rendu et relançait les useMemo qui en dépendent.
const NO_SIGNALS: SignalRecord[] = [];
const NO_RACES: RaceIndexItem[] = [];
const NO_PAYOUTS: Payout[] = [];
const SECTION_SCROLL = "scroll-mt-32 lg:scroll-mt-20";

export function CourseDetail({ race, history = EMPTY_HISTORY, signals = NO_SIGNALS, dayIndex = NO_RACES, payouts = NO_PAYOUTS, frozen }: CourseDetailProps) {
  const vm = useMemo(() => buildCourseViewModel(race, history), [race, history]);
  const selection = useMemo(() => buildSelection(race.horses), [race.horses]);
  const signalMap = useMemo(() => new Map(signals.map((s) => [s.key, s])), [signals]);
  const ctx = useMemo(() => raceToContext(race), [race]);
  const recommendations = useMemo(() => buildBetRecommendations(race.horses, race.betTypes, ctx), [race.horses, race.betTypes, ctx]);
  const xTickets = useMemo(() => buildXTickets(race.horses, race.betTypes, ctx), [race.horses, race.betTypes, ctx]);
  const postRace = useMemo(() => buildPostRaceAnalysis(race), [race]);
  const magicRunners = useMemo(() => {
    const out = new Set(vm.nonRunners.map((r) => r.horse.number));
    return selection.field
      .filter((s) => !out.has(s.horse.number))
      .map((s) => ({ number: s.horse.number, name: s.horse.horse, winProbability: s.horse.winProbability }));
  }, [selection, vm.nonRunners]);

  const [selectedNumber, setSelectedNumber] = useState<number | null>(() => vm.rows[0]?.horse.number ?? null);
  const selectedRow = vm.rows.find((r) => r.horse.number === selectedNumber) ?? vm.rows[0] ?? null;
  const finished = race.horses.some((h) => h.finishPosition != null);

  // Comparateur : les numéros qui ont quitté le peloton (relance) sont ignorés.
  const [compareRaw, setCompare] = useState<number[]>([]);
  const compare = compareRaw.filter((n) => vm.rows.some((r) => r.horse.number === n));
  const onToggleCompare = useCallback((n: number) => setCompare((list) => toggleCompare(list, n)), []);

  const summary = useMemo(
    () =>
      beginnerSummary({
        reading: vm.verdict.reading,
        top: vm.rows.filter((r) => !r.nonRunner).slice(0, 3).map((r) => ({ number: r.horse.number, name: r.horse.horse, win: r.horse.winProbability })),
        oddsAvailable: race.oddsAvailable !== false,
        finished,
      }),
    [vm, race.oddsAvailable, finished],
  );

  // Analyse de dernière minute : photographie avant la relance, comparaison
  // une fois la page recalculée avec les nouvelles données.
  const vmRef = useRef(vm);
  useEffect(() => {
    vmRef.current = vm;
  }, [vm]);
  const baselineRef = useRef<AnalysisSnapshot | null>(null);
  const vmAtDoneRef = useRef<typeof vm | null>(null);
  const [pending, setPending] = useState<RelaunchResult | null>(null);
  const [report, setReport] = useState<{ diff: AnalysisDiff; result: RelaunchResult } | null>(null);

  const onRelaunchStart = useCallback(() => {
    baselineRef.current = snapshotAnalysis(vmRef.current);
  }, []);
  const onRelaunchDone = useCallback((result: RelaunchResult) => {
    vmAtDoneRef.current = vmRef.current;
    setPending(result);
  }, []);

  useEffect(() => {
    const baseline = baselineRef.current;
    if (!pending || !baseline) return;
    const finish = () => {
      const diff = diffAnalysis(baseline, snapshotAnalysis(vm));
      // Une relance automatique sans effet ne vient pas interrompre la lecture.
      if (!pending.auto || hasChanges(diff)) setReport({ diff, result: pending });
      baselineRef.current = null;
      setPending(null);
    };
    // Page recalculée : on compare tout de suite. Sinon (rien de neuf côté
    // serveur), on conclut après quelques secondes.
    const timer = setTimeout(finish, vm !== vmAtDoneRef.current ? 0 : 5000);
    return () => clearTimeout(timer);
  }, [pending, vm]);

  function select(number: number) {
    setSelectedNumber(number);
    document.getElementById("fiche-cheval")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  const selected = selectedRow?.horse.number ?? null;

  return (
    <OddsFlashProvider rows={vm.rows}>
    <TabCountdown race={race} />
    <main className="min-h-screen bg-bg pb-20" id="contenu-principal">
      <div className="mx-auto max-w-[1520px] px-4 pt-6 sm:px-6 lg:px-8">
        <nav aria-label="Fil d'Ariane" className="mb-4 flex flex-wrap items-center gap-2">
          <Link
            className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-surface px-3.5 py-2 text-sm font-medium text-muted shadow-sm transition hover:border-accent hover:text-accent-text"
            href="/"
          >
            <ArrowLeft size={14} /> Accueil
          </Link>
          <span aria-hidden="true" className="text-muted/40">/</span>
          <span className="text-sm text-muted">R{race.reunionNumber} — {properName(race.racecourse)}</span>
          <span aria-hidden="true" className="text-muted/40">/</span>
          <span className="text-sm font-semibold text-fg">{race.programCode} — {properName(race.name)}</span>
          <Link
            className="inline-flex items-center gap-1.5 rounded-xl border border-accent/40 bg-accent-lo px-3.5 py-2 text-sm font-semibold text-accent-text shadow-sm transition hover:border-accent sm:ml-auto"
            href={`/races/${encodeURIComponent(race.id)}/forme`}
          >
            <Timer aria-hidden="true" size={14} /> Chronos, poids et forme
          </Link>
        </nav>

        <CourseHeader
          dayIndex={dayIndex}
          finished={finished}
          lastObservation={vm.lastObservation}
          onRelaunchDone={onRelaunchDone}
          onRelaunchStart={onRelaunchStart}
          race={race}
        />

        <SectionNavBar />

        <div className="lg:grid lg:grid-cols-[150px_minmax(0,1fr)] lg:gap-6">
          <div className="hidden pt-4 lg:block">
            <SectionNavRail />
          </div>

          <div className="min-w-0">
            <ArrivalRecap payouts={payouts} postRace={postRace} race={race} vm={vm} />
            <NonRunners rows={vm.nonRunners} />

            {race.oddsAvailable === false && (
              <div className="mt-4 flex items-start gap-3 rounded-2xl border border-warn/30 bg-warn-lo px-4 py-3 text-sm leading-6 text-warn sm:px-5" role="status">
                <AlertTriangle aria-hidden="true" className="mt-1 shrink-0" size={16} />
                <p>
                  <strong className="font-bold">Cotes PMU non encore publiées pour cette course.</strong> Le classement repose
                  sur l&apos;IA seule et sera recalculé dès l&apos;ouverture du marché.
                </p>
              </div>
            )}

            <VisitChanges raceId={race.id} vm={vm} />

            {report && (
              <AnalysisReport diff={report.diff} onClose={() => setReport(null)} onSelect={select} result={report.result} />
            )}

            <div className={SECTION_SCROLL} id="verdict">
              <VerdictBanner onSelect={select} selectedNumber={selected} signals={signalMap} summary={summary} vm={vm} />
            </div>

            <div className="mt-0 grid grid-cols-[minmax(0,1fr)] gap-x-4 xl:grid-cols-[minmax(0,1fr)_360px]">
              <div className="min-w-0">
                <RaceSelectionPanel onSelect={select} selectedNumber={selected} selection={selection} signals={signalMap} />
                <div className={SECTION_SCROLL} id="surprises">
                  <SurprisePanel onSelect={select} selectedNumber={selected} signals={signalMap} vm={vm} />
                </div>
                <div className={SECTION_SCROLL} id="pronostiqueurs">
                  <PressPanel onSelect={select} signals={signalMap} vm={vm} />
                </div>
                <FieldTable
                  compare={compare}
                  onSelect={select}
                  onToggleCompare={onToggleCompare}
                  race={race}
                  selectedNumber={selected}
                  signals={signalMap}
                  vm={vm}
                />
                <HorseCompare compare={compare} onClear={() => setCompare([])} onRemove={onToggleCompare} race={race} rows={vm.rows} />
                <div className={SECTION_SCROLL} id="carre-magique">
                  <MagicSquarePanel onSelect={select} runners={magicRunners} selectedNumber={selected} />
                </div>
                <div className={SECTION_SCROLL} id="fiche-cheval">
                  <HorseSheet
                    compareFull={compare.length >= COMPARE_MAX}
                    compared={selected !== null && compare.includes(selected)}
                    onToggleCompare={onToggleCompare}
                    race={race}
                    row={selectedRow}
                  />
                </div>
                <div className={`mt-4 grid gap-3 ${SECTION_SCROLL}`} id="tickets">
                  <TicketShare programCode={race.programCode} raceId={race.id} recommendations={recommendations} />
                  <TicketTools recommendations={recommendations} xTickets={xTickets} />
                </div>
              </div>

              <aside className="mt-4 grid content-start gap-4" aria-label="Marché et simulation">
                <div className={`grid gap-4 ${SECTION_SCROLL}`} id="marche">
                  <MarketPanel history={history} row={selectedRow} />
                  <AllOddsChart history={history} rows={vm.rows} selectedNumber={selected} />
                </div>
                <div className={SECTION_SCROLL} id="simulation">
                  <SimulationPanel race={race} row={selectedRow} />
                </div>
                <div className={SECTION_SCROLL} id="apres-course">
                  <PostRacePanel analysis={postRace} />
                </div>
                {frozen}
              </aside>
            </div>

            <div className={SECTION_SCROLL} id="mises-direct">
              <StakeBoardPanel onSelect={select} race={race} signals={signalMap} vm={vm} />
            </div>
          </div>
        </div>
      </div>
    </main>
    </OddsFlashProvider>
  );
}
