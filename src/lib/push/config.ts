/**
 * Alertes push — réglages partagés par le navigateur, la route d'abonnement et
 * la boucle d'envoi.
 *
 * La clé publique VAPID identifie le serveur auprès des services de push
 * (Google, Mozilla, Apple). Elle est publique par nature : le navigateur la
 * reçoit en clair. La clé privée, elle, ne vit que dans le secret GitHub
 * VAPID_PRIVATE_KEY, lu par la boucle live qui envoie les notifications.
 */
export const VAPID_PUBLIC_KEY =
  "BLt_Y5fxJvQoau-hbWvUGe2yXlfBk6sg6R4ctpyEiE4LYz5RUMFNSgZ-66BkLB1v5pL8qbk8PIMwSsGgKq0tSqw";

/** L'alerte de départ part quand le cheval court dans moins de 30 min. */
export const DEPART_ALERT_MINUTES = 30;

/** Chevaux suivis au plus par navigateur : borne la ligne et la requête d'envoi. */
export const MAX_FOLLOWED_HORSES = 100;

/**
 * Services de push des navigateurs. La boucle d'envoi contacte l'adresse
 * d'abonnement : n'accepter que ces hôtes évite qu'un script nous fasse
 * appeler une URL arbitraire.
 */
const PUSH_HOSTS = [
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com",
  "web.push.apple.com",
  "notify.windows.com",
];

/** Octets décodés d'une chaîne base64url, sans `Buffer` (ce module est aussi chargé par le navigateur). */
function base64UrlBytes(value: string): number | null {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value)) return null;
  const chars = value.replace(/=+$/, "").length;
  return chars % 4 === 1 ? null : Math.floor((chars * 3) / 4);
}

/**
 * Clés d'abonnement utilisables par web-push : point P-256 non compressé
 * (65 octets, préfixe 0x04) et secret d'au moins 16 octets. Une clé mal
 * formée faisait échouer l'envoi avant tout appel réseau ; l'échec passait
 * pour une panne passagère et l'alerte était retentée à chaque passage de la
 * boucle, sans fin (audit du 08/11/2026).
 */
export function isValidPushKeys(p256dh: string, auth: string): boolean {
  if (base64UrlBytes(p256dh) !== 65 || (base64UrlBytes(auth) ?? 0) < 16) return false;
  // Premier octet 0x04 : le premier caractère vaut 1 (« B ») et les deux bits
  // hauts du second sont nuls (« A » à « P »).
  return p256dh[0] === "B" && /^[A-P]$/.test(p256dh[1] ?? "");
}

export function isPushService(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return (
      url.protocol === "https:" &&
      url.port === "" &&
      PUSH_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))
    );
  } catch {
    return false;
  }
}
