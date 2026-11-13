#!/usr/bin/env -S npx tsx
/**
 * Boucle de rafraîchissement des cotes, des pools et des pronostics gelés.
 *
 * POURQUOI UNE BOUCLE
 *
 * Le workflow précédent demandait un passage toutes les 30 minutes. GitHub ne
 * garantit pas l'heure des déclenchements planifiés : du 30/09 au 02/10/2026,
 * 8 passages ont réellement tourné sur 60 prévus, avec jusqu'à deux heures de
 * retard. Les courses partaient donc avec des cotes de la veille au soir.
 *
 * Une boucle longue ne dépend plus de l'heure de déclenchement. Même des boucles
 * de trois heures laissaient des trous : le 03/10/2026, GitHub n'a déclenché que
 * 5 passages sur 32 prévus, et 40 % des courses sont parties sans cote fraîche.
 * Chaque boucle (près de six heures) relance donc elle-même la suivante en fin
 * de job (voir .github/workflows/live_refresh.yml) ; le cron ne sert plus que
 * de filet si la chaîne casse.
 *
 * Hors réunion, la boucle dort jusqu'à 90 min avant le prochain départ sans
 * interroger la base, pour laisser Neon se mettre en veille.
 *
 * Cadence (voir src/lib/live/refresh-race.ts) : une course est interrogée au
 * plus toutes les 15 min au-delà d'une heure du départ, toutes les 10 min entre
 * H-60 et H-15, toutes les 2 min dans le dernier quart d'heure. La boucle attend
 * elle aussi plus longtemps loin des départs, sans interroger la base à vide.
 *
 * Usage : npx tsx scripts/live-refresh.ts [--minutes 330] [--once]
 */

import { spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { imminentRaces, minutesToNextRace, refreshRace } from "@/lib/live/refresh-race";
import { delay } from "@/lib/pmu/client";
import { purgeStaleSubscriptions, pushConfigured, sendPushAlerts } from "@/lib/push/send";
import { PRESS_PASS_MARGIN_MS, pressPassPlan } from "./lib/press-sources/schedule.mjs";

function loadLocalEnv() {
  try {
    for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      const separator = trimmed.indexOf("=");
      if (!trimmed || trimmed.startsWith("#") || separator === -1) continue;
      process.env[trimmed.slice(0, separator)] ||= trimmed.slice(separator + 1).replace(/^"|"$/g, "");
    }
  } catch {
    // En CI, DATABASE_URL vient des secrets.
  }
}

function arg(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

async function pass() {
  const races = await imminentRaces();
  if (races.length === 0) return null;
  let closest = Infinity;
  const scratched: Array<{ raceId: string; horses: Array<{ horseId: string; number: number }> }> = [];
  for (const race of races) {
    const minutes = Number(race.minutes_to_start);
    closest = Math.min(closest, Math.max(minutes, 0));
    try {
      const outcome = await refreshRace(race.id, { minutesToStart: minutes });
      if (outcome.status === "refreshed") {
        if (outcome.scratchedHorseIds.length > 0) {
          scratched.push({
            raceId: race.id,
            horses: outcome.scratchedHorseIds.map((horseId, i) => ({ horseId, number: outcome.scratched[i]! })),
          });
        }
        const parts = [
          `${outcome.oddsChanged}/${outcome.runners} cotes modifiées`,
          outcome.snapshotRecorded ? "relevé historisé" : null,
          outcome.scratched.length ? `non-partants retirés : ${outcome.scratched.join(", ")}` : null,
          outcome.frozen.length ? `pronostic gelé ${outcome.frozen.join(", ")}` : null,
        ].filter(Boolean);
        console.log(`[live] ${race.id} (départ ${minutes >= 0 ? `dans ${Math.round(minutes)} min` : "passé"}) — ${parts.join(" · ")}`);
      }
    } catch (error) {
      console.warn(`[live] ${race.id} ignorée : ${(error as Error).message}`);
    }
    await delay(250);
  }
  try {
    const { sent } = await sendPushAlerts(scratched);
    if (sent > 0) console.log(`[push] ${sent} alerte${sent > 1 ? "s" : ""} envoyée${sent > 1 ? "s" : ""}`);
  } catch (error) {
    console.warn(`[push] alertes non envoyées : ${(error as Error).message}`);
  }
  return closest;
}

/**
 * SÉLECTIONS PRESSE
 *
 * La collecte presse ne tournait qu'avec l'import PMU, que GitHub déclenche avec
 * des heures de retard (13 h 28 au lieu de 05 h 30 le 13/11/2026) : les courses
 * du matin restaient sans pronostic presse. La boucle lance donc elle-même une
 * passe au démarrage puis toutes les 2 h 30 (scripts/lib/press-sources/schedule.mjs).
 *
 * La passe tourne dans un processus séparé, jamais attendue par la boucle : elle
 * dure plusieurs minutes (1,5 s entre deux requêtes par site) et ne doit pas
 * retarder les cotes. `--missing-only` : un site n'est redemandé que pour les
 * courses qu'il n'a pas encore couvertes.
 */
let pressPass: Promise<void> | null = null;
let lastPressPassAt: number | null = null;

function runPressImport(extraArgs: string[]): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["scripts/import-press.mjs", "--missing-only", ...extraArgs], { stdio: "inherit" });
    // Une passe presse en échec ne doit jamais arrêter la boucle des cotes.
    child.on("error", (error) => {
      console.warn(`[presse] passe non lancée : ${error.message}`);
      resolve();
    });
    child.on("close", () => resolve());
  });
}

function maybeStartPressPass(deadline: number) {
  if (pressPass) return;
  const now = Date.now();
  const plan = pressPassPlan({ now, lastPassAt: lastPressPassAt, deadline });
  if (!plan.run) return;
  lastPressPassAt = now;
  console.log(`[presse] passe lancée en tâche de fond${plan.tomorrow ? " (aujourd'hui puis demain)" : ""}`);
  pressPass = (async () => {
    await runPressImport([]);
    if (plan.tomorrow) await runPressImport(["--tomorrow"]);
  })().finally(() => {
    pressPass = null;
  });
}

async function main() {
  loadLocalEnv();
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

  const once = process.argv.includes("--once");
  if (!pushConfigured()) console.log("[push] VAPID_PRIVATE_KEY absente : alertes désactivées");
  else console.log(`[push] ${await purgeStaleSubscriptions()} abonnement(s) expiré(s) supprimé(s)`);
  const deadline = Date.now() + Number(arg("minutes") ?? 330) * 60_000;
  let passes = 0;

  do {
    if (!once) maybeStartPressPass(deadline);
    const closest = await pass();
    passes += 1;
    if (once) break;
    if (closest === null) {
      // Rien dans les 90 min : dormir jusqu'à l'entrée du prochain départ dans
      // la fenêtre (au plus une heure, le programme du lendemain peut arriver).
      const next = await minutesToNextRace();
      const sleepMinutes = Math.min(60, Math.max(1, (next ?? 60) - 90));
      const remaining = (deadline - Date.now()) / 60_000;
      console.log(`[live] aucune course dans les 90 min — pause de ${Math.round(Math.min(sleepMinutes, remaining))} min`);
      await delay(Math.max(0, Math.min(sleepMinutes, remaining)) * 60_000);
      continue;
    }
    // Aligner les vérifications sur la cadence réelle évite des requêtes SQL
    // qui seraient immédiatement refusées par le verrou de rafraîchissement.
    const pauseMinutes = closest <= 15 ? 2 : closest <= 60 ? 5 : 10;
    await delay(pauseMinutes * 60_000);
  } while (Date.now() < deadline);

  // Une passe presse encore en cours se termine avant la fin du job (bornée).
  if (pressPass) await Promise.race([pressPass, delay(PRESS_PASS_MARGIN_MS)]);

  console.log(`[live] terminé après ${passes} passages`);
}

/**
 * Quota Neon dépassé (HTTP 402) : la base reste fermée jusqu'au renouvellement
 * du quota ou à un changement d'offre. Relancer la boucle toutes les six
 * minutes n'y change rien et consomme des minutes d'Actions : le workflow lit
 * `quota_exceeded` et laisse le filet planifié (toutes les deux heures)
 * réessayer.
 */
function isQuotaExceeded(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /HTTP status 402|exceeded the (data transfer |compute time )?quota/i.test(message);
}

main().catch((error) => {
  console.error(error);
  if (isQuotaExceeded(error)) {
    console.error("[live] quota Neon dépassé : pas de relance immédiate, nouvel essai au prochain passage planifié");
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `quota_exceeded=true${"\n"}`);
  }
  process.exit(1);
});
