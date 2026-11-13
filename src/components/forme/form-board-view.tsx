import type { ReactNode } from "react";
import { Activity, Scale, Sparkles, Timer } from "lucide-react";
import { formatMeters, formatOdds, properName } from "@/lib/format";
import {
  FORM_THRESHOLDS,
  FORM_WEIGHTS,
  formatKmTime,
  formatRaceTime,
  type BoardRow,
  type FormBoard,
  type FormLevel,
  type WeightTrend,
} from "@/lib/performances/form-board";
import type { DetailedRun } from "@/lib/performances/pmu-performances";

/**
 * CHRONOS, POIDS ET FORME — tableaux de la page /races/[id]/forme.
 * Composants serveur : aucun script n'est envoyé au navigateur.
 */

const FORM_LABELS: Record<FormLevel, string> = {
  bonne: "Bonne forme",
  moyenne: "Forme moyenne",
  mauvaise: "Mauvaise forme",
  inconnue: "Inconnue",
};

const FORM_STYLES: Record<FormLevel, string> = {
  bonne: "bg-emerald-600 text-white dark:bg-emerald-500 dark:text-emerald-950",
  moyenne: "bg-amber-500 text-amber-950",
  mauvaise: "bg-red-600 text-white dark:bg-red-500 dark:text-red-950",
  inconnue: "border border-border bg-surface-sub text-muted",
};

const WEIGHT_LABELS: Record<WeightTrend, string> = { allege: "Allégé", stable: "Stable", charge: "Chargé" };

const WEIGHT_STYLES: Record<WeightTrend, string> = {
  allege: "text-accent-text",
  stable: "text-muted",
  charge: "text-danger",
};

function frDate(date: string): string {
  const [year, month, day] = date.split("-");
  return year && month && day ? `${day}/${month}/${year}` : date;
}

function kg(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(1).replace(".", ",")} kg`;
}

function signedKg(value: number | null): string {
  if (value === null) return "—";
  const abs = Math.abs(value).toFixed(1).replace(".", ",");
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${abs} kg`;
}

function place(run: Pick<DetailedRun, "position" | "status" | "fieldSize">): string {
  if (run.position === null) return run.status ?? "NC";
  return `${run.position}${run.position === 1 ? "er" : "e"}${run.fieldSize ? `/${run.fieldSize}` : ""}`;
}

export function FormBadge({ level }: { level: FormLevel }) {
  return (
    <span className={`inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${FORM_STYLES[level]}`}>
      {FORM_LABELS[level]}
    </span>
  );
}

function Horse({ row }: { row: BoardRow }) {
  return (
    <>
      <span className="font-mono font-bold text-fg">{row.number}</span> <span className="font-semibold text-fg">{row.name}</span>
    </>
  );
}

function Panel({ id, icon, title, aside, children }: { id: string; icon: ReactNode; title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="mt-4 overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-surface-sub px-4 py-3 sm:px-5">
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className="text-accent-text">{icon}</span>
          <h2 className="text-sm font-bold text-fg" id={id}>{title}</h2>
        </div>
        {aside && <p className="text-[11px] text-muted">{aside}</p>}
      </div>
      {children}
    </section>
  );
}

const TH = "px-3 py-2.5";
const HEAD_ROW = "border-b border-border text-[10px] font-bold uppercase tracking-widest text-muted";

/** Les trois lectures en tête de page, puis les chevaux rapides et en forme hors des favoris. */
export function Highlights({ board, galop }: { board: FormBoard; galop: boolean }) {
  const cards: Array<{ title: string; row: BoardRow | null; detail: string | null; empty: string }> = [
    {
      title: "Le plus rapide sur la distance",
      row: board.fastest,
      detail: board.fastest?.chrono ? `${formatKmTime(board.fastest.chrono.kmTimeMs)} au km · ${properName(board.fastest.chrono.racecourse)}, ${frDate(board.fastest.chrono.date)}` : null,
      empty: "Aucun partant n'a de chrono sur cette distance.",
    },
    {
      title: "La meilleure forme",
      row: board.bestForm,
      detail: board.bestForm?.form.score != null ? `${board.bestForm.form.score}/100${board.bestForm.form.reasons[0] ? ` · ${board.bestForm.form.reasons[0]}` : ""}` : null,
      empty: "Aucune course récente connue.",
    },
  ];
  if (galop) {
    cards.push({
      title: "Le plus allégé",
      row: board.lightest,
      detail: board.lightest ? `${kg(board.lightest.weight.todayKg)}, soit ${signedKg(board.lightest.weight.deltaKg)} par rapport à ses dernières courses` : null,
      empty: "Aucun partant n'est allégé d'au moins un kilo.",
    });
  }
  return (
    <>
      <div className={`mt-4 grid gap-3 ${galop ? "sm:grid-cols-3" : "sm:grid-cols-2"}`}>
        {cards.map((card) => (
          <div key={card.title} className="rounded-2xl border border-border bg-surface p-4 shadow-sm">
            <h2 className="text-xs font-bold uppercase tracking-widest text-muted">{card.title}</h2>
            {card.row ? (
              <>
                <p className="mt-2 text-base"><Horse row={card.row} /></p>
                <p className="mt-1 text-xs leading-5 text-muted">{card.detail}</p>
              </>
            ) : (
              <p className="mt-2 text-sm text-muted">{card.empty}</p>
            )}
          </div>
        ))}
      </div>
      {board.overlooked.length > 0 && (
        <div className="mt-3 flex items-start gap-3 rounded-2xl border border-accent/30 bg-accent-lo px-4 py-3 text-sm leading-6 text-fg sm:px-5" role="note">
          <Sparkles aria-hidden="true" className="mt-1 shrink-0 text-accent-text" size={16} />
          <p>
            <strong className="font-bold">Rapide et en forme, hors des trois favoris du marché : </strong>
            {board.overlooked.map((row, i) => (
              <span key={row.number}>
                {i > 0 && ", "}
                <Horse row={row} /> ({row.chronoRank}
                {row.chronoRank === 1 ? "er" : "e"} chrono, cote {formatOdds(row.odds)})
              </span>
            ))}
            . Un constat sur ses courses passées, pas une promesse de résultat.
          </p>
        </div>
      )}
    </>
  );
}

/** Classement du meilleur chrono au moins bon. */
export function ChronoTable({ board, distance, galop }: { board: FormBoard; distance: string; galop: boolean }) {
  return (
    <Panel
      aside={`${board.timed} partant${board.timed > 1 ? "s" : ""} sur ${board.rows.length} avec un chrono à ${board.toleranceMeters} m près`}
      icon={<Timer size={16} />}
      id="titre-chronos"
      title={`Classement par chrono sur ${formatMeters(distance)}`}
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[860px] border-collapse text-left text-sm">
          <caption className="sr-only">Partants classés du meilleur chrono au moins bon sur la distance de la course</caption>
          <thead>
            <tr className={HEAD_ROW}>
              <th className={`${TH} text-center`} scope="col">Rang</th>
              <th className={TH} scope="col">Cheval</th>
              <th className={`${TH} text-right`} scope="col">Chrono au km</th>
              <th className={`${TH} text-right`} scope="col">Temps de la course</th>
              <th className={TH} scope="col">Réalisé le</th>
              <th className={TH} scope="col">Forme</th>
              {galop && <th className={`${TH} text-right`} scope="col">Poids</th>}
              <th className={`${TH} text-right`} scope="col">Cote</th>
              <th className={TH} scope="col">Jockey · Entraîneur</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {board.rows.map((row) => (
              <tr key={row.number} className={row.chronoRank !== null && row.chronoRank <= 3 ? "bg-accent-lo/50" : undefined}>
                <td className="px-3 py-2 text-center font-mono font-bold text-fg">{row.chronoRank ?? "—"}</td>
                <th className="px-3 py-2 font-normal" scope="row"><Horse row={row} /></th>
                <td className="whitespace-nowrap px-3 py-2 text-right font-mono font-bold text-fg">{formatKmTime(row.chrono?.kmTimeMs)}</td>
                <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-xs text-muted">
                  {row.chrono ? `${formatRaceTime(row.chrono.totalMs)} sur ${row.chrono.distance} m` : "—"}
                </td>
                <td className="px-3 py-2 text-xs leading-5">
                  {row.chrono ? (
                    <>
                      <span className="text-fg">{frDate(row.chrono.date)} · {properName(row.chrono.racecourse)}</span>
                      <span className="block text-muted">
                        {row.chrono.going ? `terrain ${row.chrono.going.toLowerCase()} · ` : ""}
                        {place({ position: row.chrono.position, status: null, fieldSize: null })}
                      </span>
                    </>
                  ) : (
                    <span className="text-muted">{row.runs.length === 0 ? "Aucune course connue" : "Pas de chrono sur cette distance"}</span>
                  )}
                </td>
                <td className="px-3 py-2"><FormBadge level={row.form.level} /></td>
                {galop && <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-xs">{kg(row.weight.todayKg)}</td>}
                <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-xs">{formatOdds(row.odds)}</td>
                <td className="px-3 py-2 text-xs text-muted">{row.jockey} · {row.trainer}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="border-t border-border px-4 py-3 text-[11px] leading-5 text-muted sm:px-5">
        Le chrono au kilomètre (réduction kilométrique) est le temps de la course ramené à 1 000 m : il permet de comparer des courses de
        distances voisines. Seules les courses de la même spécialité, à {board.toleranceMeters} m près de la distance du jour, sont retenues,
        parmi les cinq dernières publiées par le PMU. Un chrono dépend du terrain et du rythme de la course : comparez-le avec la date et le
        terrain indiqués.
      </p>
    </Panel>
  );
}

/** Poids du jour, poids des dernières courses et chrono, par cheval. */
export function WeightTable({ board }: { board: FormBoard }) {
  const rows = [...board.rows].sort((a, b) => (a.weight.deltaKg ?? Infinity) - (b.weight.deltaKg ?? Infinity) || a.number - b.number);
  return (
    <Panel aside="du plus allégé au plus chargé" icon={<Scale size={16} />} id="titre-poids" title="Comparaison des poids">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] border-collapse text-left text-sm">
          <caption className="sr-only">Poids porté aujourd&apos;hui comparé aux dernières courses, avec le meilleur chrono de chaque cheval</caption>
          <thead>
            <tr className={HEAD_ROW}>
              <th className={TH} scope="col">Cheval</th>
              <th className={`${TH} text-right`} scope="col">Poids du jour</th>
              <th className={TH} scope="col">Dernières courses</th>
              <th className={`${TH} text-right`} scope="col">Écart</th>
              <th className={TH} scope="col">Lecture</th>
              <th className={`${TH} text-right`} scope="col">Meilleur chrono</th>
              <th className={`${TH} text-center`} scope="col">Rang chrono</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((row) => (
              <tr key={row.number}>
                <th className="px-3 py-2 font-normal" scope="row"><Horse row={row} /></th>
                <td className="whitespace-nowrap px-3 py-2 text-right font-mono font-bold text-fg">{kg(row.weight.todayKg)}</td>
                <td className="px-3 py-2 font-mono text-xs text-muted">
                  {row.weight.recent.length ? row.weight.recent.map((value) => value.toFixed(1).replace(".", ",")).join(" · ") : "—"}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-xs">{signedKg(row.weight.deltaKg)}</td>
                <td className={`px-3 py-2 text-xs font-bold ${row.weight.trend ? WEIGHT_STYLES[row.weight.trend] : "text-muted"}`}>
                  {row.weight.trend ? WEIGHT_LABELS[row.weight.trend] : "—"}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-xs">{formatKmTime(row.chrono?.kmTimeMs)}</td>
                <td className="px-3 py-2 text-center font-mono text-xs">{row.chronoRank ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="border-t border-border px-4 py-3 text-[11px] leading-5 text-muted sm:px-5">
        L&apos;écart compare le poids du jour à la moyenne des trois dernières courses (de la plus récente à la plus ancienne). Allégé ou
        chargé à partir de {FORM_THRESHOLDS.weightDeltaKg} kg d&apos;écart. Un poids plus léger aide, mais il accompagne souvent une course
        d&apos;un niveau différent.
      </p>
    </Panel>
  );
}

/** Note de forme, ses quatre critères et les dernières arrivées. */
export function FormTable({ board }: { board: FormBoard }) {
  const rows = [...board.rows].sort((a, b) => (b.form.score ?? -1) - (a.form.score ?? -1) || a.number - b.number);
  return (
    <Panel aside="de la meilleure note à la moins bonne" icon={<Activity size={16} />} id="titre-forme" title="Forme et préparation">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[860px] border-collapse text-left text-sm">
          <caption className="sr-only">Indicateur de forme de chaque partant, avec le détail de la note et les dernières arrivées</caption>
          <thead>
            <tr className={HEAD_ROW}>
              <th className={TH} scope="col">Cheval</th>
              <th className={TH} scope="col">Forme</th>
              <th className={`${TH} text-right`} scope="col">Note</th>
              <th className={`${TH} text-right`} scope="col">Résultats /{FORM_WEIGHTS.results}</th>
              <th className={`${TH} text-right`} scope="col">Progression /{FORM_WEIGHTS.progress}</th>
              <th className={`${TH} text-right`} scope="col">Régularité /{FORM_WEIGHTS.regularity}</th>
              <th className={`${TH} text-right`} scope="col">Fraîcheur /{FORM_WEIGHTS.freshness}</th>
              <th className={TH} scope="col">Dernières arrivées</th>
              <th className={TH} scope="col">À retenir</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((row) => {
              const { form } = row;
              return (
                <tr key={row.number}>
                  <th className="px-3 py-2 font-normal" scope="row"><Horse row={row} /></th>
                  <td className="px-3 py-2"><FormBadge level={form.level} /></td>
                  <td className="whitespace-nowrap px-3 py-2 text-right font-mono font-bold text-fg">{form.score === null ? "—" : `${form.score}/100`}</td>
                  <td className="px-3 py-2 text-right font-mono text-xs">{form.parts?.results ?? "—"}</td>
                  <td className="px-3 py-2 text-right font-mono text-xs">{form.parts?.progress ?? "—"}</td>
                  <td className="px-3 py-2 text-right font-mono text-xs">{form.parts?.regularity ?? "—"}</td>
                  <td className="px-3 py-2 text-right font-mono text-xs">
                    {form.parts?.freshness ?? "—"}
                    {form.daysSinceLast !== null && <span className="ml-1 text-[10px] text-muted">({form.daysSinceLast} j)</span>}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-muted">{row.runs.length ? row.runs.slice(0, 5).map(place).join(" · ") : "—"}</td>
                  <td className="px-3 py-2 text-xs text-muted">{form.reasons.length ? form.reasons.join(" ; ") : form.level === "inconnue" ? "aucune course connue" : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="border-t border-border px-4 py-3 text-[11px] leading-5 text-muted sm:px-5">
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="inline-flex items-center gap-1.5"><FormBadge level="bonne" /> {FORM_THRESHOLDS.good}/100 et plus</span>
          <span className="inline-flex items-center gap-1.5"><FormBadge level="moyenne" /> de {FORM_THRESHOLDS.average} à {FORM_THRESHOLDS.good - 1}</span>
          <span className="inline-flex items-center gap-1.5"><FormBadge level="mauvaise" /> moins de {FORM_THRESHOLDS.average}</span>
        </p>
        <p className="mt-2">
          La note additionne quatre critères lus dans les cinq dernières courses : résultats (les trois dernières arrivées, la plus récente
          comptant triple), progression (les deux dernières face aux précédentes), régularité (courses finies dans la première moitié du
          peloton) et fraîcheur (8 à 35 jours depuis la dernière course valent le maximum ; une récupération très courte ou une longue absence
          en retirent). Après plus de {FORM_THRESHOLDS.layoffDays} jours sans courir, la forme est au mieux « moyenne » : la préparation reste à
          vérifier. Ce sont des règles fixes, pas une probabilité de victoire, et leur rendement n&apos;a pas encore été mesuré sur les
          courses passées.
        </p>
      </div>
    </Panel>
  );
}
