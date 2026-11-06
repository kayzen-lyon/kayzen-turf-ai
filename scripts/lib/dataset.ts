/**
 * Jeu de données historique, partagé par l'entraînement du modèle fondamental
 * et le backtest. Chaque course arrive avec les variables de ses partants
 * telles qu'elles étaient connues AVANT elle :
 *   - les statistiques jockey et entraîneur sont accumulées date par date et
 *     mises à jour après chaque jour ;
 *   - l'historique de chaque cheval (src/lib/fundamental/history.ts) est
 *     reconstitué de la même façon : une course n'entre dans l'historique
 *     qu'APRÈS son jour, jamais avant (pas de fuite, même pour une course
 *     courue plus tôt le même jour).
 *
 * Les colonnes ajoutées récemment au schéma (races.start_type, races.prize,
 * entries.blinkers) sont lues via `to_jsonb(...)->>'col'` : sur une base qui ne
 * les a pas encore, elles valent `null` au lieu de faire échouer la requête.
 */

import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";
import type { Discipline, FundamentalInput, FundamentalRaceContext } from "@/lib/fundamental/features";
import { HISTORY_MAX_RUNS, computeHorseHistory, parseDistance, type PastRun } from "@/lib/fundamental/history";

export type DatasetHorse = FundamentalInput & { horseId: string; closingOdds: number | null; position: number | null };

export type DatasetRace = {
  raceId: string;
  date: string;
  discipline: Discipline;
  /** Spécialité brute (races.specialty), pour les rapports par spécialité. */
  specialty: string | null;
  context: FundamentalRaceContext;
  field: DatasetHorse[];
  /** Index du gagnant dans `field`. */
  winner: number;
};

export type DatasetRow = FundamentalInput & {
  race_id: string;
  race_date: string;
  discipline: Discipline;
  specialty: string | null;
  start_type: string | null;
  distance: string | null;
  going: string | null;
  prize: string | null;
  racecourse: string | null;
  horse_id: string;
  jockey_id: string | null;
  trainer_id: string | null;
  odds: number | null;
  pos: number | null;
  /** Chrono RÉALISÉ dans cette course : n'entre que dans l'historique des courses suivantes. */
  reduction_km?: string | null;
};

function toNumber(value: unknown): number | null {
  const n = Number(value);
  return value != null && value !== "" && Number.isFinite(n) ? n : null;
}

export async function loadDataset(databaseUrl: string): Promise<DatasetRace[]> {
  return buildDataset(await loadDatasetRows(databaseUrl));
}

/** Lignes brutes triées par date (exporté pour rejouer un banc sans relire la base). */
export async function loadDatasetRows(databaseUrl: string): Promise<DatasetRow[]> {
  const sql = neon(databaseUrl);
  return (await sql`
    select e.race_id, r.race_date::text as race_date, r.discipline, r.specialty,
           (to_jsonb(r)->>'start_type') as start_type, r.distance, r.going,
           (to_jsonb(r)->>'prize') as prize, r.racecourse_id::text as racecourse,
           e.horse_id, e.number, e.music,
           e.earnings::float8 as earnings, coalesce(e.age, h.age) as age, e.sex, e.equipment,
           e.handicap_distance as "handicapDistance", e.draw, e.weight::float8 as weight, e.shoeing,
           (to_jsonb(e)->>'blinkers') as blinkers,
           e.jockey_id::text as jockey_id, e.trainer_id::text as trainer_id,
           e.odds::float8 as odds, res.finish_position as pos,
           coalesce(to_jsonb(e)->>'realized_km', e.reduction_km) as reduction_km
      from entries e
      join races r on r.id = e.race_id
      join horses h on h.id = e.horse_id
      left join results res on res.race_id = e.race_id and res.horse_id = e.horse_id
     where exists (select 1 from results w where w.race_id = e.race_id and w.finish_position = 1)
     order by r.race_date, e.race_id, e.number
  `) as DatasetRow[];
}

/** Construit le jeu point-in-time à partir des lignes triées par date (exporté pour les tests). */
export function buildDataset(rows: DatasetRow[]): DatasetRace[] {
  const byDate = new Map<string, Map<string, DatasetRow[]>>();
  for (const row of rows) {
    const day = byDate.get(row.race_date) ?? new Map<string, DatasetRow[]>();
    const race = day.get(row.race_id) ?? [];
    race.push(row);
    day.set(row.race_id, race);
    byDate.set(row.race_date, day);
  }

  const jockey = new Map<string, { runs: number; wins: number }>();
  const trainer = new Map<string, { runs: number; wins: number }>();
  const pastRuns = new Map<string, PastRun[]>();
  const races: DatasetRace[] = [];

  for (const date of [...byDate.keys()].sort()) {
    const day = byDate.get(date)!;
    for (const [raceId, field] of day) {
      const winner = field.findIndex((h) => h.pos === 1);
      if (winner < 0 || field.length < 4) continue;
      const first = field[0];
      const context: FundamentalRaceContext = {
        specialty: first.specialty,
        startType: first.start_type,
        distance: parseDistance(first.distance),
        prize: toNumber(first.prize),
        going: first.going,
      };
      races.push({
        raceId,
        date,
        discipline: first.discipline,
        specialty: first.specialty,
        context,
        winner,
        field: field.map((h) => ({
          number: h.number,
          music: h.music,
          earnings: h.earnings,
          age: h.age,
          sex: h.sex,
          equipment: h.equipment,
          handicapDistance: h.handicapDistance,
          draw: toNumber(h.draw),
          weight: toNumber(h.weight),
          shoeing: h.shoeing,
          blinkers: h.blinkers,
          jockeyRuns: jockey.get(h.jockey_id ?? "")?.runs ?? 0,
          jockeyWins: jockey.get(h.jockey_id ?? "")?.wins ?? 0,
          trainerRuns: trainer.get(h.trainer_id ?? "")?.runs ?? 0,
          trainerWins: trainer.get(h.trainer_id ?? "")?.wins ?? 0,
          raceContext: context,
          history: computeHorseHistory((pastRuns.get(h.horse_id) ?? []).slice(-HISTORY_MAX_RUNS), {
            date,
            distance: context.distance as number | null,
            going: first.going,
            racecourse: first.racecourse,
            prize: context.prize,
            jockeyId: h.jockey_id,
          }),
          horseId: h.horse_id,
          closingOdds: h.odds,
          position: h.pos,
        })),
      });
    }
    // Les résultats du jour n'entrent dans les statistiques qu'après le jour.
    for (const field of day.values()) {
      for (const h of field) {
        for (const [map, id] of [[jockey, h.jockey_id], [trainer, h.trainer_id]] as const) {
          if (!id) continue;
          const s = map.get(id) ?? { runs: 0, wins: 0 };
          s.runs += 1;
          if (h.pos === 1) s.wins += 1;
          map.set(id, s);
        }
        const list = pastRuns.get(h.horse_id) ?? [];
        list.push({
          date,
          position: h.pos,
          fieldSize: field.length,
          distance: parseDistance(h.distance),
          going: h.going,
          racecourse: h.racecourse,
          prize: toNumber(h.prize),
          jockeyId: h.jockey_id,
          shoeing: h.shoeing ?? (/^(DEFERRE|PROTEGE)/.test(String(h.equipment ?? "")) ? h.equipment : null),
          reductionKm: h.reduction_km,
        });
        if (list.length > HISTORY_MAX_RUNS) list.shift();
        pastRuns.set(h.horse_id, list);
      }
    }
  }
  return races;
}

export function loadLocalEnv() {
  try {
    for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
      const i = line.indexOf("=");
      if (i > 0 && !line.startsWith("#")) process.env[line.slice(0, i)] ||= line.slice(i + 1).replace(/^"|"$/g, "");
    }
  } catch {
    // En CI, DATABASE_URL vient des secrets.
  }
}
