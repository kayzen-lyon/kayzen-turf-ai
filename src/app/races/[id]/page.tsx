import type { Metadata } from "next";
import { cache, Suspense } from "react";
import { unstable_cache } from "next/cache";
import { notFound } from "next/navigation";
import { CourseDetail } from "@/components/course-detail";
import { JsonLd } from "@/components/json-ld";
import { FrozenDiffPanel } from "@/components/track/frozen-diff-panel";
import { formatMeters, properName } from "@/lib/format";
import { getDayRaceIndex, getFrozenPredictions, getLatestTrackRecord, getRaceById, getRaceMarketHistory, getRacePayouts } from "@/lib/race-repository";
import { jourParis } from "@/lib/paris-time";
import { officialArrival } from "@/lib/race-status";
import { buildSelection } from "@/lib/selection";
import { SITE_URL } from "@/lib/site";

type RacePageProps = {
  params: Promise<{
    id: string;
  }>;
};

/**
 * `force-dynamic` refaisait les deux requêtes base à chaque visite, sur la
 * surface la plus crawlée du site — une centaine de pages renouvelées chaque
 * jour. L'accueil et /pronostics étaient déjà passés en rendu incrémental ;
 * les pages de course, non. Cinq minutes de cache réduisent les lectures ;
 * les données live déclenchent une revalidation dédiée.
 *
 * `dynamicParams` reste implicite à `true` : une course publiée après le
 * dernier build doit être rendue à la demande, pas répondre 404.
 *
 * `revalidate` seul ne suffit pas : sur une route dynamique sans
 * `generateStaticParams`, Next rend chaque visite (audit du 08/11/2026, aucune
 * entrée /races dans le manifeste de prérendu). La liste vide n'ajoute rien au
 * build ; elle active le rendu incrémental à la demande, page par page.
 */
export const revalidate = 300;

export function generateStaticParams() {
  return [];
}

/**
 * `generateMetadata` et le rendu de page demandent la même course. Sans `cache`,
 * chaque visite paie deux fois la requête base. React déduplique l'appel sur la
 * durée d'un rendu.
 */
const loadRace = cache(async (id: string | null) => {
  if (!id || !isSettled(id)) return getRaceById(id);
  const settled = await loadSettledSafe(id);
  return settled === undefined ? getRaceById(id) : (settled?.race ?? null);
});

/**
 * Course d'avant-hier ou plus ancienne : arrivée, rapports et cotes ne bougent
 * plus. Les robots repassent pourtant sur ces pages des dizaines de fois par
 * semaine, et chaque rendu relisait toute la course en base — un transfert qui
 * a épuisé le quota mensuel Neon. Tout ce que la page lit est donc gardé un jour.
 */
function isSettled(id: string): boolean {
  const raceDate = id.slice(0, 10);
  const yesterday = jourParis(new Date(Date.now() - 24 * 3600_000));
  return /^\d{4}-\d{2}-\d{2}$/.test(raceDate) && raceDate < yesterday;
}

const loadSettled = unstable_cache(
  async (id: string) => {
    const race = await getRaceById(id);
    if (!race) return null;
    const arrived = officialArrival(race).length > 0;
    // Lectures strictes : un échec lève et n'est pas gardé un jour en cache.
    const [history, dayIndex, payouts, stages] = await Promise.all([
      getRaceMarketHistory(race.id, { strict: true }),
      getDayRaceIndex(race.raceDate, { strict: true }),
      arrived ? getRacePayouts(race.id, { strict: true }) : Promise.resolve([]),
      getFrozenPredictions(race.id, { strict: true }),
    ]);
    return { race, history, dayIndex, payouts, stages };
  },
  ["race-page-settled"],
  { revalidate: 86_400 },
);

/**
 * Lecture de la course terminée, `undefined` si une lecture a échoué : la page
 * repasse alors par les lectures directes, sans rien garder en cache.
 */
const loadSettledSafe = cache(async (id: string) => {
  try {
    return await loadSettled(id);
  } catch (cause) {
    console.error("Course terminée %s : lecture incomplète, rien n'est gardé en cache", id, cause);
    return undefined;
  }
});

const dateLongue = new Intl.DateTimeFormat("fr-FR", {
  day: "numeric",
  month: "long",
  timeZone: "UTC",
  year: "numeric",
});

function formatDate(raceDate: string) {
  const [year, month, day] = raceDate.split("-").map(Number);
  if (!year || !month || !day) return raceDate;
  return dateLongue.format(new Date(Date.UTC(year, month - 1, day, 12)));
}

/** Décalage réel de Paris ce jour-là : +01:00 l'hiver, +02:00 l'été. */
function decalageParis(raceDate: string) {
  const [year, month, day] = raceDate.split("-").map(Number);
  if (!year || !month || !day) return "+01:00";

  const nom = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Paris", timeZoneName: "longOffset" })
    .formatToParts(new Date(Date.UTC(year, month - 1, day, 12)))
    .find((part) => part.type === "timeZoneName")?.value;

  return nom?.replace("GMT", "") || "+01:00";
}

/**
 * Les 100+ pages de courses partageaient le titre et la description du layout :
 * Google les voyait comme du contenu dupliqué et n'en indexait qu'une poignée.
 * Chaque course porte désormais ses propres balises et son canonique.
 */
/** Une URL mal encodée (« %E0 ») ne doit pas lever une erreur 500 : c'est une course introuvable. */
function safeDecode(id: string): string | null {
  try {
    return decodeURIComponent(id);
  } catch {
    return null;
  }
}

export async function generateMetadata({ params }: RacePageProps): Promise<Metadata> {
  const { id } = await params;
  const race = await loadRace(safeDecode(id));

  if (!race) {
    return {
      title: "Course introuvable",
      robots: { index: false, follow: true },
    };
  }

  const chemin = `/races/${encodeURIComponent(race.id)}`;
  const titre = `${race.programCode} ${properName(race.name)} — ${properName(race.racecourse)}`;
  // `race.horses[0]` était le premier numéro du tableau, pas le favori du
  // modèle : la description annonçait un « favori » qui n'en était pas un.
  const favori = buildSelection(race.horses).base?.horse ?? race.horses[0];
  const description =
    `Pronostic IA de la ${race.programCode} ${properName(race.name)} à ${properName(race.racecourse)}, ` +
    `le ${formatDate(race.raceDate)} à ${race.startTime} — ${race.discipline}, ${formatMeters(race.distance)}, ` +
    `${race.horses.length} partants.` +
    (favori ? ` Favori du modèle : ${favori.number} ${favori.horse}.` : "") +
    " Probabilités, top 3 et avis IA face au marché.";

  // Déclarer un bloc `openGraph` dans `generateMetadata` remplace celui du
  // layout — image comprise. Les cent et quelques pages de course, la surface
  // la plus partagée du site, sortaient donc sans `og:image` : lien collé sur
  // WhatsApp, X ou LinkedIn, la carte s'affichait en texte nu. L'image doit
  // être reprise explicitement.
  // Image propre à la course (opengraph-image.tsx du segment) : code,
  // hippodrome, heure et les trois premiers de l'IA.
  const image = {
    url: `${chemin}/opengraph-image`,
    width: 1200,
    height: 630,
    alt: `Pronostic Kayzen Turf — ${titre}`,
  };

  return {
    title: titre,
    description,
    alternates: { canonical: chemin },
    openGraph: {
      type: "article",
      url: chemin,
      title: `${titre} — Kayzen Turf`,
      description,
      images: [image],
    },
    twitter: {
      card: "summary_large_image",
      title: `${titre} — Kayzen Turf`,
      description,
      images: [image],
    },
  };
}

export default async function RacePage({ params }: RacePageProps) {
  const { id } = await params;
  const race = await loadRace(safeDecode(id));

  if (!race) notFound();

  // Navigation du jour : une requête légère sur `races`, sans partants.
  // Rapports : lus seulement une fois l'arrivée publiée.
  const arrived = officialArrival(race).length > 0;
  const settled = isSettled(race.id) ? ((await loadSettledSafe(race.id)) ?? null) : null;
  const [history, trackRecord, dayIndex, payouts] = await Promise.all([
    settled ? settled.history : getRaceMarketHistory(race.id),
    getLatestTrackRecord(),
    settled ? settled.dayIndex : getDayRaceIndex(race.raceDate),
    settled ? settled.payouts : arrived ? getRacePayouts(race.id) : Promise.resolve([]),
  ]);

  /* Données structurées : une course est un SportsEvent daté et localisé. */
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "SportsEvent",
    "@id": `${SITE_URL}/races/${encodeURIComponent(race.id)}`,
    name: `${race.programCode} ${race.name}`,
    startDate: `${race.raceDate}T${race.startTime.replace("h", ":")}:00${decalageParis(race.raceDate)}`,
    eventStatus: "https://schema.org/EventScheduled",
    eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
    sport: `Course hippique — ${race.discipline}`,
    location: {
      "@type": "Place",
      name: properName(race.racecourse),
      address: { "@type": "PostalAddress", addressCountry: race.sourceCountry },
    },
    competitor: race.horses.slice(0, 6).map((horse) => ({
      "@type": "SportsTeam",
      name: horse.horse,
    })),
  };

  return (
    <>
      {/* Les noms de course, d'hippodrome et de cheval viennent de l'API PMU :
          `JSON.stringify` seul laissait passer `</script>`. */}
      <JsonLd data={jsonLd} />
      <CourseDetail
        dayIndex={dayIndex}
        frozen={
          // Lu à part et rendu en flux : la page s'affiche sans attendre cette comparaison.
          <Suspense fallback={null}>
            <FrozenSlot horseNames={Object.fromEntries(race.horses.map((h) => [h.number, h.horse]))} raceId={race.id} />
          </Suspense>
        }
        history={history}
        payouts={payouts}
        race={race}
        signals={trackRecord?.signals ?? []}
      />
    </>
  );
}

/** Ce que l'IA a changé entre H-60 et le départ — rien tant qu'il n'y a pas deux pronostics gelés. */
async function FrozenSlot({ raceId, horseNames }: { raceId: string; horseNames: Record<number, string> }) {
  const settled = isSettled(raceId) ? await loadSettledSafe(raceId) : undefined;
  const stages = settled ? settled.stages : await getFrozenPredictions(raceId);
  if (stages.length < 2) return null;
  return <FrozenDiffPanel horseNames={horseNames} stages={stages} />;
}
