import { getSql } from "@/lib/db";
import { DISTANCE_TOLERANCE, type RaceDiscipline } from "@/lib/performances/form-board";

/**
 * ENTRAÎNEURS SUR LA DISTANCE — résultats de chaque entraîneur de la course sur
 * des courses comparables : même discipline (et même spécialité au trot),
 * distance à `DISTANCE_TOLERANCE` mètres près de celle du jour, courues AVANT
 * la date de la course et dont l'arrivée est connue.
 *
 * Ce n'est pas un classement général : un entraîneur très titré peut être peu
 * représenté sur cette distance. Source : notre base (courses importées du PMU),
 * donc limitée à l'historique que le site a constitué.
 *
 * Classement : taux de victoire, puis taux de places (trois premiers). En
 * dessous de `TRAINER_MIN_RUNS` courses, le taux ne veut rien dire : ces
 * entraîneurs sont listés après les autres, sans rang.
 */

/** Nombre minimal de courses pour qu'un taux de réussite soit classé. */
export const TRAINER_MIN_RUNS = 5;

export type TrainerDistanceRow = {
  trainerId: string;
  name: string;
  /** Numéros de ses chevaux dans la course du jour. */
  numbers: number[];
  runs: number;
  wins: number;
  /** Arrivées dans les trois premiers, victoires comprises. */
  places: number;
};

export type RankedTrainer = TrainerDistanceRow & {
  /** `null` sous le seuil de courses. */
  rank: number | null;
  winRate: number | null;
  placeRate: number | null;
  reliable: boolean;
};

function rate(part: number, total: number): number | null {
  return total > 0 ? Math.round((part / total) * 1000) / 10 : null;
}

/** Du meilleur taux de victoire au moins bon ; les échantillons trop petits ensuite. Fonction pure. */
export function rankTrainers(rows: readonly TrainerDistanceRow[]): RankedTrainer[] {
  const enriched = rows.map((row) => ({
    ...row,
    numbers: [...row.numbers].sort((a, b) => a - b),
    winRate: rate(row.wins, row.runs),
    placeRate: rate(row.places, row.runs),
    reliable: row.runs >= TRAINER_MIN_RUNS,
  }));
  enriched.sort(
    (a, b) =>
      Number(b.reliable) - Number(a.reliable) ||
      (b.winRate ?? -1) - (a.winRate ?? -1) ||
      (b.placeRate ?? -1) - (a.placeRate ?? -1) ||
      b.runs - a.runs ||
      a.name.localeCompare(b.name, "fr"),
  );
  let rank = 0;
  return enriched.map((row) => ({ ...row, rank: row.reliable ? ++rank : null }));
}

type SqlRow = { trainer_id: string; name: string; numbers: number[]; runs: number; wins: number; places: number };

/**
 * Lit les résultats des entraîneurs de la course `raceId` sur les courses
 * comparables. Une seule requête, pilotée par les courses (index sur la date et
 * sur `entries.race_id`). Lève en cas de panne : à l'appelant de ne pas garder
 * l'échec en cache.
 */
export async function fetchTrainerDistanceStats(raceId: string, discipline: RaceDiscipline): Promise<TrainerDistanceRow[]> {
  const tolerance = DISTANCE_TOLERANCE[discipline];
  const rows = (await getSql().query(
    `with cur as (
       select race_date, discipline, specialty,
              nullif(regexp_replace(distance, '\\D', '', 'g'), '')::int as meters
         from races where id = $1
     ),
     field as (
       select e.trainer_id, array_agg(e.number order by e.number) as numbers
         from entries e
        where e.race_id = $1 and e.trainer_id is not null
        group by e.trainer_id
     ),
     past as (
       select e.trainer_id, res.finish_position as pos
         from cur
         join races r on r.race_date < cur.race_date
                     and r.discipline = cur.discipline
                     and (cur.discipline <> 'Trot' or r.specialty is not distinct from cur.specialty)
                     and nullif(regexp_replace(r.distance, '\\D', '', 'g'), '')::int between cur.meters - $2 and cur.meters + $2
         join entries e on e.race_id = r.id and e.trainer_id in (select trainer_id from field)
         left join results res on res.race_id = e.race_id and res.horse_id = e.horse_id
        where exists (select 1 from results w where w.race_id = r.id and w.finish_position = 1)
     )
     select f.trainer_id::text as trainer_id, t.name, f.numbers,
            count(p.trainer_id)::int as runs,
            count(*) filter (where p.pos = 1)::int as wins,
            count(*) filter (where p.pos between 1 and 3)::int as places
       from field f
       join trainers t on t.id = f.trainer_id
       left join past p on p.trainer_id = f.trainer_id
      group by f.trainer_id, t.name, f.numbers`,
    [raceId, tolerance],
  )) as SqlRow[];
  return rows.map((row) => ({
    trainerId: row.trainer_id,
    name: row.name,
    numbers: (row.numbers ?? []).map(Number),
    runs: Number(row.runs),
    wins: Number(row.wins),
    places: Number(row.places),
  }));
}
