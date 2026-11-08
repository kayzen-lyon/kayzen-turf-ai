import { z } from "zod";

/**
 * Schémas d'entrée des routes API.
 *
 * Aucun paramètre n'était validé : `?date=` partait directement dans un cast
 * `::date` PostgreSQL — la requête levait, le `catch` renvoyait le jeu de
 * démonstration, et l'API répondait 200 avec des données fictives. Le même
 * `date` était par ailleurs recopié dans l'en-tête `Content-Disposition` du
 * PDF, où un guillemet suffisait à sortir du `filename="…"`.
 */

/** Première journée couverte par l'historique importé. */
const DATE_MINIMALE = "2024-01-01";
/** Le programme PMU n'est publié que quelques jours à l'avance. */
const JOURS_AVANCE_MAX = 7;

/** Jour courant à Paris, au format AAAA-MM-JJ. */
function aujourdhuiParis(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** Dernière date acceptée, calculée à chaque analyse : aujourd'hui (Paris) + 7 jours. */
function dateMaximale(): string {
  const [annee, mois, jour] = aujourdhuiParis().split("-").map(Number);
  return new Date(Date.UTC(annee!, mois! - 1, jour! + JOURS_AVANCE_MAX))
    .toISOString()
    .slice(0, 10);
}

/**
 * Date calendaire ISO, réellement existante (rejette 2026-02-31) et comprise
 * dans la période couverte : pas avant 2024-01-01, pas au-delà d'une semaine.
 * Une date lointaine passait jusqu'ici la validation puis déclenchait une
 * requête SQL parfaitement inutile ; la borne se calcule à l'analyse, pas au
 * chargement du module, pour rester juste sur une instance longue.
 */
export const schemaDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Format attendu : AAAA-MM-JJ")
  .refine((valeur) => {
    const [annee, mois, jour] = valeur.split("-").map(Number);
    const date = new Date(Date.UTC(annee, mois - 1, jour));
    return (
      date.getUTCFullYear() === annee &&
      date.getUTCMonth() === mois - 1 &&
      date.getUTCDate() === jour
    );
  }, "Date inexistante au calendrier")
  // Les deux bornes sont au même format AAAA-MM-JJ : la comparaison lexicale
  // suffit.
  .refine(
    (valeur) => valeur >= DATE_MINIMALE && valeur <= dateMaximale(),
    "Date hors de la période couverte",
  );

/** Recul accepté par les routes qui chargent une journée entière. */
const JOURS_RECUL_MAX = 7;

/**
 * Date d'une journée chargée en entier (/api/races, PDF du jour) : la semaine
 * passée et la semaine à venir. Avec tout l'historique depuis 2024, un client
 * respectant la limite de requêtes pouvait relire jour après jour des
 * mégaoctets de partants et épuiser le quota de transfert Neon (audit du
 * 08/11/2026). Les courses plus anciennes restent consultables page par page.
 */
export const schemaDateRecente = schemaDate.refine((valeur) => {
  const [annee, mois, jour] = aujourdhuiParis().split("-").map(Number);
  const minimum = new Date(Date.UTC(annee!, mois! - 1, jour! - JOURS_RECUL_MAX)).toISOString().slice(0, 10);
  return valeur >= minimum;
}, `Date antérieure aux ${JOURS_RECUL_MAX} derniers jours`);

/** Jour relatif accepté par le dépôt de courses. */
export const schemaJourRelatif = z.enum(["yesterday", "today", "tomorrow"]);

/**
 * Identifiant de course tel que produit par l'import PMU
 * (`pmu-2026-08-16-R1-C3`). Borné en longueur et restreint aux caractères
 * effectivement utilisés : pas de quoi construire un motif hostile.
 */
export const schemaIdCourse = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9_-]+$/, "Identifiant de course invalide");

/**
 * Lit un paramètre optionnel et renvoie `null` s'il est absent.
 * Une valeur présente mais invalide reste une erreur — la masquer en `null`
 * reviendrait à servir silencieusement autre chose que ce qui est demandé.
 */
export function lireParametreOptionnel<T>(
  schema: z.ZodType<T>,
  valeur: string | null,
): { ok: true; valeur: T | null } | { ok: false; message: string } {
  if (valeur === null) return { ok: true, valeur: null };

  const resultat = schema.safeParse(valeur);
  if (resultat.success) return { ok: true, valeur: resultat.data };

  return { ok: false, message: resultat.error.issues[0]?.message ?? "Paramètre invalide" };
}

/** Réponse 400 normalisée pour un paramètre refusé. */
export function reponseParametreInvalide(parametre: string, message: string): Response {
  return Response.json(
    { error: `Paramètre « ${parametre} » invalide : ${message}` },
    { status: 400, headers: { "Cache-Control": "no-store" } },
  );
}
