import { NextResponse } from "next/server";
import { z } from "zod";
import { getSql, hasDatabase } from "@/lib/db";
import { isPushService, isValidPushKeys, MAX_FOLLOWED_HORSES } from "@/lib/push/config";
import { adresseAppelant, limiterDebit, reponseTropDeRequetes } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Abonnement aux alertes push, sans compte.
 *
 * POST   enregistre l'abonnement du navigateur et remplace sa liste de chevaux
 *        suivis (appelé à l'activation, puis à chaque changement de la liste et
 *        à chaque visite, ce qui tient `seen_at` à jour).
 * DELETE supprime l'abonnement : le visiteur a coupé les alertes.
 *
 * L'adresse de livraison est appelée plus tard par la boucle d'envoi : seuls
 * les services de push des navigateurs sont acceptés, jamais une URL
 * arbitraire qu'un script nous ferait contacter.
 */

const endpointSchema = z.string().max(1_000).refine(isPushService, "Service de push non reconnu");

const subscribeSchema = z.object({
  subscription: z.object({
    endpoint: endpointSchema,
    keys: z
      .object({
        p256dh: z.string().min(16).max(200),
        auth: z.string().min(8).max(100),
      })
      .refine((k) => isValidPushKeys(k.p256dh, k.auth), "Clés d'abonnement invalides"),
  }),
  horseIds: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/)).max(MAX_FOLLOWED_HORSES),
});

const unsubscribeSchema = z.object({ endpoint: endpointSchema });

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Plafond global de NOUVEAUX abonnements par heure. Le compteur par IP vit
 * dans l'instance : seul un contrôle en base empêche un script réparti de
 * remplir la table (la base Neon est plafonnée à 512 Mo).
 */
const NEW_SUBSCRIPTIONS_PER_HOUR = 300;

function unavailable() {
  return NextResponse.json({ error: "Alertes momentanément indisponibles." }, { status: 503, headers: NO_STORE });
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

function guard(request: Request) {
  const limite = limiterDebit(`push:${adresseAppelant(request)}`, 30, 10 * 60_000);
  if (!limite.autorise) return reponseTropDeRequetes(limite);
  if (!hasDatabase()) return unavailable();
  return null;
}

export async function POST(request: Request) {
  const blocked = guard(request);
  if (blocked) return blocked;

  const parsed = subscribeSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return NextResponse.json({ error: "Abonnement invalide." }, { status: 400, headers: NO_STORE });
  }
  const { subscription, horseIds } = parsed.data;

  try {
    const sql = getSql();
    const [known] = (await sql.query(`select 1 from push_subscriptions where endpoint = $1`, [subscription.endpoint])) as unknown[];
    if (!known) {
      const [{ n }] = (await sql.query(
        `select count(*)::int as n from push_subscriptions where created_at > now() - interval '1 hour'`,
      )) as Array<{ n: number }>;
      if (n >= NEW_SUBSCRIPTIONS_PER_HOUR) {
        return NextResponse.json({ error: "Trop d'activations en ce moment, réessayez plus tard." }, { status: 429, headers: { ...NO_STORE, "Retry-After": "3600" } });
      }
    }
    // Seuls les chevaux connus sont gardés : une liste inventée ne déclencherait
    // jamais d'envoi, donc jamais la purge des abonnements expirés.
    await sql.query(
      `insert into push_subscriptions (endpoint, p256dh, auth, horse_ids)
       values ($1, $2, $3, coalesce((select array_agg(id order by id) from horses where id = any($4::text[])), '{}'))
       on conflict (endpoint) do update
         set p256dh = excluded.p256dh, auth = excluded.auth,
             horse_ids = excluded.horse_ids, seen_at = now()`,
      [subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth, [...new Set(horseIds)]],
    );
  } catch (cause) {
    console.error("POST /api/push", cause instanceof Error ? cause.message : "erreur");
    return unavailable();
  }

  return NextResponse.json({ ok: true }, { status: 200, headers: NO_STORE });
}

export async function DELETE(request: Request) {
  const blocked = guard(request);
  if (blocked) return blocked;

  const parsed = unsubscribeSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return NextResponse.json({ error: "Requête invalide." }, { status: 400, headers: NO_STORE });
  }

  try {
    await getSql().query(`delete from push_subscriptions where endpoint = $1`, [parsed.data.endpoint]);
  } catch (cause) {
    console.error("DELETE /api/push", cause instanceof Error ? cause.message : "erreur");
    return unavailable();
  }
  return NextResponse.json({ ok: true }, { status: 200, headers: NO_STORE });
}
