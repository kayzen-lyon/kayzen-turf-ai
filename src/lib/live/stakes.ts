import { getSql } from "@/lib/db";
import { fetchPmuJson, pmuRaceUrl } from "@/lib/pmu/client";
import { STAKE_WINDOW_MIN, type MorningOdds, type StakeReading } from "@/lib/stake-board";

/**
 * ENJEUX PAR CHEVAL — lecture PMU et historique espacé (`stake_snapshots`).
 *
 * Le PMU tient deux masses sur le simple gagnant : `SIMPLE_GAGNANT` (point de
 * vente) et `E_SIMPLE_GAGNANT` (en ligne), chacune avec ses enjeux, en centimes,
 * et ses cotes. La cote de référence vaut celle du matin, mais le PMU la recale
 * trente minutes avant le départ : elle n'est donc retenue qu'avant ce recalage.
 */

const REFERENCE_RESET_MIN = 30;

type Combinaisons = {
  combinaisons?: Array<{ pariType?: string; updateTime?: number; listeCombinaisons?: Array<{ combinaison?: number[]; totalEnjeu?: number }> }>;
};
type Rapports = {
  dateMajDirect?: number;
  rapportsParticipant?: Array<{ numPmu?: number; rapportDirect?: number | null; rapportReference?: number | null }>;
};

export type LiveStakes = {
  reading: StakeReading;
  morning: MorningOdds;
  /** Dernière publication du PMU (ISO). */
  updatedAt: string | null;
  /** Au moins une lecture PMU attendue a échoué : la réponse ne doit pas être gardée longtemps. */
  partial: boolean;
  /**
   * Course internationale : le PMU n'y tient qu'une masse commune au point de
   * vente et en ligne (`SIMPLE_GAGNANT_INTERNATIONAL`, mêmes montants dans les
   * deux listes). Elle est rangée côté point de vente, rien côté en ligne :
   * l'additionner deux fois doublerait chaque euro.
   */
  international: boolean;
};

function odds(value: unknown): number | null {
  const n = Number(value);
  return value != null && Number.isFinite(n) && n > 1 ? n : null;
}

function readStakes(payload: Combinaisons | null, type: string): { stakes: Map<number, number>; updatedAt: number | null } {
  const bloc = payload?.combinaisons?.find((c) => c.pariType === type);
  const stakes = new Map<number, number>();
  for (const line of bloc?.listeCombinaisons ?? []) {
    const amount = Number(line.totalEnjeu);
    if (line.combinaison?.length === 1 && Number.isFinite(amount)) stakes.set(Number(line.combinaison[0]), Math.round(amount / 100));
  }
  return { stakes, updatedAt: bloc?.updateTime ?? null };
}

/**
 * Lit les deux masses. `null` si le PMU ne publie encore aucune mise pour la
 * course ; lève si les quatre lectures échouent, pour qu'une panne ne passe
 * jamais pour « aucune mise » (et ne soit pas mise en cache comme telle).
 */
export async function fetchRaceStakes(raceId: string): Promise<LiveStakes | null> {
  const settled = await Promise.allSettled([
    fetchPmuJson<Combinaisons>(pmuRaceUrl(raceId, "/combinaisons?specialisation=OFFLINE")!),
    fetchPmuJson<Combinaisons>(pmuRaceUrl(raceId, "/combinaisons?specialisation=INTERNET")!),
    fetchPmuJson<Rapports>(pmuRaceUrl(raceId, "/rapports/SIMPLE_GAGNANT")!),
    fetchPmuJson<Rapports>(pmuRaceUrl(raceId, "/rapports/E_SIMPLE_GAGNANT")!),
  ]);
  const failures = settled.filter((r) => r.status === "rejected").length;
  // Sans aucune des deux lectures d'enjeux, rien ne distingue « pas encore de
  // mises » d'une panne : on lève plutôt que de répondre « aucune mise ».
  if (settled[0].status === "rejected" && settled[1].status === "rejected") throw new Error(`Enjeux PMU illisibles pour ${raceId}`);
  const [combOff, combOn, rapOff, rapOn] = settled as [
    PromiseSettledResult<Combinaisons>,
    PromiseSettledResult<Combinaisons>,
    PromiseSettledResult<Rapports>,
    PromiseSettledResult<Rapports>,
  ];
  const value = <T,>(r: PromiseSettledResult<T>) => (r.status === "fulfilled" ? r.value : null);
  let offline = readStakes(value(combOff), "SIMPLE_GAGNANT");
  const online = readStakes(value(combOn), "E_SIMPLE_GAGNANT");
  let rapOffValue = value(rapOff);
  let partial = failures > 0;
  const international = offline.stakes.size === 0 && online.stakes.size === 0 && readStakes(value(combOff), "SIMPLE_GAGNANT_INTERNATIONAL").stakes.size > 0;
  if (international) {
    offline = readStakes(value(combOff), "SIMPLE_GAGNANT_INTERNATIONAL");
    // Les rapports nationaux n'existent pas pour ces courses (réponse vide) : seul celui de la masse commune compte.
    rapOffValue = await fetchPmuJson<Rapports>(pmuRaceUrl(raceId, "/rapports/SIMPLE_GAGNANT_INTERNATIONAL")!).catch(() => null);
    partial = rapOffValue === null;
  }
  if (offline.stakes.size === 0 && online.stakes.size === 0) return null;

  const oddsOff = new Map((rapOffValue?.rapportsParticipant ?? []).map((p) => [Number(p.numPmu), p]));
  const oddsOn = new Map((international ? [] : (value(rapOn)?.rapportsParticipant ?? [])).map((p) => [Number(p.numPmu), p]));
  const numbers = [...new Set([...offline.stakes.keys(), ...online.stakes.keys(), ...oddsOff.keys(), ...oddsOn.keys()])].sort((a, b) => a - b);

  const times = [offline.updatedAt, online.updatedAt, rapOffValue?.dateMajDirect ?? null, international ? null : (value(rapOn)?.dateMajDirect ?? null)].filter((t): t is number => Number.isFinite(t));
  return {
    reading: {
      numbers,
      stakeOffline: numbers.map((n) => offline.stakes.get(n) ?? null),
      stakeOnline: numbers.map((n) => online.stakes.get(n) ?? null),
      oddsOffline: numbers.map((n) => odds(oddsOff.get(n)?.rapportDirect)),
      oddsOnline: numbers.map((n) => odds(oddsOn.get(n)?.rapportDirect)),
    },
    morning: {
      numbers,
      refOffline: numbers.map((n) => odds(oddsOff.get(n)?.rapportReference)),
      refOnline: numbers.map((n) => odds(oddsOn.get(n)?.rapportReference)),
    },
    updatedAt: times.length ? new Date(Math.max(...times)).toISOString() : null,
    partial,
    international,
  };
}

/**
 * Historise les enjeux si le dernier relevé est plus ancien que `gapMinutes`.
 * La cote du matin n'est écrite qu'au premier relevé fait avant le recalage de
 * H-30. Le PMU n'est interrogé que si un relevé est dû.
 */
export async function recordStakeSnapshot(raceId: string, minutesToStart: number, gapMinutes: number): Promise<boolean> {
  const sql = getSql();
  const [state] = (await sql.query(
    `select bool_or(observed_at > now() - make_interval(mins => $2)) as recent,
            bool_or(ref_offline is not null or ref_online is not null) as has_morning
       from stake_snapshots where race_id = $1`,
    [raceId, Math.max(STAKE_WINDOW_MIN, gapMinutes)],
  )) as Array<{ recent: boolean | null; has_morning: boolean | null }>;
  if (state?.recent) return false;

  const live = await fetchRaceStakes(raceId);
  if (!live) return false;
  const keepMorning = !state?.has_morning && minutesToStart > REFERENCE_RESET_MIN;
  await sql.query(
    `insert into stake_snapshots (race_id, observed_at, numbers, stake_offline, stake_online, odds_offline, odds_online, ref_offline, ref_online)
     values ($1, now(), $2::smallint[], $3::int[], $4::int[], $5::real[], $6::real[], $7::real[], $8::real[])
     on conflict do nothing`,
    [
      raceId,
      live.reading.numbers,
      live.reading.stakeOffline,
      live.reading.stakeOnline,
      live.reading.oddsOffline,
      live.reading.oddsOnline,
      keepMorning ? live.morning.refOffline : null,
      keepMorning ? live.morning.refOnline : null,
    ],
  );
  return true;
}

type SnapshotRow = {
  observed_at: string;
  numbers: number[];
  stake_offline: Array<number | null>;
  stake_online: Array<number | null>;
  odds_offline: Array<number | null>;
  odds_online: Array<number | null>;
};

/**
 * Relevé de comparaison (le plus récent, au moins STAKE_WINDOW_MIN avant
 * `until`) et cote du matin figée. Deux lectures sur la clé primaire : quelques
 * centaines d'octets, et rien du tout tant que la table n'existe pas encore.
 */
export async function loadStakeHistory(raceId: string, until: Date): Promise<{
  baseline: { reading: StakeReading; observedAt: string } | null;
  morning: MorningOdds | null;
}> {
  const sql = getSql();
  try {
    const [row] = (await sql.query(
      `select observed_at, numbers, stake_offline, stake_online, odds_offline, odds_online
         from stake_snapshots
        where race_id = $1 and observed_at <= $2::timestamptz - make_interval(mins => $3)
        order by observed_at desc limit 1`,
      [raceId, until.toISOString(), STAKE_WINDOW_MIN],
    )) as SnapshotRow[];
    const [first] = (await sql.query(
      `select numbers, ref_offline, ref_online from stake_snapshots
        where race_id = $1 and (ref_offline is not null or ref_online is not null)
        order by observed_at limit 1`,
      [raceId],
    )) as Array<{ numbers: number[]; ref_offline: Array<number | null> | null; ref_online: Array<number | null> | null }>;
    return {
      baseline: row
        ? {
            observedAt: new Date(row.observed_at).toISOString(),
            reading: {
              numbers: row.numbers,
              stakeOffline: row.stake_offline,
              stakeOnline: row.stake_online,
              oddsOffline: row.odds_offline,
              oddsOnline: row.odds_online,
            },
          }
        : null,
      morning: first ? { numbers: first.numbers, refOffline: first.ref_offline ?? [], refOnline: first.ref_online ?? [] } : null,
    };
  } catch (error) {
    if ((error as { code?: string }).code !== "42P01") throw error;
    return { baseline: null, morning: null };
  }
}

/** Avant le recalage de H-30, la cote de référence du PMU est encore celle du matin. */
export function morningIsLive(minutesToStart: number): boolean {
  return minutesToStart > REFERENCE_RESET_MIN;
}
