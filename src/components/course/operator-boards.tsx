"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowRight, ArrowUp, Scale } from "lucide-react";
import { Card, Eyebrow } from "@/components/course/shared";
import type { CourseViewModel, HorseRow } from "@/lib/course-view-model";
import { formatOdds, properName } from "@/lib/format";
import {
  compareOperators,
  FINAL_WINDOW_MIN,
  OPERATOR_LABELS,
  STABLE_PCT,
  type OperatorKey,
  type OperatorRow,
  type OperatorTable,
} from "@/lib/operator-board";
import { instantDepart } from "@/lib/paris-time";
import type { RaceAnalysis } from "@/lib/types";

/**
 * MARCHÉ PAR OPÉRATEUR — trois tableaux indépendants (ZEturf, Genybet, PMU+) :
 * classement et cote du matin, cote actuelle, évolution, classement actuel et
 * classement final des deux dernières minutes, puis les écarts entre
 * opérateurs. Relu chaque minute jusqu'au départ (définitions :
 * lib/operator-board).
 */

const REFRESH_MS = 60_000;
/** Dernière lecture après le départ, le temps que les cotes de clôture soient publiées. */
const LAST_READ_AFTER_MS = 5 * 60_000;
const timeFmt = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" });

type Payload = {
  operators: Array<{ key: OperatorKey; label: string; table: OperatorTable }>;
  startAt: string | null;
  pmuUpdatedAt: string | null;
};

function useOperatorBoards(raceId: string, departAt: number | null) {
  const [data, setData] = useState<Payload | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const url = `/api/races/${encodeURIComponent(raceId)}/operators`;
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
        // En cas d'échec, les dernières cotes restent affichées.
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

function hour(iso: string | null): string | null {
  return iso && Number.isFinite(Date.parse(iso)) ? timeFmt.format(new Date(iso)) : null;
}

function ordinal(rank: number | null): string {
  return rank === null ? "—" : `${rank}${rank === 1 ? "er" : "e"}`;
}

function signed(value: number): string {
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toFixed(1).replace(".", ",")}`;
}

/** Une cote qui baisse = cheval joué (vert) ; qui monte = délaissé (rouge). Flèche et signe portent l'information, pas la couleur seule. */
function Evolution({ row }: { row: OperatorRow }) {
  if (row.direction === null || row.change === null) return <span className="text-muted">—</span>;
  const tone = row.direction === "baisse" ? "text-accent-text" : row.direction === "hausse" ? "text-danger" : "text-muted";
  const Icon = row.direction === "baisse" ? ArrowDown : row.direction === "hausse" ? ArrowUp : ArrowRight;
  const label = row.direction === "baisse" ? "en baisse" : row.direction === "hausse" ? "en hausse" : "stable";
  return (
    <span className={`inline-flex items-center justify-end gap-1 font-mono font-bold ${tone}`}>
      <Icon aria-hidden="true" size={14} strokeWidth={3} />
      <span>{signed(row.change)}</span>
      <span className="sr-only">, cote {label}</span>
    </span>
  );
}

function RankMove({ gain }: { gain: number | null }) {
  if (gain === null) return <span className="text-muted">—</span>;
  if (gain === 0) return <span className="text-muted">=</span>;
  const places = Math.abs(gain);
  return (
    <span className={`font-mono font-bold ${gain > 0 ? "text-accent-text" : "text-danger"}`}>
      {gain > 0 ? "+" : "−"}
      {places}
      <span className="sr-only">
        {" "}
        {places > 1 ? (gain > 0 ? "places gagnées" : "places perdues") : gain > 0 ? "place gagnée" : "place perdue"} depuis le matin
      </span>
    </span>
  );
}

const TH = "px-3 py-2";

function morningNote(key: OperatorKey, table: OperatorTable): string {
  if (table.morningFromOperator) return key === "pmu" ? "cote de référence du PMU, figée avant son recalage à 30 min du départ" : `cote de référence publiée par ${OPERATOR_LABELS[key]}`;
  const at = hour(table.morningAt);
  return at ? `notre premier relevé du jour, à ${at}` : "pas encore de second relevé : aucune évolution à afficher";
}

function OperatorCard({ operatorKey, label, table, byNumber, onSelect }: {
  operatorKey: OperatorKey;
  label: string;
  table: OperatorTable;
  byNumber: Map<number, HorseRow>;
  onSelect: (number: number) => void;
}) {
  const rows = table.rows.filter((r) => byNumber.has(r.number));
  const titleId = `titre-operateur-${operatorKey}`;
  const finalAt = hour(table.finalAt);
  return (
    <section aria-labelledby={titleId} className="border-t border-border">
      <div className="flex flex-wrap items-baseline justify-between gap-2 bg-surface-sub px-5 py-3">
        <h3 className="text-base font-bold text-fg" id={titleId}>{label}</h3>
        <p className="text-xs text-muted">
          {rows.length > 0 ? `Cotes relevées à ${hour(table.currentAt) ?? "—"}` : "Aucune cote relevée pour cette course"}
        </p>
      </div>
      {rows.length === 0 ? (
        <p className="px-5 py-4 text-sm text-muted">
          {operatorKey === "pmu"
            ? "Le PMU n'a encore publié aucune cote pour cette course."
            : `Les cotes ${label} sont relevées le matin, puis à 60, 15, 5 et 2 minutes du départ. Aucun relevé n'existe encore pour cette course.`}
        </p>
      ) : (
        <>
          <div className="kz-scroll overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <caption className="sr-only">
                {label} : classement et cote du matin, cote actuelle, évolution, classement actuel et classement final, du favori actuel au plus délaissé
              </caption>
              <thead className="bg-surface-sub text-[11px] font-bold uppercase tracking-wide text-muted">
                <tr>
                  <th className={`${TH} text-left`} scope="col">Cheval</th>
                  <th className={`${TH} text-right`} scope="col">Rang matin</th>
                  <th className={`${TH} text-right`} scope="col">Cote matin</th>
                  <th className={`${TH} text-right`} scope="col">Cote actuelle</th>
                  <th className={`${TH} text-right`} scope="col">Évolution</th>
                  <th className={`${TH} text-right`} scope="col">Rang actuel</th>
                  <th className={`${TH} text-right`} scope="col">Places</th>
                  <th className={`${TH} border-l border-border text-right`} scope="col">Final ({FINAL_WINDOW_MIN} min)</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const horse = byNumber.get(row.number)!.horse;
                  return (
                    <tr className="border-t border-border" key={row.number}>
                      <th className="px-3 py-2 text-left font-normal" scope="row">
                        <button className="text-left font-semibold text-fg hover:text-accent-text" onClick={() => onSelect(row.number)} type="button">
                          n° {row.number} · {properName(horse.horse)}
                        </button>
                      </th>
                      <td className="px-3 py-2 text-right font-mono text-muted">{ordinal(row.morningRank)}</td>
                      <td className="px-3 py-2 text-right font-mono text-muted">{formatOdds(row.morningOdds)}</td>
                      <td className="px-3 py-2 text-right font-mono font-bold text-fg">{formatOdds(row.currentOdds)}</td>
                      <td className="px-3 py-2 text-right"><Evolution row={row} /></td>
                      <td className="px-3 py-2 text-right font-mono font-bold text-fg">{ordinal(row.currentRank)}</td>
                      <td className="px-3 py-2 text-right"><RankMove gain={row.rankGain} /></td>
                      <td className="border-l border-border px-3 py-2 text-right font-mono">
                        {row.finalRank === null ? (
                          <span className="text-muted">—</span>
                        ) : (
                          <>
                            <span className="font-bold text-fg">{ordinal(row.finalRank)}</span>
                            <span className="ml-1.5 text-xs text-muted">{formatOdds(row.finalOdds)}</span>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="px-5 py-3 text-[11px] leading-5 text-muted">
            <strong className="text-fg">Matin :</strong> {morningNote(operatorKey, table)}.{" "}
            <strong className="text-fg">Final :</strong>{" "}
            {finalAt ? `relevé à ${finalAt}, dans les ${FINAL_WINDOW_MIN} dernières minutes avant le départ.` : `rempli par le relevé fait dans les ${FINAL_WINDOW_MIN} dernières minutes avant le départ.`}
          </p>
        </>
      )}
    </section>
  );
}

function Comparison({ operators, byNumber, onSelect }: {
  operators: Payload["operators"];
  byNumber: Map<number, HorseRow>;
  onSelect: (number: number) => void;
}) {
  const withRows = operators.filter((o) => o.table.rows.length > 0);
  const rows = compareOperators(withRows.map((o) => ({ key: o.key, table: o.table })))
    .filter((r) => byNumber.has(r.number))
    .sort((a, b) => (b.rankSpread ?? -1) - (a.rankSpread ?? -1) || a.number - b.number);
  if (withRows.length < 2 || rows.length === 0) return null;
  return (
    <section aria-labelledby="titre-ecarts-operateurs" className="border-t border-border">
      <div className="flex flex-wrap items-baseline justify-between gap-2 bg-surface-sub px-5 py-3">
        <h3 className="text-base font-bold text-fg" id="titre-ecarts-operateurs">Écarts entre opérateurs</h3>
        <p className="text-xs text-muted">du plus grand écart de classement au plus petit</p>
      </div>
      <div className="kz-scroll overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <caption className="sr-only">Rang et cote actuels de chaque cheval chez chaque opérateur, et meilleure cote</caption>
          <thead className="bg-surface-sub text-[11px] font-bold uppercase tracking-wide text-muted">
            <tr>
              <th className={`${TH} text-left`} scope="col">Cheval</th>
              {withRows.map((o) => (
                <th className={`${TH} text-right`} key={o.key} scope="col">{o.label}</th>
              ))}
              <th className={`${TH} text-right`} scope="col">Écart de rang</th>
              <th className={`${TH} text-right`} scope="col">Meilleure cote</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr className="border-t border-border" key={row.number}>
                <th className="px-3 py-2 text-left font-normal" scope="row">
                  <button className="text-left font-semibold text-fg hover:text-accent-text" onClick={() => onSelect(row.number)} type="button">
                    n° {row.number} · {properName(byNumber.get(row.number)!.horse.horse)}
                  </button>
                </th>
                {withRows.map((o) => (
                  <td className="px-3 py-2 text-right font-mono" key={o.key}>
                    <span className="font-bold text-fg">{ordinal(row.ranks[o.key] ?? null)}</span>
                    <span className="ml-1.5 text-xs text-muted">{formatOdds(row.odds[o.key] ?? null)}</span>
                  </td>
                ))}
                <td className="px-3 py-2 text-right font-mono">{row.rankSpread === null ? "—" : row.rankSpread}</td>
                <td className="px-3 py-2 text-right font-mono">
                  {row.best ? (
                    <>
                      <span className="font-bold text-fg">{formatOdds(row.best.odds)}</span>
                      <span className="ml-1.5 text-xs text-muted">{OPERATOR_LABELS[row.best.key]}</span>
                    </>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function OperatorBoardsPanel({ race, vm, onSelect }: {
  race: RaceAnalysis;
  vm: CourseViewModel;
  onSelect: (number: number) => void;
}) {
  const departAt = useMemo(() => instantDepart(race.raceDate, race.startTime)?.getTime() ?? null, [race.raceDate, race.startTime]);
  const { data, failed } = useOperatorBoards(race.id, departAt);
  const byNumber = useMemo(() => new Map<number, HorseRow>(vm.rows.filter((r) => !r.nonRunner).map((r) => [r.horse.number, r])), [vm.rows]);
  const pmuAt = hour(data?.pmuUpdatedAt ?? null);

  return (
    <Card className="mt-4 overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-3 p-5">
        <div>
          <div className="flex items-center gap-2">
            <Scale aria-hidden="true" className="text-accent-text" size={16} />
            <Eyebrow>Mouvements du marché</Eyebrow>
          </div>
          <h2 className="mt-1 text-lg font-bold text-fg">Marché par opérateur : ZEturf, Genybet, PMU+</h2>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-muted">
            Chaque opérateur a ses propres parieurs et ses propres cotes. Le classement du matin est gardé pour voir qui a progressé ou reculé.
          </p>
        </div>
        <p aria-live="polite" className="text-right text-xs text-muted">
          {failed ? "Lecture impossible pour le moment : nouvelle tentative dans une minute." : pmuAt ? `PMU publié à ${pmuAt}` : data ? "" : "Lecture des cotes…"}
        </p>
      </div>

      {data?.operators.map((o) => (
        <OperatorCard byNumber={byNumber} key={o.key} label={o.label} onSelect={onSelect} operatorKey={o.key} table={o.table} />
      ))}
      {data ? <Comparison byNumber={byNumber} onSelect={onSelect} operators={data.operators} /> : null}

      <div className="grid gap-1.5 border-t border-border p-5 text-[11px] leading-5 text-muted">
        <p>
          <strong className="text-fg">Lecture :</strong> une cote qui baisse (flèche vers le bas) veut dire que le cheval est joué ; une cote qui monte, qu&apos;il est délaissé. Sous {STABLE_PCT} % d&apos;écart, la cote est dite stable. « Places » : places gagnées (+) ou perdues (−) au classement depuis le matin.
        </p>
        <p>
          <strong className="text-fg">Relevés :</strong> PMU+ est lu chaque minute sur les paris en point de vente. ZEturf et Genybet sont relevés le matin, puis à 60, 15, 5 et 2 minutes du départ ; leur cote « actuelle » est donc celle du dernier relevé, dont l&apos;heure est indiquée.
        </p>
        <p>
          <strong className="text-fg">À savoir :</strong> ces tableaux décrivent le marché, ils ne recommandent aucun pari. Une cote qui baisse ne garantit rien.
        </p>
      </div>
    </Card>
  );
}
