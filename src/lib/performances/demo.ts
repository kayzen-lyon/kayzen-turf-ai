import type { DetailedRun, RunDiscipline } from "@/lib/performances/pmu-performances";

/**
 * Dernières courses FICTIVES pour le mode démonstration (aucune base
 * configurée) : les courses de démonstration n'existent pas au PMU, il n'y a
 * donc rien à lire. Valeurs déterministes, dérivées du numéro du partant ; le
 * bandeau de démonstration du site annonce déjà que tout est fictif.
 */

const RACECOURSES = ["VINCENNES", "ENGHIEN", "CAEN", "LAVAL", "CABOURG"];
const GOINGS = ["Bon", "Souple", "Bon léger", "Collant"];
const DISCIPLINE: Record<string, RunDiscipline> = { Plat: "plat", Trot: "attele", Obstacle: "haies" };
const BASE_KM_MS: Record<string, number> = { Plat: 61_000, Trot: 74_000, Obstacle: 77_000 };

function shiftDay(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export function demoPerformances(
  race: { raceDate: string; discipline: "Plat" | "Trot" | "Obstacle"; distance: number | null },
  numbers: readonly number[],
): Map<number, DetailedRun[]> {
  const distance = race.distance ?? 2100;
  const galop = race.discipline !== "Trot";
  return new Map(
    numbers.map((number) => {
      const seed = (number * 7919) % 97;
      const count = 2 + (seed % 4);
      const runs: DetailedRun[] = Array.from({ length: count }, (_, i) => {
        const step = (seed + i * 13) % 11;
        const position = step === 10 ? null : 1 + ((seed + i * 5) % 9);
        return {
          date: shiftDay(race.raceDate, 12 + i * (18 + (seed % 9)) + (seed % 5)),
          racecourse: RACECOURSES[(seed + i) % RACECOURSES.length],
          raceName: "PRIX DE DÉMONSTRATION",
          discipline: DISCIPLINE[race.discipline],
          distance: distance + (i % 3 === 2 ? 600 : (step % 3) * 50),
          going: galop ? GOINGS[(seed + i) % GOINGS.length] : null,
          fieldSize: 10 + (seed % 6),
          position,
          status: position === null ? (galop ? "A" : "AI") : null,
          weightKg: galop ? 55 + ((seed + i * 3) % 8) : null,
          kmTimeMs: position === null ? null : BASE_KM_MS[race.discipline] + ((seed * 37 + i * 211) % 2400),
        };
      });
      return [number, runs];
    }),
  );
}
