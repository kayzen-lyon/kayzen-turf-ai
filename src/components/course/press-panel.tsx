"use client";

import { useMemo, type ReactNode } from "react";
import { Newspaper } from "lucide-react";
import type { CourseViewModel, HorseRow } from "@/lib/course-view-model";
import { formatOdds, properName } from "@/lib/format";
import { PRESS_SOURCE_ORDER, agreementLabel, sourceLabel, type PressCategory } from "@/lib/press-consensus";
import { pressComment, pressSummary, type PressSummaryInput } from "@/lib/press-summary";
import type { SignalRecord } from "@/lib/race-repository";
import { roiLine } from "@/components/course/shared";
import { Term } from "@/components/course/term";

/**
 * PRONOSTICS DE LA PRESSE × IA — le rang donné par chaque site de pronostics,
 * le total des citations et la chance de victoire de l'IA (qui ne voit jamais
 * la cote), puis les Top 3 presse et IA et le cheval peu cité que l'IA place
 * haut (lib/press-summary). La lecture rappelle la famille presse × marché
 * (lib/press-consensus). Seuls les numéros et leur ordre sont repris des
 * sites, avec leur nom et un lien : jamais leurs textes.
 */

const CATEGORY_BADGES: Record<PressCategory, string> = {
  consensus: "bg-emerald-600 text-white dark:bg-emerald-500 dark:text-emerald-950",
  "sites-sans-marche": "bg-amber-500 text-amber-950",
  "marche-sans-sites": "bg-sky-600 text-white dark:bg-sky-500 dark:text-sky-950",
};

/** Signaux du backtest rappelés sous le panneau. */
export const PRESS_SIGNALS = ["presse-consensus-sg", "presse-sites-sans-marche-sg", "presse-marche-sans-sites-sg"];

export function PressPanel({
  vm,
  signals,
  onSelect,
}: {
  vm: CourseViewModel;
  signals: Map<string, SignalRecord>;
  onSelect: (number: number) => void;
}) {
  const { selections, agreement } = vm.press;
  const sources = [...selections].sort((a, b) => PRESS_SOURCE_ORDER.indexOf(a.source) - PRESS_SOURCE_ORDER.indexOf(b.source));
  const rows = vm.rows.filter((r) => r.press && !r.nonRunner);
  const summary = useMemo(
    () => pressSummary(rows.map((r) => ({ number: r.horse.number, name: r.horse.horse, ai: r.ai, press: r.press! }))),
    [rows],
  );
  const tracked = PRESS_SIGNALS.map((key) => signals.get(key)).filter((s): s is SignalRecord => !!s && s.bets > 0);
  const fetched = sources.map((s) => s.fetchedAt).filter((t): t is string => !!t).sort().at(-1);

  return (
    <section aria-labelledby="titre-presse" className="mt-4 overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-surface-sub px-4 py-3 sm:px-5">
        <div className="flex items-center gap-2">
          <Newspaper aria-hidden="true" className="text-accent-text" size={16} />
          <h2 className="text-sm font-bold text-fg" id="titre-presse">
            Pronostics de la presse × IA
          </h2>
        </div>
        {sources.length > 0 && (
          <p className="text-[11px] text-muted">
            {sources.length} source{sources.length > 1 ? "s" : ""} · accord entre sites : <strong className="text-fg">{agreementLabel(agreement)}</strong>
          </p>
        )}
      </div>

      {sources.length === 0 ? (
        <p className="px-4 py-5 text-sm text-muted sm:px-5">
          Les sélections des sites de pronostics ne sont pas encore disponibles pour cette course. Elles sont relevées le matin et
          avant le départ.
        </p>
      ) : (
        <>
          <PressTable onSelect={onSelect} rows={rows} sources={sources.map((s) => s.source)} summary={summary} />
          <div className="grid gap-3 border-t border-border p-3 sm:grid-cols-3 sm:p-4">
            <SummaryCard title="Top 3 selon la presse" tone="border-accent/30 bg-accent-lo">
              {summary.topPress.map((r, i) => (
                <SummaryLine key={r.number} index={i} onSelect={onSelect} row={r} value={`${r.press.citations.length}/${r.press.sources}`} />
              ))}
            </SummaryCard>
            <SummaryCard title="Top 3 selon l'IA" tone="border-violet-500/30 bg-violet-50 dark:bg-violet-950/40">
              {summary.topAi.map((r, i) => (
                <SummaryLine key={r.number} index={i} onSelect={onSelect} row={r} value={pct(r.ai)} />
              ))}
            </SummaryCard>
            <SummaryCard title="Peu cité, bien vu par l'IA" tone="border-amber-500/30 bg-amber-50 dark:bg-amber-950/40">
              {summary.watch ? (
                <SummaryLine
                  onSelect={onSelect}
                  row={summary.watch}
                  value={`${summary.watch.press.citations.length}/${summary.watch.press.sources} · IA ${pct(summary.watch.ai)}`}
                />
              ) : (
                <li className="text-xs text-muted">Aucun : la presse cite déjà les chevaux préférés de l&apos;IA.</li>
              )}
            </SummaryCard>
          </div>
        </>
      )}

      <p className="border-t border-border px-4 py-3 text-[11px] leading-5 text-muted sm:px-5">
        {sources.length > 0 && (
          <>
            Sources :{" "}
            {sources.map((s, i) => (
              <span key={s.source}>
                {i > 0 && ", "}
                {s.url ? (
                  <a className="underline-offset-2 hover:underline" href={s.url} rel="noopener noreferrer" target="_blank">
                    {sourceLabel(s.source)}
                  </a>
                ) : (
                  sourceLabel(s.source)
                )}
              </span>
            ))}
            {fetched && <> — sélections relevées à {new Date(fetched).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" })}</>}
            . Seuls l&apos;ordre et les numéros sont repris, avec l&apos;accord des sites.{" "}
          </>
        )}
        <Term name="Pronostiqueurs × Marché">Règles</Term> : consensus si au moins 60 % des sites citent le cheval et que le marché le
        place dans ses 3 premiers ; alerte si les sites le citent mais que le marché le place au-delà du 5e rang, ou si le marché le place
        dans ses 3 premiers alors qu&apos;au plus 20 % des sites le citent.
        {tracked.length > 0 && (
          <>
            {" "}Historique en simple gagnant :{" "}
            {tracked.map((s, i) => (
              <span key={s.key}>
                {i > 0 && " · "}
                {s.label} <span className={s.roi >= 0 ? "font-bold text-accent-text" : "font-bold text-danger"}>{roiLine(s.roi, s.bets)}</span>
              </span>
            ))}
            .
          </>
        )}
      </p>
    </section>
  );
}

function SummaryCard({ title, tone, children }: { title: string; tone: string; children: ReactNode }) {
  return (
    <div className={`rounded-xl border p-3 ${tone}`}>
      <h3 className="text-xs font-bold text-fg">{title}</h3>
      <ol className="mt-2 grid gap-1.5">{children}</ol>
    </div>
  );
}

function SummaryLine({ row, value, index, onSelect }: { row: PressSummaryInput; value: string; index?: number; onSelect: (n: number) => void }) {
  return (
    <li>
      <button className="flex w-full items-baseline justify-between gap-2 text-left text-sm hover:underline" onClick={() => onSelect(row.number)} type="button">
        <span className="min-w-0 font-semibold text-fg">
          {index !== undefined && <span className="mr-1 text-muted">{index + 1}.</span>}
          <span className="font-mono">{row.number}</span> {properName(row.name)}
        </span>
        <span className="shrink-0 font-mono text-xs font-bold text-fg">{value}</span>
      </button>
    </li>
  );
}

function ordinal(rank: number) {
  return rank === 1 ? "1er" : `${rank}e`;
}

function pct(value: number | null) {
  return value === null ? "—" : `${Math.round(value)} %`;
}

function PressTable({
  rows,
  sources,
  summary,
  onSelect,
}: {
  rows: HorseRow[];
  sources: string[];
  summary: ReturnType<typeof pressSummary>;
  onSelect: (n: number) => void;
}) {
  const byNumber = new Map(rows.map((r) => [r.horse.number, r]));
  const maxAi = Math.max(1, ...summary.rows.map((r) => r.ai ?? 0));
  return (
    <div className="kz-scroll overflow-x-auto">
      <table className="w-full min-w-[760px] border-collapse text-left text-sm">
        <caption className="sr-only">Rang donné par chaque site de pronostics, total des citations et chance de victoire selon l&apos;IA</caption>
        <thead className="bg-surface-sub text-[10px] font-bold uppercase tracking-widest text-muted">
          <tr>
            <th className="px-3 pt-2.5" rowSpan={2} scope="col">Cheval</th>
            <th className="border-l border-border px-2 pt-2.5 text-center" colSpan={sources.length + 1} scope="colgroup">Rang dans la presse</th>
            <th className="border-l border-border px-3 pt-2.5 text-center" rowSpan={2} scope="col">Classement presse</th>
            <th className="border-l border-border px-3 pt-2.5 text-center" rowSpan={2} scope="col">Chance IA</th>
            <th className="px-3 pt-2.5" rowSpan={2} scope="col">Lecture</th>
          </tr>
          <tr>
            {sources.map((s, i) => (
              <th key={s} className={`px-2 pb-2.5 text-center normal-case tracking-normal ${i === 0 ? "border-l border-border" : ""}`} scope="col">
                {sourceLabel(s)}
              </th>
            ))}
            <th className="bg-accent-lo px-2 pb-2.5 text-center text-accent-text" scope="col">Total</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {summary.rows.map((r) => {
            const row = byNumber.get(r.number)!;
            const p = r.press;
            const comment = pressComment(r, summary.aiRank.get(r.number));
            return (
              <tr key={r.number} className="hover:bg-accent-lo/60">
                <th className="px-3 py-2 font-normal" scope="row">
                  <button className="text-left hover:underline" onClick={() => onSelect(r.number)} type="button">
                    <span className="font-mono font-bold text-fg">{r.number}</span> <span className="font-semibold text-fg">{properName(r.name)}</span>
                  </button>
                  <span className="block text-[11px] text-muted">cote {formatOdds(row.horse.odds, 1)}</span>
                </th>
                {sources.map((s, i) => {
                  const c = p.citations.find((x) => x.source === s);
                  return (
                    <td key={s} className={`px-2 py-2 text-center font-mono text-xs ${i === 0 ? "border-l border-border" : ""}`}>
                      {c ? <span className={c.rank <= 3 ? "font-bold text-fg" : "text-muted"}>{c.rank}</span> : <span className="text-muted">—</span>}
                    </td>
                  );
                })}
                <td className="bg-accent-lo/50 px-2 py-2 text-center font-mono font-bold text-fg">
                  {p.citations.length}/{p.sources}
                </td>
                <td className="border-l border-border px-3 py-2 text-center font-mono text-sm">
                  {p.citations.length > 0 ? ordinal(summary.pressRank.get(r.number)!) : "—"}
                </td>
                <td className="border-l border-border px-3 py-2">
                  {r.ai === null ? (
                    <span className="block text-center text-muted">—</span>
                  ) : (
                    <span className="flex items-center gap-2">
                      <span className="w-10 text-right font-mono text-xs font-bold text-fg">{pct(r.ai)}</span>
                      <span aria-hidden="true" className="h-1.5 w-16 overflow-hidden rounded-full bg-surface-sub">
                        <span className="block h-full rounded-full bg-accent" style={{ width: `${Math.round((r.ai / maxAi) * 100)}%` }} />
                      </span>
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-xs text-fg">
                  {p.category ? (
                    <span className={`inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-bold ${CATEGORY_BADGES[p.category]}`}>{comment}</span>
                  ) : (
                    comment || <span className="text-muted">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
