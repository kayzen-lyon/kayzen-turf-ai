"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowRight, ArrowUp, Coins } from "lucide-react";
import { Card, Eyebrow, roiLine, signedPct } from "@/components/course/shared";
import { STANCE_LABELS, type Stance } from "@/lib/confrontation";
import type { CourseViewModel, HorseRow } from "@/lib/course-view-model";
import { formatEuros, formatOdds, properName } from "@/lib/format";
import { instantDepart } from "@/lib/paris-time";
import type { SignalRecord } from "@/lib/race-repository";
import { aiStrengthScore, STAKE_WINDOW_MIN, type StakeBoard as Board, type StakeRunner } from "@/lib/stake-board";
import type { RaceAnalysis } from "@/lib/types";

/**
 * MISES EN DIRECT — un seul tableau : cotes PMU+ et PMU Play, mises cumulées,
 * argent reçu sur les dernières minutes et note de force de l'IA. Classement
 * par argent reçu, relu chaque minute jusqu'au départ (définitions :
 * lib/stake-board).
 */

const REFRESH_MS = 60_000;
/** Dernière lecture après le départ, le temps que le PMU clôture les enjeux. */
const LAST_READ_AFTER_MS = 5 * 60_000;
const timeFmt = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" });

const STANCE_STYLES: Record<Stance, string> = {
  accord: "bg-accent-lo text-accent-text",
  ia: "bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-200",
  marche: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
};

type Payload = { board: Board | null; updatedAt: string | null; international?: boolean };

function useStakeBoard(raceId: string, departAt: number | null) {
  const [data, setData] = useState<Payload | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const url = `/api/races/${encodeURIComponent(raceId)}/stakes`;
    const load = async () => {
      try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) {
          // Corps lu même en erreur : non lu, la requête restait ouverte et le
          // réseau de la page ne se calmait jamais (test d'accessibilité en CI).
          await response.body?.cancel().catch(() => undefined);
          throw new Error(String(response.status));
        }
        setData((await response.json()) as Payload);
        setFailed(false);
      } catch {
        // En cas d'échec, les derniers montants restent affichés.
        if (!controller.signal.aborted) setFailed(true);
      }
    };
    const stillLive = () => departAt === null || Date.now() < departAt + LAST_READ_AFTER_MS;
    const tick = () => {
      if (!stillLive()) clearInterval(timer);
      else if (document.visibilityState === "visible") void load();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible" && stillLive()) void load();
    };
    void load();
    const timer = setInterval(tick, REFRESH_MS);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      controller.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [raceId, departAt]);

  return { data, failed };
}

function Evolution({ runner }: { runner: StakeRunner }) {
  if (runner.delta === null) return <span className="text-muted">—</span>;
  const tone = runner.trend === "up" ? "text-accent-text" : runner.trend === "down" ? "text-danger" : "text-muted";
  const Icon = runner.trend === "up" ? ArrowUp : runner.trend === "down" ? ArrowDown : ArrowRight;
  const label = runner.trend === "up" ? "part des mises en hausse" : runner.trend === "down" ? "part des mises en baisse" : "stable";
  return (
    <span className={`inline-flex items-center justify-end gap-1.5 font-mono ${tone}`}>
      <Icon aria-label={label} size={16} strokeWidth={3} />
      <span className="text-right leading-4">
        <span className="block font-bold">{signedPct(runner.deltaPct, 1)}</span>
        <span className="block text-[11px]">{runner.delta > 0 ? "+" : ""}{formatEuros(runner.delta, 0)}</span>
      </span>
    </span>
  );
}

function ScorePill({ score }: { score: number | null }) {
  if (score === null) return <span className="text-muted">—</span>;
  const tone = score >= 65 ? "bg-accent text-accent-fg" : score >= 45 ? "bg-accent-lo text-accent-text" : "bg-surface-sub text-muted";
  return <span className={`inline-flex min-w-11 justify-center rounded-full px-2 py-0.5 font-mono text-sm font-bold ${tone}`}>{score}</span>;
}

export function StakeBoardPanel({ race, vm, onSelect, signals }: {
  race: RaceAnalysis;
  vm: CourseViewModel;
  onSelect: (number: number) => void;
  signals: Map<string, SignalRecord>;
}) {
  const departAt = useMemo(() => instantDepart(race.raceDate, race.startTime)?.getTime() ?? null, [race.raceDate, race.startTime]);
  const { data, failed } = useStakeBoard(race.id, departAt);

  const byNumber = useMemo(() => new Map<number, HorseRow>(vm.rows.map((r) => [r.horse.number, r])), [vm.rows]);
  const fieldSize = vm.rows.filter((r) => !r.nonRunner).length;
  const board = data?.board ?? null;
  const runners = (board?.runners ?? []).filter((r) => {
    const row = byNumber.get(r.number);
    return row && !row.nonRunner;
  });
  const windowMin = board?.windowMinutes ?? null;
  const signal = signals.get("mvt-joue-sg");

  return (
    <Card className="mt-4 overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border p-5">
        <div>
          <div className="flex items-center gap-2">
            <Coins aria-hidden="true" className="text-accent-text" size={16} />
            <Eyebrow>Mises en direct</Eyebrow>
          </div>
          <h2 className="mt-1 text-lg font-bold text-fg">PMU+ / PMU Play × Force IA</h2>
        </div>
        {board ? (
          <div className="text-right text-xs text-muted" aria-live="polite">
            <p className="text-base font-bold text-fg">{formatEuros(board.totalStake, 0)} engagés</p>
            <p>
              {board.poolDeltaPct !== null ? `${signedPct(board.poolDeltaPct, 1)} en ${windowMin} min · ` : ""}
              {data?.updatedAt ? `publié par le PMU à ${timeFmt.format(new Date(data.updatedAt))}` : "heure de publication inconnue"}
            </p>
          </div>
        ) : null}
      </div>

      {data?.international && runners.length > 0 ? (
        <p className="border-b border-border bg-surface-sub px-5 py-2 text-xs text-muted">
          Course internationale : le PMU met en commun les paris en point de vente et en ligne. Les mises et les cotes affichées sous PMU+ sont celles de cette masse commune ; il n&apos;existe pas de chiffres séparés pour PMU Play.
        </p>
      ) : null}

      {runners.length === 0 ? (
        <p className="p-5 text-sm text-muted" role="status">
          {failed
            ? "Le PMU ne répond pas pour le moment : nouvelle tentative dans une minute."
            : data
              ? "Le PMU n'a encore publié aucune mise pour cette course. Le tableau se remplira à l'ouverture des paris."
              : "Lecture des mises…"}
        </p>
      ) : (
        <>
          <div className="kz-scroll overflow-x-auto">
            <table className="w-full min-w-[860px] text-sm">
              <caption className="sr-only">Mises par cheval, du plus d&apos;argent reçu au moins d&apos;argent reçu</caption>
              <thead className="bg-surface-sub text-[11px] font-bold uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-3 py-2 text-left" rowSpan={2} scope="col">#</th>
                  <th className="px-3 py-2 text-left" rowSpan={2} scope="col">Cheval</th>
                  <th className="border-l border-border px-3 pt-2 text-center" colSpan={2} scope="colgroup" title="Paris en point de vente">PMU+</th>
                  <th className="border-l border-border px-3 pt-2 text-center" colSpan={2} scope="colgroup" title="Paris en ligne">PMU Play</th>
                  <th className="border-l border-border px-3 py-2 text-right" rowSpan={2} scope="col">Total mises</th>
                  <th className="px-3 py-2 text-right" rowSpan={2} scope="col">Évolution{windowMin !== null ? ` (${windowMin} min)` : ""}</th>
                  <th className="border-l border-border px-3 py-2 text-center" rowSpan={2} scope="col">Force IA /100</th>
                  <th className="px-3 py-2 text-left" rowSpan={2} scope="col">Lecture</th>
                </tr>
                <tr className="normal-case">
                  <th className="border-l border-border px-3 pb-2 text-right font-semibold" scope="col">Matin</th>
                  <th className="px-3 pb-2 text-right font-semibold" scope="col">Actuelle</th>
                  <th className="border-l border-border px-3 pb-2 text-right font-semibold" scope="col">Matin</th>
                  <th className="px-3 pb-2 text-right font-semibold" scope="col">Actuelle</th>
                </tr>
              </thead>
              <tbody>
                {runners.map((runner, index) => {
                  const row = byNumber.get(runner.number)!;
                  return (
                    <tr className="border-t border-border" key={runner.number}>
                      <td className="px-3 py-2 font-mono font-bold text-fg">{index + 1}</td>
                      <td className="px-3 py-2">
                        <button className="text-left font-semibold text-fg hover:text-accent-text" onClick={() => onSelect(runner.number)} type="button">
                          n° {runner.number} · {properName(row.horse.horse)}
                        </button>
                        <span className="block text-xs text-muted">{properName(row.horse.jockey)} · {properName(row.horse.trainer)}</span>
                      </td>
                      <td className="border-l border-border px-3 py-2 text-right font-mono text-muted">{formatOdds(runner.morningOffline)}</td>
                      <td className="px-3 py-2 text-right font-mono font-semibold text-fg">{formatOdds(runner.currentOffline)}</td>
                      <td className="border-l border-border px-3 py-2 text-right font-mono text-muted">{formatOdds(runner.morningOnline)}</td>
                      <td className="px-3 py-2 text-right font-mono font-semibold text-fg">{formatOdds(runner.currentOnline)}</td>
                      <td className="border-l border-border px-3 py-2 text-right font-mono font-bold text-fg">{formatEuros(runner.total, 0)}</td>
                      <td className="px-3 py-2 text-right"><Evolution runner={runner} /></td>
                      <td className="border-l border-border px-3 py-2 text-center"><ScorePill score={aiStrengthScore(row.ai, fieldSize)} /></td>
                      <td className="px-3 py-2">
                        {row.stance ? (
                          <span className={`inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-bold ${STANCE_STYLES[row.stance]}`}>{STANCE_LABELS[row.stance]}</span>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="grid gap-1.5 border-t border-border p-5 text-[11px] leading-5 text-muted">
            <p>
              <strong className="text-fg">Classement :</strong> {windowMin !== null
                ? `le cheval qui a reçu le plus d'argent depuis le relevé d'il y a ${windowMin} min d'abord.`
                : `par mises cumulées, jusqu'à disposer d'un relevé vieux d'au moins ${STAKE_WINDOW_MIN} min.`} Relu chaque minute jusqu&apos;au départ.
            </p>
            <p>
              <strong className="text-fg">Flèches :</strong> les mises d&apos;un cheval ne baissent pas en pari mutuel. Verte : il reçoit plus vite que la course, sa part monte. Rouge : moins vite, sa part baisse.
            </p>
            <p>
              <strong className="text-fg">Force IA :</strong> calculée sur les performances, l&apos;entraîneur et le jockey, sans jamais voir la cote. 50 = chance moyenne de cette course, +14 points quand la chance double. Ce n&apos;est pas une promesse de victoire.
            </p>
            {signal ? (
              <p>
                <strong className="text-fg">À savoir :</strong> jouer le cheval le plus soutenu n&apos;a pas été rentable jusqu&apos;ici ({roiLine(signal.roi, signal.bets)}, simple gagnant).
              </p>
            ) : null}
          </div>
        </>
      )}
    </Card>
  );
}
