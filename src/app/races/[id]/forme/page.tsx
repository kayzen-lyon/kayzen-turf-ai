import type { Metadata } from "next";
import Link from "next/link";
import { cache } from "react";
import { unstable_cache } from "next/cache";
import { notFound } from "next/navigation";
import { ArrowLeft, Timer } from "lucide-react";
import { ChronoTable, FormTable, Highlights, WeightTable } from "@/components/forme/form-board-view";
import { EmptyState } from "@/components/ui-kit";
import { formatMeters, hasOdds, properName } from "@/lib/format";
import { demoPerformances } from "@/lib/performances/demo";
import { buildFormBoard, type BoardRunner } from "@/lib/performances/form-board";
import { fetchRacePerformances, type DetailedRun } from "@/lib/performances/pmu-performances";
import { estModeDemonstration, getRaceById } from "@/lib/race-repository";
import type { RaceAnalysis } from "@/lib/types";

/**
 * CHRONOS, POIDS ET FORME — page indépendante d'une course.
 *
 * Trois lectures tirées des cinq dernières courses de chaque partant (API PMU),
 * sans cote ni presse : classement par chrono sur la distance du jour,
 * comparaison des poids, indicateur de forme. Règles dans
 * src/lib/performances/form-board.ts.
 *
 * Rendu incrémental comme la page course : la liste vide de
 * `generateStaticParams` active le cache page par page.
 */
export const revalidate = 900;

export function generateStaticParams() {
  return [];
}

type PageProps = { params: Promise<{ id: string }> };

function safeDecode(id: string): string | null {
  try {
    return decodeURIComponent(id);
  } catch {
    return null;
  }
}

const loadRace = cache(async (id: string | null) => getRaceById(id));

/**
 * Les dernières courses d'un partant ne changent pas dans la journée : une
 * lecture PMU par course et par heure, partagée entre les visiteurs. Un échec
 * lève et n'est donc pas gardé en cache.
 */
const loadPerformances = unstable_cache(
  async (raceId: string): Promise<Array<[number, DetailedRun[]]> | null> => {
    const performances = await fetchRacePerformances(raceId);
    return performances ? [...performances.entries()] : null;
  },
  ["forme-performances"],
  { revalidate: 3600 },
);

function meters(distance: string): number | null {
  const digits = String(distance ?? "").replace(/\D/g, "");
  return digits ? Number(digits) : null;
}

/** `entries.weight` est en décigrammes au PMU (580 = 58,0 kg) ; pas de poids porté au trot. */
function weightKg(race: RaceAnalysis, weight: number | null | undefined): number | null {
  if (race.discipline === "Trot" || weight == null || !Number.isFinite(weight) || weight <= 0) return null;
  return weight > 200 ? weight / 10 : weight;
}

/** `demo` : les courses fictives n'ont pas de poids ; un poids fictif garde le tableau lisible en démonstration. */
function runnersOf(race: RaceAnalysis, demo: boolean): BoardRunner[] {
  return race.horses.map((horse) => ({
    number: horse.number,
    name: horse.horse,
    jockey: horse.jockey,
    trainer: horse.trainer,
    odds: hasOdds(horse.odds) ? horse.odds : null,
    weightKg: weightKg(race, horse.weight ?? (demo ? 540 + ((horse.number * 15) % 80) : null)),
    nonRunner: (horse as { nonRunner?: boolean | null }).nonRunner === true,
  }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const race = await loadRace(safeDecode(id));
  if (!race) return { title: "Course introuvable", robots: { index: false, follow: true } };
  const chemin = `/races/${encodeURIComponent(race.id)}/forme`;
  return {
    title: `Chronos, poids et forme — ${race.programCode} ${properName(race.name)}`,
    description:
      `Partants de la ${race.programCode} ${properName(race.name)} à ${properName(race.racecourse)} classés par chrono sur ` +
      `${formatMeters(race.distance)}, comparaison des poids et indicateur de forme, d'après leurs cinq dernières courses.`,
    alternates: { canonical: chemin },
  };
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border bg-surface-sub px-3 py-2">
      <dt className="text-[10px] font-bold uppercase tracking-widest text-muted">{label}</dt>
      <dd className="mt-0.5 text-sm font-bold text-fg">{value}</dd>
    </div>
  );
}

export default async function FormePage({ params }: PageProps) {
  const { id } = await params;
  const race = await loadRace(safeDecode(id));
  if (!race) notFound();

  const raceHref = `/races/${encodeURIComponent(race.id)}`;
  const distance = meters(race.distance);
  const galop = race.discipline !== "Trot";

  const demo = estModeDemonstration();
  let performances: Map<number, DetailedRun[]> | null = null;
  let failed = false;
  if (demo) {
    performances = demoPerformances({ raceDate: race.raceDate, discipline: race.discipline, distance }, race.horses.map((h) => h.number));
  } else {
    try {
      const entries = await loadPerformances(race.id);
      performances = entries ? new Map(entries) : null;
    } catch (cause) {
      console.error("Performances PMU illisibles pour %s", race.id, cause);
      failed = true;
    }
  }

  const board = performances
    ? buildFormBoard({ date: race.raceDate, discipline: race.discipline, specialty: race.specialty, distance }, runnersOf(race, demo), performances)
    : null;

  return (
    <main className="min-h-screen bg-bg pb-20" id="contenu-principal">
      <div className="mx-auto max-w-[1280px] px-4 pt-6 sm:px-6 lg:px-8">
        <nav aria-label="Fil d'Ariane" className="mb-4 flex flex-wrap items-center gap-2">
          <Link
            className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-surface px-3.5 py-2 text-sm font-medium text-muted shadow-sm transition hover:border-accent hover:text-accent-text"
            href={raceHref}
          >
            <ArrowLeft aria-hidden="true" size={14} /> Retour à la course
          </Link>
          <span aria-hidden="true" className="text-muted/40">/</span>
          <span className="text-sm font-semibold text-fg">Chronos, poids et forme</span>
        </nav>

        <header className="overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
          <div className="border-t-4 border-accent px-5 py-4 sm:px-7">
            <p className="text-sm text-muted">
              {race.programCode} · {properName(race.racecourse)} · départ {race.startTime}
            </p>
            <h1 className="mt-1 font-display text-xl font-bold text-fg sm:text-2xl">Chronos, poids et forme — {properName(race.name)}</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-muted">
              Ce que disent les cinq dernières courses de chaque partant, sans tenir compte des cotes ni de la presse : qui a été le plus
              rapide sur cette distance, {galop ? "qui porte moins de poids que d'habitude, " : ""}et qui arrive en forme.
            </p>
            <dl className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Tile label="Type" value={race.specialty && race.specialty !== race.discipline ? `${race.discipline} · ${race.specialty}` : race.discipline} />
              <Tile label="Distance" value={formatMeters(race.distance) || "—"} />
              <Tile label="Terrain" value={race.going?.trim() || "Non publié"} />
              <Tile label="Partants" value={String(board ? board.rows.length : race.horses.length)} />
            </dl>
          </div>
        </header>

        {board ? (
          <>
            <Highlights board={board} galop={galop} />
            <ChronoTable board={board} distance={race.distance} galop={galop} />
            {galop ? (
              <WeightTable board={board} />
            ) : (
              <p className="mt-4 rounded-2xl border border-border bg-surface px-4 py-3 text-sm leading-6 text-muted shadow-sm sm:px-5">
                Au trot, les chevaux ne portent pas de poids imposé : la comparaison des poids ne s&apos;applique qu&apos;au plat et à
                l&apos;obstacle.
              </p>
            )}
            <FormTable board={board} />
          </>
        ) : (
          <EmptyState
            action={
              <Link className="text-sm font-semibold text-accent-text hover:underline" href={raceHref}>
                Revenir à la course
              </Link>
            }
            className="mt-4"
            icon={Timer}
            title={failed ? "Performances momentanément indisponibles" : "Pas de performances publiées pour cette course"}
          >
            {failed
              ? "Le PMU n'a pas répondu. Les chronos, les poids et la forme reviendront au prochain chargement de la page."
              : "Le PMU ne publie pas les dernières courses des partants de cette course."}
          </EmptyState>
        )}
      </div>
    </main>
  );
}
