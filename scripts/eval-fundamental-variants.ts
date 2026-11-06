#!/usr/bin/env -S npx tsx
/**
 * Banc de comparaison hors échantillon des variantes du modèle fondamental.
 *
 * LECTURE SEULE : un seul SELECT (scripts/lib/dataset.ts), puis tout se rejoue
 * depuis le fichier `--cache` pour ne pas repayer le transfert Neon.
 *
 * Protocole : pour chaque mois M de test, chaque variante est ajustée sur tout
 * ce qui précède M et mesurée sur M. Les variantes « sélection » choisissent λ et
 * leurs groupes uniquement sur les 3 derniers mois AVANT M (sélection imbriquée) :
 * le mois de test n'influence jamais aucun choix. La référence est F1 réajusté
 * de la même façon ; le gain est apparié course par course (IC 95 %).
 *
 * Usage : npx tsx scripts/eval-fundamental-variants.ts --cache rows.json [--out report.json]
 *           [--from 2026-04] [--to 2026-11]
 *         npx tsx scripts/eval-fundamental-variants.ts --cache rows.json --confirm-chrono [--candidate fichier.json]
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import modelFile from "@/lib/fundamental/model.json";
import {
  FEATURE_GROUP_NAMES,
  FEATURE_NAMES,
  LEGACY_FEATURE_NAMES,
  computeFeatures,
  featuresOfGroups,
  type Discipline,
  type FeatureGroup,
  type FeatureName,
} from "@/lib/fundamental/features";
import { loadModel, probabilitiesWith } from "@/lib/fundamental/model";
import { buildDataset, loadDatasetRows, loadLocalEnv, type DatasetRace, type DatasetRow } from "./lib/dataset";
import { fitExplodedLogit, type RankedRace } from "./lib/exploded-logit";

function arg(name: string, fallback: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const LAMBDAS = [0.001, 0.01, 0.03];
const TOP3 = [1, 0.5, 0.25];
const MIN_GAIN = 0.0005;
const COL = new Map(FEATURE_NAMES.map((n, i) => [n, i]));

type Sample = { race: DatasetRace; month: string; x: number[][]; order: number[]; winner: number; market: number[] | null };
type Fitted = { cols: number[]; means: number[]; sds: number[]; coef: number[] };

function toSample(race: DatasetRace): Sample {
  const order = race.field
    .map((h, i) => ({ i, p: h.position }))
    .filter((o): o is { i: number; p: number } => o.p != null && o.p >= 1)
    .sort((a, b) => a.p - b.p || a.i - b.i)
    .slice(0, 3)
    .map((o) => o.i);
  const raw = race.field.map((h) => (h.closingOdds != null && h.closingOdds > 1 ? 1 / h.closingOdds : 0));
  const known = raw.filter((r) => r > 0);
  let market: number[] | null = null;
  if (known.length) {
    const floor = Math.min(...known);
    const filled = raw.map((r) => (r > 0 ? r : floor));
    const total = filled.reduce((a, b) => a + b, 0);
    market = filled.map((r) => r / total);
  }
  return { race, month: race.date.slice(0, 7), x: computeFeatures(race.field, race.discipline, FEATURE_NAMES, race.context), order, winner: race.winner, market };
}

function fit(samples: Sample[], names: readonly FeatureName[], lambda: number, stageWeights: number[]): Fitted {
  const all = names.map((n) => COL.get(n)!);
  let n = 0;
  const m0 = all.map(() => 0);
  const s0 = all.map(() => 0);
  for (const s of samples) for (const row of s.x) { n++; all.forEach((c, j) => (m0[j] += row[c])); }
  m0.forEach((_, j) => (m0[j] /= Math.max(n, 1)));
  for (const s of samples) for (const row of s.x) all.forEach((c, j) => (s0[j] += (row[c] - m0[j]) ** 2));
  s0.forEach((_, j) => (s0[j] = Math.sqrt(s0[j] / Math.max(n, 1))));
  const keep = all.map((_, j) => j).filter((j) => s0[j] > 1e-9);
  const cols = keep.map((j) => all[j]);
  const means = keep.map((j) => m0[j]);
  const sds = keep.map((j) => s0[j]);
  const d = cols.length;
  const races: RankedRace[] = samples
    .filter((s) => s.order.length > 0)
    .map((s) => {
      const z = new Float64Array(s.x.length * d);
      s.x.forEach((row, i) => cols.forEach((c, j) => (z[i * d + j] = (row[c] - means[j]) / sds[j])));
      return { z, n: s.x.length, order: s.order };
    });
  const { beta } = fitExplodedLogit(races, d, { lambda, stageWeights });
  return { cols, means, sds, coef: beta };
}

function softmax(logits: number[]) {
  const max = Math.max(...logits);
  const e = logits.map((l) => Math.exp(l - max));
  const sum = e.reduce((a, b) => a + b, 0);
  return e.map((v) => v / sum);
}

function probs(s: Sample, m: Fitted) {
  return softmax(s.x.map((row) => m.cols.reduce((acc, c, j) => acc + m.coef[j] * ((row[c] - m.means[j]) / m.sds[j]), 0)));
}

const lossOf = (p: number[], winner: number) => -Math.log(Math.max(p[winner], 1e-12));

/** Log loss moyen d'un jeu de variables sur les `count` derniers mois de `train`, chaque mois appris sur ce qui le précède. */
function innerLoss(train: Sample[], names: readonly FeatureName[], lambda: number, months: string[]) {
  let ll = 0;
  let n = 0;
  for (const month of months) {
    const model = fit(train.filter((s) => s.month < month), names, lambda, TOP3);
    for (const s of train) {
      if (s.month !== month) continue;
      ll += lossOf(probs(s, model), s.winner);
      n++;
    }
  }
  return n ? ll / n : Infinity;
}

function bestLambda(train: Sample[], names: readonly FeatureName[], months: string[]) {
  let best = { lambda: LAMBDAS[0], ll: Infinity };
  for (const lambda of LAMBDAS) {
    const ll = innerLoss(train, names, lambda, months);
    if (ll < best.ll) best = { lambda, ll };
  }
  return best.lambda;
}

/** Sélection avant des groupes (même règle que scripts/train-fundamental.ts), sans jamais voir le mois de test. */
function selectGroups(train: Sample[], chain: FeatureGroup[]) {
  const months = [...new Set(train.map((s) => s.month))].sort().slice(-3);
  const lambda = bestLambda(train, featuresOfGroups(FEATURE_GROUP_NAMES.filter((g) => g !== "chrono")), months);
  let groups: FeatureGroup[] = ["base"];
  let current = innerLoss(train, featuresOfGroups(groups), lambda, months);
  for (const group of chain) {
    const ll = innerLoss(train, featuresOfGroups([...groups, group]), lambda, months);
    if (current - ll >= MIN_GAIN) { groups = [...groups, group]; current = ll; }
  }
  // Le chrono est testé en dernier : la variante « sans chrono » partage toute la chaîne.
  const withoutChrono = groups;
  const chronoLoss = innerLoss(train, featuresOfGroups([...groups, "chrono"]), lambda, months);
  const withChrono: FeatureGroup[] = current - chronoLoss >= MIN_GAIN ? [...groups, "chrono"] : groups;
  return { lambda, withoutChrono, withChrono };
}

type Pred = { raceId: string; month: string; winner: number; loss: number; top1: boolean; top3: boolean; blendLoss: number | null; marketLoss: number | null; marketTop1: boolean | null };

function predict(s: Sample, p: number[]): Pred {
  const order = p.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]);
  let blendLoss: number | null = null;
  let marketLoss: number | null = null;
  let marketTop1: boolean | null = null;
  if (s.market) {
    const market = s.market;
    const raw = market.map((m, i) => Math.max(m, 1e-9) ** 0.9 * Math.max(p[i], 1e-9) ** 0.1);
    const total = raw.reduce((a, b) => a + b, 0);
    blendLoss = lossOf(raw.map((r) => r / total), s.winner);
    marketLoss = lossOf(market, s.winner);
    marketTop1 = market.indexOf(Math.max(...market)) === s.winner;
  }
  return { raceId: s.race.raceId, month: s.month, winner: s.winner, loss: lossOf(p, s.winner), top1: order[0][1] === s.winner, top3: order.slice(0, 3).some(([, i]) => i === s.winner), blendLoss, marketLoss, marketTop1 };
}

function summarize(preds: Pred[], reference: Map<string, Pred> | null) {
  const n = preds.length;
  const mean = (f: (p: Pred) => number) => preds.reduce((a, p) => a + f(p), 0) / Math.max(n, 1);
  const out: Record<string, number | null> = { n, logLoss: mean((p) => p.loss), top1: 100 * mean((p) => +p.top1), top3: 100 * mean((p) => +p.top3) };
  const withOdds = preds.filter((p) => p.blendLoss != null);
  out.blendLoss = withOdds.length ? withOdds.reduce((a, p) => a + p.blendLoss!, 0) / withOdds.length : null;
  if (reference) {
    const diffs = preds.flatMap((p) => { const r = reference.get(p.raceId); return r ? [r.loss - p.loss] : []; });
    const m = diffs.reduce((a, b) => a + b, 0) / Math.max(diffs.length, 1);
    const sd = Math.sqrt(diffs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(diffs.length - 1, 1));
    const se = sd / Math.sqrt(Math.max(diffs.length, 1));
    out.gain = m;
    out.gainLow = m - 1.96 * se;
    out.gainHigh = m + 1.96 * se;
    const months = [...new Set(preds.map((p) => p.month))];
    out.monthsBetter = months.filter((mo) => {
      const sub = preds.filter((p) => p.month === mo && reference.has(p.raceId));
      return sub.reduce((a, p) => a + reference.get(p.raceId)!.loss - p.loss, 0) > 0;
    }).length;
    out.monthsTotal = months.length;
    const blendDiffs = withOdds.flatMap((p) => { const r = reference.get(p.raceId); return r?.blendLoss != null ? [r.blendLoss - p.blendLoss!] : []; });
    out.blendGain = blendDiffs.length ? blendDiffs.reduce((a, b) => a + b, 0) / blendDiffs.length : null;
    out.top1Delta = out.top1! - 100 * preds.filter((p) => reference.has(p.raceId)).reduce((a, p) => a + +reference.get(p.raceId)!.top1, 0) / Math.max(n, 1);
  }
  return out;
}

const fx = (v: number | null | undefined, d = 4) => (v == null || !Number.isFinite(v) ? "—" : v.toFixed(d));
const signed = (v: number | null | undefined, d = 4) => (v == null || !Number.isFinite(v) ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(d)}`);

async function main() {
  const cachePath = arg("cache", "");
  if (!cachePath) throw new Error("--cache <fichier> obligatoire : le banc ne doit lire la base qu'une fois");
  const from = arg("from", "2026-04");
  const to = arg("to", "2026-11");
  let rows: DatasetRow[];
  if (existsSync(cachePath)) {
    rows = JSON.parse(readFileSync(cachePath, "utf8"));
    console.log(`${rows.length} lignes relues depuis le cache (aucun transfert Neon)`);
  } else {
    loadLocalEnv();
    const realFetch = globalThis.fetch;
    let bytes = 0;
    globalThis.fetch = async (...args: Parameters<typeof fetch>) => {
      const response = await realFetch(...args);
      const clone = response.clone();
      bytes += (await clone.arrayBuffer()).byteLength;
      return response;
    };
    rows = await loadDatasetRows(process.env.DATABASE_URL!);
    globalThis.fetch = realFetch;
    console.log(`${rows.length} lignes lues en base : ${(bytes / 1e6).toFixed(1)} Mo reçus (JSON décompressé)`);
    writeFileSync(cachePath, JSON.stringify(rows));
  }

  const samples = buildDataset(rows).map(toSample);
  if (process.argv.includes("--confirm-chrono")) {
    confirmChrono(samples, arg("candidate", ""));
    return;
  }
  const production = loadModel(modelFile);
  const noHistory = featuresOfGroups(["base", "specialty", "stall", "weight", "equipment"]).filter((f) => f !== "shoeFirstTime");
  const allNoChrono = featuresOfGroups(FEATURE_GROUP_NAMES.filter((g) => g !== "chrono"));
  const added = FEATURE_GROUP_NAMES.filter((g) => g !== "base");
  const chain = added.filter((g) => g !== "chrono");
  const fixed: Array<[string, readonly FeatureName[]]> = [
    ["F2 sans historique", noHistory],
    ["F2 complet sans chrono", allNoChrono],
    ["F2 complet + chrono", featuresOfGroups(FEATURE_GROUP_NAMES)],
    ...added.map((g): [string, readonly FeatureName[]] => [`F1 + ${g}`, [...LEGACY_FEATURE_NAMES, ...featuresOfGroups([g])]]),
  ];

  const report: Record<string, unknown> = {};
  const allPreds = new Map<string, Pred[]>();
  const add = (key: string, list: Pred[]) => allPreds.set(key, [...(allPreds.get(key) ?? []), ...list]);

  for (const discipline of ["Plat", "Trot", "Obstacle"] as Discipline[]) {
    const pool = samples.filter((s) => s.race.discipline === discipline);
    const testMonths = [...new Set(pool.map((s) => s.month))].sort().filter((m) => m >= from && m <= to);
    const preds = new Map<string, Pred[]>();
    const push = (key: string, list: Pred[]) => preds.set(key, [...(preds.get(key) ?? []), ...list]);
    const selections: unknown[] = [];

    for (const month of testMonths) {
      const train = pool.filter((s) => s.month < month);
      const test = pool.filter((s) => s.month === month);
      if (train.length < 200 || test.length < 10) continue;
      const started = Date.now();
      const innerMonths = [...new Set(train.map((s) => s.month))].sort().slice(-3);

      const run = (names: readonly FeatureName[], lambda: number, weights = TOP3) => {
        const model = fit(train, names, lambda, weights);
        return test.map((s) => predict(s, probs(s, model)));
      };
      const lambdaF1 = bestLambda(train, LEGACY_FEATURE_NAMES, innerMonths);
      push("F1 réajusté (gagnant seul)", run(LEGACY_FEATURE_NAMES, lambdaF1, [1]));
      push("F1 réajusté (top 3)", run(LEGACY_FEATURE_NAMES, lambdaF1));
      const prod = production.disciplines[discipline];
      if (prod && month >= production.trainCutoff.slice(0, 7)) {
        push("Production figée", test.map((s) => predict(s, probabilitiesWith(prod, s.race.field, discipline, s.race.context))));
      }
      for (const [label, names] of fixed) push(label, run(names, lambdaF1));
      const selection = selectGroups(train, chain);
      selections.push({ month, ...selection });
      push("F2 sélection sans chrono", run(featuresOfGroups(selection.withoutChrono), selection.lambda));
      push("F2 sélection avec chrono", run(featuresOfGroups(selection.withChrono), selection.lambda));
      const market = test.filter((s) => s.market).map((s) => {
        const p = predict(s, s.market!);
        return p;
      });
      push("Marché (clôture)", market);
      console.error(`${discipline} ${month} : ${test.length} courses, ${((Date.now() - started) / 1000).toFixed(0)} s, groupes ${selection.withChrono.join("+")}`);
    }

    const referenceKey = "F1 réajusté (gagnant seul)";
    const reference = new Map((preds.get(referenceKey) ?? []).map((p) => [p.raceId, p]));
    const out: Record<string, unknown> = {};
    console.log(`\n══ ${discipline} — ${reference.size} courses hors échantillon (${testMonths[0]} → ${testMonths.at(-1)})`);
    console.log(`${"variante".padEnd(30)}${"n".padStart(6)}${"logLoss".padStart(9)}${"gain".padStart(9)}${"IC95 bas".padStart(9)}${"IC95 haut".padStart(10)}${"mois+".padStart(7)}${"top1 %".padStart(8)}${"top3 %".padStart(8)}${"mél.w=.1".padStart(9)}`);
    for (const [label, list] of preds) {
      const s = summarize(list, label === referenceKey ? null : reference);
      out[label] = s;
      add(label, list);
      console.log(`${label.padEnd(30)}${String(s.n).padStart(6)}${fx(s.logLoss).padStart(9)}${signed(s.gain).padStart(9)}${signed(s.gainLow).padStart(9)}${signed(s.gainHigh).padStart(10)}${(s.monthsBetter != null ? `${s.monthsBetter}/${s.monthsTotal}` : "").padStart(7)}${fx(s.top1, 1).padStart(8)}${fx(s.top3, 1).padStart(8)}${fx(s.blendLoss).padStart(9)}`);
    }
    // Poids et corde ne sont renseignés qu'à partir de septembre 2026 : seuls octobre et novembre mesurent ces variables.
    const recentRef = new Map([...reference].filter(([, p]) => p.month >= "2026-10"));
    console.log(`   — octobre-novembre seulement (poids, corde et déferrage connus à l'apprentissage), ${recentRef.size} courses :`);
    for (const [label, list] of preds) {
      if (label === referenceKey) continue;
      const s = summarize(list.filter((p) => p.month >= "2026-10"), recentRef);
      out[`${label} (oct-nov)`] = s;
      console.log(`   ${label.padEnd(27)}${String(s.n).padStart(6)}${fx(s.logLoss).padStart(9)}${signed(s.gain).padStart(9)}${signed(s.gainLow).padStart(9)}${signed(s.gainHigh).padStart(10)}${fx(s.top1, 1).padStart(15)}${fx(s.top3, 1).padStart(8)}`);
    }
    report[discipline] = { results: out, selections };
    console.log(`   sélections : ${selections.map((v) => { const x = v as { month: string; lambda: number; withChrono: string[] }; return `${x.month} λ=${x.lambda} ${x.withChrono.join("+")}`; }).join(" | ")}`);
  }

  const reference = new Map((allPreds.get("F1 réajusté (gagnant seul)") ?? []).map((p) => [p.raceId, p]));
  console.log(`\n══ Toutes disciplines — ${reference.size} courses`);
  const overall: Record<string, unknown> = {};
  for (const [label, list] of allPreds) {
    const s = summarize(list, label.startsWith("F1 réajusté (gagnant") ? null : reference);
    overall[label] = s;
    console.log(`${label.padEnd(30)}${String(s.n).padStart(6)}${fx(s.logLoss).padStart(9)}${signed(s.gain).padStart(9)}${signed(s.gainLow).padStart(9)}${signed(s.gainHigh).padStart(10)}${(s.monthsBetter != null ? `${s.monthsBetter}/${s.monthsTotal}` : "").padStart(7)}${fx(s.top1, 1).padStart(8)}${fx(s.top3, 1).padStart(8)}${fx(s.blendLoss).padStart(9)}`);
  }
  report.overall = overall;

  // Contrôle anti-fuite : le meilleur chrono PASSÉ doit prédire comme une variable ordinaire, loin des 80 % du chrono de la course.
  const trot = samples.filter((s) => s.race.discipline === "Trot" && s.month >= from);
  const iBest = COL.get("chronoBest")!;
  const iMissing = COL.get("chronoMissing")!;
  let wins = 0;
  let known = 0;
  let cells = 0;
  let missing = 0;
  for (const s of trot) {
    let best = -1;
    let bv = -Infinity;
    s.x.forEach((row, i) => { cells++; if (row[iMissing]) missing++; else if (row[iBest] > bv) { bv = row[iBest]; best = i; } });
    if (best >= 0) { known++; if (best === s.winner) wins++; }
  }
  const leak = { races: known, bestPastChronoWins: (100 * wins) / Math.max(known, 1), chronoMissingShare: (100 * missing) / Math.max(cells, 1) };
  console.log(`\nContrôle anti-fuite (trot) : le meilleur chrono passé gagne ${leak.bestPastChronoWins.toFixed(1)} % de ${leak.races} courses (chrono de la course même : ~80 %) ; chrono manquant sur ${leak.chronoMissingShare.toFixed(1)} % des partants`);
  report.leakCheck = leak;

  const outPath = arg("out", "");
  if (outPath) writeFileSync(outPath, JSON.stringify(report, null, 1));
}

/**
 * Confirmation du seul signal qui ressort : même objectif (gagnant seul) que la
 * production, chrono par mois, puis candidat FIGÉ au 1er octobre (chrono encore
 * complet) mesuré sur octobre-novembre contre le modèle publié.
 */
function confirmChrono(samples: Sample[], candidatePath: string) {
  const WINNER = [1];
  const names: FeatureName[] = [...LEGACY_FEATURE_NAMES, ...featuresOfGroups(["chrono"])];
  const production = loadModel(modelFile);
  const pool = samples.filter((s) => s.race.discipline === "Trot");
  const months = [...new Set(pool.map((s) => s.month))].sort().filter((m) => m >= "2026-04");
  const iMissing = COL.get("chronoMissing")!;
  const base: Pred[] = [];
  const chrono: Pred[] = [];
  const prod: Pred[] = [];
  const prodModel = production.disciplines.Trot!;
  console.log("mois       n     F1    F1+chrono   gain   top1 F1 top1 ch. chrono manquant");
  for (const month of months) {
    const train = pool.filter((s) => s.month < month);
    const test = pool.filter((s) => s.month === month);
    const m0 = fit(train, LEGACY_FEATURE_NAMES, 0.001, WINNER);
    const m1 = fit(train, names, 0.001, WINNER);
    const a = test.map((s) => predict(s, probs(s, m0)));
    const b = test.map((s) => predict(s, probs(s, m1)));
    base.push(...a);
    chrono.push(...b);
    prod.push(...test.map((s) => predict(s, probabilitiesWith(prodModel, s.race.field, "Trot", s.race.context))));
    const mean = (l: Pred[], f: (p: Pred) => number) => l.reduce((x, p) => x + f(p), 0) / l.length;
    const cells = test.flatMap((s) => s.x.map((r) => r[iMissing]));
    console.log(`${month} ${String(test.length).padStart(4)}  ${fx(mean(a, (p) => p.loss))}  ${fx(mean(b, (p) => p.loss))}  ${signed(mean(a, (p) => p.loss) - mean(b, (p) => p.loss))}  ${fx(100 * mean(a, (p) => +p.top1), 1).padStart(6)}  ${fx(100 * mean(b, (p) => +p.top1), 1).padStart(6)}  ${fx((100 * cells.reduce((x, c) => x + c, 0)) / cells.length, 1).padStart(6)} %`);
  }
  const paired = (label: string, cand: Pred[], ref: Pred[], keep: (p: Pred) => boolean) => {
    const r = new Map(ref.map((p) => [p.raceId, p]));
    const sub = cand.filter((p) => keep(p) && r.has(p.raceId));
    const stat = (f: (p: Pred) => number) => {
      const d = sub.map((p) => f(p) - f(r.get(p.raceId)!));
      const m = d.reduce((x, y) => x + y, 0) / d.length;
      const se = Math.sqrt(d.reduce((x, y) => x + (y - m) ** 2, 0) / (d.length - 1) / d.length);
      return [m, m - 1.96 * se, m + 1.96 * se];
    };
    const [g, gl, gh] = stat((p) => -p.loss);
    const [t, tl, th] = stat((p) => 100 * +p.top1);
    const [t3, t3l, t3h] = stat((p) => 100 * +p.top3);
    const [b, bl, bh] = stat((p) => -(p.blendLoss ?? 0));
    console.log(`${label} (n=${sub.length}) : logLoss ${signed(g)} [${signed(gl)} ; ${signed(gh)}] | top1 ${signed(t, 2)} pt [${signed(tl, 2)} ; ${signed(th, 2)}] | top3 ${signed(t3, 2)} pt [${signed(t3l, 2)} ; ${signed(t3h, 2)}] | mélange w=.1 ${signed(b)} [${signed(bl)} ; ${signed(bh)}]`);
  };
  console.log("");
  paired("F1+chrono vs F1, avr-nov", chrono, base, () => true);
  paired("F1+chrono vs F1, avr-sep", chrono, base, (p) => p.month < "2026-10");
  paired("F1+chrono vs F1, oct-nov", chrono, base, (p) => p.month >= "2026-10");
  paired("F1+chrono glissant vs production figée, juin-nov", chrono, prod, (p) => p.month >= "2026-06");

  // Candidat figé : appris avant octobre, jamais réajusté ensuite.
  const before = pool.filter((s) => s.month < "2026-10");
  const innerMonths = [...new Set(before.map((s) => s.month))].sort().slice(-3);
  let lambda = LAMBDAS[0];
  let bestLl = Infinity;
  for (const l of LAMBDAS) {
    let ll = 0;
    let n = 0;
    for (const month of innerMonths) {
      const m = fit(before.filter((s) => s.month < month), names, l, WINNER);
      for (const s of before) if (s.month === month) { ll += lossOf(probs(s, m), s.winner); n++; }
    }
    if (ll / n < bestLl) { bestLl = ll / n; lambda = l; }
  }
  const frozen = fit(before, names, lambda, WINNER);
  const after = pool.filter((s) => s.month >= "2026-10");
  paired(`Candidat figé au 01/10 (λ=${lambda}) vs production figée, oct-nov`, after.map((s) => predict(s, probs(s, frozen))), prod, () => true);
  const featureNames = frozen.cols.map((c) => FEATURE_NAMES[c]);
  console.log(`coefficients : ${featureNames.map((n, j) => `${n} ${signed(frozen.coef[j], 3)}`).join(", ")}`);
  if (candidatePath) {
    const carried = (d: "Plat" | "Obstacle") => {
      const m = production.disciplines[d]!;
      return { features: m.features, means: m.means, sds: m.sds, coef: m.coef, carriedOver: production.version };
    };
    const file = {
      formatVersion: 2,
      version: "fondamental-candidat-chrono-2026-10-01",
      status: "CANDIDAT, non branché : voir docs/evaluation-modele-enrichi.md",
      trainedAt: new Date().toISOString(),
      trainCutoff: "2026-10-01",
      objective: { type: "conditional-logit-winner", stageWeights: WINNER },
      disciplines: {
        Plat: carried("Plat"),
        Trot: { features: featureNames, groups: ["legacy", "chrono"], lambda, means: frozen.means.map((v) => +v.toFixed(5)), sds: frozen.sds.map((v) => +v.toFixed(5)), coef: frozen.coef.map((v) => +v.toFixed(5)) },
        Obstacle: carried("Obstacle"),
      },
    };
    writeFileSync(candidatePath, `${JSON.stringify(file, null, 2)}\n`);
    loadModel(JSON.parse(readFileSync(candidatePath, "utf8")));
    console.log(`Écrit : ${candidatePath}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
