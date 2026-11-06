import { LineChart } from "lucide-react";
import type { HorseRow } from "@/lib/course-view-model";
import { formatOdds, formatPct } from "@/lib/format";
import type { MarketHistory } from "@/lib/market";
import { Card, Eyebrow, pct, signedPct, signedPts } from "@/components/course/shared";

/**
 * PANNEAU MARCHÉ — la cote du cheval sélectionné dans le temps, et sa part des
 * mises PMU. Source unique : le PMU. Aucune autre source n'est autorisée à ce
 * jour (Betfair n'est pas agréé par l'ANJ, les opérateurs n'ouvrent pas d'API).
 */

const timeFmt = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" });
const dayFmt = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", timeZone: "Europe/Paris" });

function Chart({ points, reference, format }: { points: Array<{ t: string; v: number }>; reference?: number | null; format: (v: number) => string }) {
  if (points.length < 2) return null;
  const W = 300;
  const H = 120;
  const PAD = { l: 34, r: 8, t: 8, b: 18 };
  const ts = points.map((p) => new Date(p.t).getTime());
  const vs = points.map((p) => p.v).concat(reference ? [reference] : []);
  const t0 = Math.min(...ts);
  const t1 = Math.max(...ts);
  const lo = Math.min(...vs);
  const hi = Math.max(...vs);
  const span = hi - lo || 1;
  const x = (t: number) => PAD.l + ((t - t0) / (t1 - t0 || 1)) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (1 - (v - lo) / span) * (H - PAD.t - PAD.b);
  const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(ts[i]).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  const sameDay = dayFmt.format(new Date(t0)) === dayFmt.format(new Date(t1));
  const label = (t: number) => (sameDay ? timeFmt.format(new Date(t)) : `${dayFmt.format(new Date(t))} ${timeFmt.format(new Date(t))}`);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`De ${format(points[0].v)} à ${format(points.at(-1)!.v)}`}>
      <line x1={PAD.l} x2={W - PAD.r} y1={y(hi)} y2={y(hi)} stroke="var(--border)" />
      <line x1={PAD.l} x2={W - PAD.r} y1={y(lo)} y2={y(lo)} stroke="var(--border)" />
      <text x={PAD.l - 4} y={y(hi) + 3} fontSize="9" textAnchor="end" fill="var(--muted)">{format(hi)}</text>
      <text x={PAD.l - 4} y={y(lo) + 3} fontSize="9" textAnchor="end" fill="var(--muted)">{format(lo)}</text>
      {reference ? <line x1={PAD.l} x2={W - PAD.r} y1={y(reference)} y2={y(reference)} stroke="var(--muted)" strokeDasharray="3 3" /> : null}
      <path d={d} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      {points.map((p, i) => <circle key={p.t} cx={x(ts[i])} cy={y(p.v)} r="2.2" fill="var(--accent)" />)}
      <text x={PAD.l} y={H - 4} fontSize="9" fill="var(--muted)">{label(t0)}</text>
      <text x={W - PAD.r} y={H - 4} fontSize="9" textAnchor="end" fill="var(--muted)">{label(t1)}</text>
    </svg>
  );
}

export function MarketPanel({ row, history }: { row: HorseRow | null; history: MarketHistory }) {
  if (!row) return null;
  const oddsPoints = (history.odds[row.horse.number] ?? []).map((p) => ({ t: p.t, v: p.odds }));
  const poolPoints = history.pools
    .map((p) => ({ t: p.t, v: p.win[p.numbers.indexOf(row.horse.number)] }))
    .filter((p) => Number.isFinite(p.v));

  return (
    <Card className="p-5">
      <div className="flex items-center gap-2">
        <LineChart aria-hidden="true" className="text-accent-text" size={16} />
        <Eyebrow>Marché PMU · n° {row.horse.number}</Eyebrow>
      </div>
      <p className="mt-1 font-semibold text-fg">{row.horse.horse}</p>

      <div className="mt-4">
        <div className="flex items-baseline justify-between">
          <p className="text-xs font-bold text-fg">Cote</p>
          <p className="font-mono text-xs text-muted">
            matin {formatOdds(row.movement.reference ?? NaN, 1)} → {formatOdds(row.movement.current ?? NaN, 1)}{" "}
            <span className={row.movement.direction === "joue" ? "font-bold text-accent-text" : row.movement.direction === "delaisse" ? "font-bold text-danger" : ""}>
              ({signedPct(row.movement.changePct)})
            </span>
          </p>
        </div>
        {oddsPoints.length >= 2 ? (
          <Chart points={oddsPoints} reference={row.movement.reference} format={(v) => formatOdds(v)} />
        ) : (
          <p className="mt-2 text-xs text-muted">Pas encore assez de relevés pour tracer la cote.</p>
        )}
      </div>

      <div className="mt-4">
        <div className="flex items-baseline justify-between">
          <p className="text-xs font-bold text-fg">Part des mises (simple gagnant)</p>
          <p className="font-mono text-xs text-muted">
            {pct(row.flow.share, 1)} · 15 min {signedPts(row.flow.delta15)} · 5 min {signedPts(row.flow.delta5)}
          </p>
        </div>
        {poolPoints.length >= 2 ? (
          <Chart points={poolPoints} format={(v) => formatPct(v, 1)} />
        ) : (
          <p className="mt-2 text-xs text-muted">Les parts des mises ne sont publiées que le jour de la course, une fois les paris ouverts.</p>
        )}
      </div>

      <p className="mt-4 text-[11px] leading-5 text-muted">
        Source : PMU uniquement. Le PMU publie les enjeux par cheval, jamais par parieur : une part qui monte dit que le cheval
        est davantage joué, pas qui le joue.
      </p>
    </Card>
  );
}
