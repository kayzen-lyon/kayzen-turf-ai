import { getSql } from "@/lib/db";
import type { LiveStakes } from "@/lib/live/stakes";
import type { OddsSnapshot, OperatorKey } from "@/lib/operator-board";
import type { MorningOdds } from "@/lib/stake-board";

/**
 * COTES PAR OPÉRATEUR — lecture pour les tableaux « Marché par opérateur ».
 *
 * ZEturf et Genybet : relevés historisés dans `operator_odds` par
 * scripts/operator-odds-loop.mjs (cinq au plus par course). PMU+ : lu en direct
 * sur l'API PMU (masse du simple gagnant en point de vente), avec la cote du
 * matin figée dans `stake_snapshots` avant le recalage PMU de H-30.
 */

export type PartnerOperator = Exclude<OperatorKey, "pmu">;

type Row = { operator: string; observed_at: string; numbers: number[]; odds: Array<number | null>; reference: Array<number | null> | null };

/** Table absente (schéma pas encore appliqué) : aucun relevé, pas une panne. */
function missingTable(error: unknown): boolean {
  return (error as { code?: string })?.code === "42P01";
}

/**
 * Relevés des opérateurs partenaires et numéros des non-partants. Quelques
 * lignes par course : deux lectures sur clé primaire.
 */
export async function loadOperatorHistory(raceId: string): Promise<{ snapshots: Record<PartnerOperator, OddsSnapshot[]>; nonRunners: number[] }> {
  const sql = getSql();
  const snapshots: Record<PartnerOperator, OddsSnapshot[]> = { zeturf: [], genybet: [] };
  try {
    const rows = (await sql.query(
      `select operator, observed_at, numbers, odds, reference from operator_odds where race_id = $1 order by observed_at`,
      [raceId],
    )) as Row[];
    for (const row of rows) {
      if (row.operator !== "zeturf" && row.operator !== "genybet") continue;
      snapshots[row.operator].push({
        observedAt: new Date(row.observed_at).toISOString(),
        numbers: row.numbers,
        odds: row.odds,
        reference: row.reference,
      });
    }
  } catch (error) {
    if (!missingTable(error)) throw error;
  }
  let nonRunners: number[] = [];
  try {
    const rows = (await sql.query(`select number from scratches where race_id = $1`, [raceId])) as Array<{ number: number }>;
    nonRunners = rows.map((row) => Number(row.number));
  } catch (error) {
    if (!missingTable(error)) throw error;
  }
  return { snapshots, nonRunners };
}

/**
 * Lecture PMU en direct → relevé pour `buildOperatorTable`. Après le départ, la
 * cote lue est la cote de clôture : elle vaut classement final.
 */
export function pmuSnapshot(live: LiveStakes | null, morning: MorningOdds | null, now: Date, startAt: Date | null): OddsSnapshot[] {
  if (!live) return [];
  const { numbers, oddsOffline } = live.reading;
  if (!oddsOffline.some((value) => value !== null)) return [];
  const departed = startAt !== null && startAt.getTime() <= now.getTime();
  return [
    {
      observedAt: now.toISOString(),
      numbers,
      odds: oddsOffline,
      reference: morning ? numbers.map((n) => morning.refOffline[morning.numbers.indexOf(n)] ?? null) : null,
      closing: departed,
    },
  ];
}

/**
 * Relevés FICTIFS pour le mode démonstration : une cote du matin, une cote une
 * heure avant le départ et une cote finale, dérivées de la cote affichée.
 */
export function demoOperatorSnapshots(
  runners: ReadonlyArray<{ number: number; odds: number | null }>,
  startAt: Date,
  shift: number,
): OddsSnapshot[] {
  const priced = runners.filter((r): r is { number: number; odds: number } => typeof r.odds === "number" && r.odds > 1);
  if (priced.length === 0) return [];
  const numbers = priced.map((r) => r.number);
  const wobble = (number: number, step: number) => 1 + (((number * 37 + step * 53 + shift * 17) % 21) - 10) / 50;
  const at = (minutes: number) => new Date(startAt.getTime() - minutes * 60_000).toISOString();
  const odds = (step: number) => priced.map((r) => Math.max(1.1, Math.round(r.odds * wobble(r.number, step) * 10) / 10));
  return [
    { observedAt: at(300), numbers, odds: odds(1) },
    { observedAt: at(60), numbers, odds: odds(2) },
    { observedAt: at(1.5), numbers, odds: odds(3) },
  ];
}
