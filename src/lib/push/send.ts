import webpush, { WebPushError } from "web-push";
import { getSql } from "@/lib/db";
import type { FrozenPayload } from "@/lib/live/freeze";
import { PROFILE_LABELS } from "@/lib/profiles";
import type { PoolSnapshot } from "@/lib/market";
import { DEPART_ALERT_MINUTES, isValidPushKeys, VAPID_PUBLIC_KEY } from "@/lib/push/config";
import { arrivalBody, evaluateMarketAlert, type AlertKind, type ArrivalSummary, type MarketAlertKind } from "@/lib/push/market-alerts";
import { SITE_URL } from "@/lib/site";

/**
 * ENVOI DES ALERTES PUSH — appelé par la boucle live (scripts/live-refresh.ts)
 * après chaque passage. Motifs :
 *   - « depart »      : un cheval suivi court dans moins de 30 minutes ;
 *   - « non-partant » : un cheval suivi vient d'être retiré de sa course ;
 *   - « smart-money » / « delaisse » : signal de marché sur un cheval suivi
 *     (règles dans market-alerts.ts, une seule alerte de marché par course) ;
 *   - « arrivee »     : arrivée officielle d'une course où court un cheval suivi.
 *
 * Chaque notification envoyée est consignée dans `push_deliveries` : la boucle
 * repasse toutes les 30 s, le journal garantit une seule alerte par motif.
 * Un abonnement que le service de push déclare expiré (404/410) est supprimé.
 */

export type Target = {
  subscription_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  race_id: string;
  horse_id: string;
  horse_name: string;
  number: number;
  odds: number | null;
  reunion_number: number | null;
  course_number: number | null;
  start_time: string;
  racecourse: string | null;
  minutes_to_start: number;
  payload: FrozenPayload | null;
};

type Notification = { title: string; body: string; url: string; tag: string };

let configured: boolean | null = null;

/** Faux sans clé privée (poste local, fork) : la boucle tourne alors sans envoyer. */
export function pushConfigured(): boolean {
  if (configured === null) {
    const privateKey = process.env.VAPID_PRIVATE_KEY;
    configured = Boolean(privateKey);
    if (privateKey) webpush.setVapidDetails(`${SITE_URL}/mentions-legales`, VAPID_PUBLIC_KEY, privateKey);
  }
  return configured;
}

function programCode(t: Target): string {
  return t.reunion_number && t.course_number ? `R${t.reunion_number}C${t.course_number}` : "";
}

function raceLabel(t: Target): string {
  return [programCode(t), t.racecourse].filter(Boolean).join(" ");
}

export function departNotification(t: Target): Notification {
  const minutes = Math.max(0, Math.round(t.minutes_to_start));
  const details: string[] = [];
  const index = t.payload?.numbers.indexOf(t.number) ?? -1;
  if (index >= 0 && t.payload) {
    details.push(`${PROFILE_LABELS[t.payload.profile[index]!] ?? ""} · rang IA ${index + 1}`);
  }
  if (t.odds && t.odds > 1) details.push(`cote ${String(Number(t.odds).toFixed(1)).replace(".", ",")}`);
  return {
    title: `${t.horse_name} part dans ${minutes} min`,
    body: [`N° ${t.number} · ${raceLabel(t)} · départ ${t.start_time}`, details.join(" · ")].filter(Boolean).join("\n"),
    url: `/races/${encodeURIComponent(t.race_id)}`,
    tag: `depart-${t.race_id}-${t.horse_id}`,
  };
}

export function scratchNotification(t: Target): Notification {
  return {
    title: `${t.horse_name} est non-partant`,
    body: `N° ${t.number} retiré de la ${raceLabel(t)} (départ ${t.start_time}).`,
    url: `/races/${encodeURIComponent(t.race_id)}`,
    tag: `non-partant-${t.race_id}-${t.horse_id}`,
  };
}

/**
 * Réserve l'alerte dans le journal AVANT de l'envoyer : si l'écriture échoue
 * (base indisponible, motif encore refusé par une contrainte pas migrée), rien
 * ne part — jamais la même notification toutes les 30 s. Deux passages qui se
 * chevauchent ne peuvent pas réserver la même ligne. Ne lève jamais : un
 * destinataire en échec n'empêche pas les suivants.
 */
async function deliver(t: Target, kind: AlertKind, notification: Notification, ttlSeconds?: number): Promise<boolean> {
  const sql = getSql();
  // Abonnement enregistré avant la validation des clés : il ne pourra jamais
  // être livré. Supprimé une fois pour toutes, au lieu d'être retenté à
  // chaque passage.
  if (!isValidPushKeys(t.p256dh, t.auth)) {
    await sql.query(`delete from push_subscriptions where id = $1`, [t.subscription_id]).catch(() => undefined);
    return false;
  }
  let reserved: unknown[];
  try {
    reserved = (await sql.query(
      `insert into push_deliveries (subscription_id, race_id, horse_id, kind) values ($1, $2, $3, $4)
       on conflict do nothing returning 1`,
      [t.subscription_id, t.race_id, t.horse_id, kind],
    )) as unknown[];
  } catch (error) {
    console.warn(`[push] journal indisponible, alerte « ${kind} » non envoyée (${(error as Error).message})`);
    return false;
  }
  if (reserved.length === 0) return false;

  try {
    await webpush.sendNotification(
      { endpoint: t.endpoint, keys: { p256dh: t.p256dh, auth: t.auth } },
      JSON.stringify(notification),
      // Une alerte de départ n'a plus de sens une fois le départ donné.
      { TTL: ttlSeconds ?? Math.max(60, Math.round(t.minutes_to_start * 60)), urgency: "high" },
    );
    return true;
  } catch (error) {
    const status = error instanceof WebPushError ? error.statusCode : null;
    try {
      if (status === 404 || status === 410) {
        // Abonnement expiré : supprimé, son journal part avec lui (cascade).
        await sql.query(`delete from push_subscriptions where id = $1`, [t.subscription_id]);
      } else if (status === null || status === 429 || status >= 500) {
        // Panne passagère : la réservation est levée, le passage suivant réessaiera.
        await sql.query(
          `delete from push_deliveries where subscription_id = $1 and race_id = $2 and horse_id = $3 and kind = $4`,
          [t.subscription_id, t.race_id, t.horse_id, kind],
        );
      }
      // 400, 403, 413 : erreur définitive (clés invalides, VAPID) — la
      // réservation reste, l'alerte n'est pas relancée en boucle.
    } catch {
      // Le journal reste en l'état : au pire, une alerte passagère est perdue.
    }
    console.warn(`[push] envoi impossible (${status ?? "réseau"} : ${(error as Error).message})`);
    return false;
  }
}

const TARGET_COLUMNS = `
  s.id as subscription_id, s.endpoint, s.p256dh, s.auth,
  r.id as race_id, h.id as horse_id, h.name as horse_name, e.number, e.odds::float8 as odds,
  r.reunion_number, r.course_number, r.start_time, rc.name as racecourse,
  (extract(epoch from (((r.race_date + replace(r.start_time, 'h', ':')::time) at time zone 'Europe/Paris') - now())) / 60)::float8 as minutes_to_start`;

/** Alertes de départ : chevaux suivis qui courent dans moins de 30 min. */
async function departTargets(): Promise<Target[]> {
  return (await getSql().query(
    `select ${TARGET_COLUMNS}, ps.payload
       from races r
       join entries e on e.race_id = r.id
       join horses h on h.id = e.horse_id
       join push_subscriptions s on s.horse_ids @> array[e.horse_id]
       left join racecourses rc on rc.id = r.racecourse_id
       left join lateral (
         select p.payload from prediction_snapshots p where p.race_id = r.id order by p.captured_at desc limit 1
       ) ps on true
      where r.race_date between (now() at time zone 'Europe/Paris')::date - 1 and (now() at time zone 'Europe/Paris')::date
        and r.start_time ~ '^\\d{1,2}[:h]\\d{2}$'
        and ((r.race_date + replace(r.start_time, 'h', ':')::time) at time zone 'Europe/Paris')
            between now() and now() + make_interval(mins => $1)
        and not exists (
          select 1 from push_deliveries d
           where d.subscription_id = s.id and d.race_id = r.id and d.horse_id = e.horse_id and d.kind = 'depart')`,
    [DEPART_ALERT_MINUTES],
  )) as Target[];
}

/**
 * Alertes de non-partant. L'engagement vient d'être supprimé de `entries` : le
 * numéro est fourni par l'appelant, qui l'a lu au moment du retrait.
 */
async function scratchTargets(raceId: string, horseIds: string[]): Promise<Target[]> {
  return (await getSql().query(
    `select s.id as subscription_id, s.endpoint, s.p256dh, s.auth,
            r.id as race_id, h.id as horse_id, h.name as horse_name,
            0 as number,
            null::float8 as odds, r.reunion_number, r.course_number, r.start_time, rc.name as racecourse,
            (extract(epoch from (((r.race_date + replace(r.start_time, 'h', ':')::time) at time zone 'Europe/Paris') - now())) / 60)::float8 as minutes_to_start,
            null::jsonb as payload
       from races r
       join horses h on h.id = any($2::text[])
       join push_subscriptions s on s.horse_ids @> array[h.id]
       left join racecourses rc on rc.id = r.racecourse_id
      where r.id = $1
        and not exists (
          select 1 from push_deliveries d
           where d.subscription_id = s.id and d.race_id = r.id and d.horse_id = h.id and d.kind = 'non-partant')`,
    [raceId, horseIds],
  )) as Target[];
}

/**
 * Envoie les alertes dues. `scratched` : chevaux retirés pendant ce passage,
 * par course, avec leur numéro (l'engagement n'existe plus en base).
 */
export async function sendPushAlerts(scratched: Array<{ raceId: string; horses: Array<{ horseId: string; number: number }> }> = []) {
  if (!pushConfigured()) return { sent: 0 };
  let sent = 0;

  for (const race of scratched) {
    const numbers = new Map(race.horses.map((h) => [h.horseId, h.number]));
    for (const target of await scratchTargets(race.raceId, [...numbers.keys()])) {
      target.number = numbers.get(target.horse_id) ?? target.number;
      if (await deliver(target, "non-partant", scratchNotification(target))) sent += 1;
    }
  }

  for (const target of await departTargets()) {
    if (await deliver(target, "depart", departNotification(target))) sent += 1;
  }

  sent += await sendMarketAlerts();
  sent += await sendArrivalAlerts();

  return { sent };
}

/** Abonnements sans visite depuis 13 mois : supprimés (minimisation, RGPD art. 5.1.e). */
export async function purgeStaleSubscriptions() {
  const removed = await getSql().query(
    `delete from push_subscriptions where seen_at < now() - interval '13 months' returning 1`,
  );
  return removed.length;
}

/* ─── Alertes de marché ─────────────────────────────────────────── */

export function marketNotification(t: Target, kind: MarketAlertKind): Notification {
  const minutes = Math.max(1, Math.round(t.minutes_to_start));
  const odds = t.odds && t.odds > 1 ? ` · cote ${String(Number(t.odds).toFixed(1)).replace(".", ",")}` : "";
  const head = `N° ${t.number} · ${raceLabel(t)} · départ dans ${minutes} min${odds}`;
  return kind === "smart-money"
    ? {
        title: `Smart money sur ${t.horse_name}`,
        body: `${head}\nL'argent entre, la cote baisse et l'IA est d'accord — ce n'est pas l'avis d'initiés.`,
        url: `/races/${encodeURIComponent(t.race_id)}`,
        tag: `marche-${t.race_id}-${t.horse_id}`,
      }
    : {
        title: `${t.horse_name} est délaissé`,
        body: `${head}\nSa cote a monté depuis le matin, sans argent qui entre.`,
        url: `/races/${encodeURIComponent(t.race_id)}`,
        tag: `marche-${t.race_id}-${t.horse_id}`,
      };
}

/** Chevaux suivis dont la course part dans moins de 30 min, sans alerte de marché déjà envoyée. */
async function marketTargets(): Promise<Target[]> {
  return (await getSql().query(
    `select ${TARGET_COLUMNS}, ps.payload
       from races r
       join entries e on e.race_id = r.id
       join horses h on h.id = e.horse_id
       join push_subscriptions s on s.horse_ids @> array[e.horse_id]
       left join racecourses rc on rc.id = r.racecourse_id
       left join lateral (
         select p.payload from prediction_snapshots p where p.race_id = r.id order by p.captured_at desc limit 1
       ) ps on true
      where r.race_date = (now() at time zone 'Europe/Paris')::date
        and r.start_time ~ '^\\d{1,2}[:h]\\d{2}$'
        and ((r.race_date + replace(r.start_time, 'h', ':')::time) at time zone 'Europe/Paris')
            between now() and now() + make_interval(mins => $1)
        and not exists (
          select 1 from push_deliveries d
           where d.subscription_id = s.id and d.race_id = r.id
             and d.kind in ('smart-money', 'delaisse'))`,
    [DEPART_ALERT_MINUTES],
  )) as Target[];
}

/** Parts des mises et cotes du matin des courses visées : deux requêtes pour tout le passage. */
async function marketContext(raceIds: string[]) {
  const sql = getSql();
  const [poolRows, morningRows] = await Promise.all([
    sql.query(
      `select race_id, to_char(observed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as t, numbers, pool_win
         from pool_snapshots
        where race_id = any($1) and observed_at > now() - interval '40 minutes'
        order by race_id, observed_at`,
      [raceIds],
    ),
    sql.query(
      `select distinct on (o.race_id, o.horse_id) o.race_id, o.horse_id, o.odds::float8 as odds
         from odds_snapshots o
         join races r on r.id = o.race_id
        where o.race_id = any($1) and (o.observed_at at time zone 'Europe/Paris')::date = r.race_date
        order by o.race_id, o.horse_id, o.observed_at`,
      [raceIds],
    ),
  ]);
  const pools = new Map<string, PoolSnapshot[]>();
  for (const r of poolRows as Array<{ race_id: string; t: string; numbers: number[]; pool_win: number[] }>) {
    pools.set(r.race_id, [...(pools.get(r.race_id) ?? []), { t: r.t, numbers: r.numbers.map(Number), win: r.pool_win.map(Number) }]);
  }
  const morning = new Map((morningRows as Array<{ race_id: string; horse_id: string; odds: number }>).map((r) => [`${r.race_id}|${r.horse_id}`, r.odds]));
  return { pools, morning };
}

async function sendMarketAlerts(): Promise<number> {
  const targets = await marketTargets();
  if (targets.length === 0) return 0;
  const { pools, morning } = await marketContext([...new Set(targets.map((t) => t.race_id))]);
  let sent = 0;
  // Une seule alerte de marché par navigateur et par course, même pour
  // plusieurs chevaux suivis dans la même épreuve.
  const served = new Set<string>();
  for (const t of targets) {
    const key = `${t.subscription_id}|${t.race_id}`;
    if (served.has(key)) continue;
    const index = t.payload?.numbers.indexOf(t.number) ?? -1;
    const hasOdds = t.odds !== null && t.odds > 1;
    const kind = evaluateMarketAlert({
      number: t.number,
      minutesToStart: t.minutes_to_start,
      morningOdds: morning.get(`${t.race_id}|${t.horse_id}`) ?? null,
      currentOdds: t.odds,
      pools: pools.get(t.race_id) ?? [],
      ai: index >= 0 ? (t.payload?.ai?.[index] ?? null) : null,
      market: index >= 0 && hasOdds ? (t.payload?.market?.[index] ?? null) : null,
    });
    if (!kind) continue;
    served.add(key);
    if (await deliver(t, kind, marketNotification(t, kind))) sent += 1;
  }
  return sent;
}

/* ─── Alertes d'arrivée ─────────────────────────────────────────── */

/** Une arrivée reste « fraîche » trois heures : au-delà, la notifier n'a plus d'intérêt. */
const ARRIVAL_FRESH_HOURS = 3;

export function arrivalNotification(t: Target, summary: ArrivalSummary): Notification {
  return {
    title: `Arrivée ${raceLabel(t)}`.trim(),
    body: `${t.horse_name} — ${arrivalBody(t.number, summary)}`,
    url: `/races/${encodeURIComponent(t.race_id)}`,
    tag: `arrivee-${t.race_id}-${t.horse_id}`,
  };
}

type ArrivalTarget = Target & { arrival: number[] | null; position: number | null };

async function arrivalTargets(): Promise<ArrivalTarget[]> {
  return (await getSql().query(
    `select ${TARGET_COLUMNS}, ps.payload, arr.arrival, res.finish_position as position
       from races r
       join entries e on e.race_id = r.id
       join horses h on h.id = e.horse_id
       join push_subscriptions s on s.horse_ids @> array[e.horse_id]
       left join racecourses rc on rc.id = r.racecourse_id
       left join results res on res.race_id = r.id and res.horse_id = e.horse_id
       join lateral (
         select array_agg(e2.number order by x.finish_position) as arrival, max(x.created_at) as published_at
           from results x
           join entries e2 on e2.race_id = x.race_id and e2.horse_id = x.horse_id
          where x.race_id = r.id and x.finish_position between 1 and 5
       ) arr on arr.arrival is not null
       left join lateral (
         select p.payload from prediction_snapshots p where p.race_id = r.id and p.stage = 'H-2' limit 1
       ) ps on true
      where r.race_date between (now() at time zone 'Europe/Paris')::date - 1 and (now() at time zone 'Europe/Paris')::date
        and arr.published_at > now() - make_interval(hours => $1)
        -- Arrivée définitive seulement : les rapports ne sont écrits qu'une fois
        -- le résultat officiel complet, jamais sur une arrivée provisoire.
        and exists (select 1 from race_payouts p where p.race_id = r.id)
        and not exists (
          select 1 from push_deliveries d
           where d.subscription_id = s.id and d.race_id = r.id and d.horse_id = e.horse_id and d.kind = 'arrivee')`,
    [ARRIVAL_FRESH_HOURS],
  )) as ArrivalTarget[];
}

async function sendArrivalAlerts(): Promise<number> {
  let sent = 0;
  for (const t of await arrivalTargets()) {
    const arrival = (t.arrival ?? []).map(Number);
    const position = t.position && t.position >= 1 && t.position <= 5 ? Number(t.position) : null;
    const summary: ArrivalSummary = { arrival, position, aiBase: t.payload?.numbers[0] ?? null };
    if (await deliver(t, "arrivee", arrivalNotification(t, summary), ARRIVAL_FRESH_HOURS * 3600)) sent += 1;
  }
  return sent;
}
