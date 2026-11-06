#!/usr/bin/env node
/**
 * Rattrapage des chronos réalisés (`entries.realized_km`) des courses de trot déjà
 * arrivées, depuis l'API PMU. L'import n'en écrivait plus depuis octobre 2026.
 *
 * À BLANC par défaut : n'écrit que si `--apply` est passé. N'écrase jamais une
 * valeur existante. `--apply` suppose le schéma appliqué (npm run db:schema).
 *
 * Contrôle affiché : le meilleur chrono d'une course doit gagner bien plus souvent
 * que le hasard (environ 80 %), sinon la valeur lue n'est pas le chrono réalisé.
 *
 * Usage : node scripts/backfill-realized-km.mjs [--from 2026-10-01] [--limit 100000] [--apply]
 */

import { neon } from "@neondatabase/serverless";
import { PMU_BASE, delay, fetchJson, loadLocalEnv } from "./lib/pmu-fetch.mjs";
import { realizedKm } from "./lib/pmu-integrity.mjs";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

async function main() {
  await loadLocalEnv();
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const sql = neon(process.env.DATABASE_URL);
  const from = arg("from", "2026-10-01");
  const limit = Number(arg("limit", "100000"));
  const apply = process.argv.includes("--apply");

  // `to_jsonb` : à blanc, le script tourne aussi avant l'ajout de la colonne.
  const races = await sql`
    select r.id
      from races r
     where r.discipline = 'Trot'
       and r.race_date >= ${from}::date
       and r.race_date < (now() at time zone 'Europe/Paris')::date
       and exists (select 1 from results res where res.race_id = r.id and res.finish_position = 1)
       and not exists (
         select 1 from entries e
          where e.race_id = r.id
            and (to_jsonb(e)->>'realized_km' is not null or coalesce(e.reduction_km, '0') <> '0')
       )
     order by r.race_date desc
     limit ${limit}
  `;
  const winners = await sql`
    select e.race_id, e.number from results res
      join entries e on e.race_id = res.race_id and e.horse_id = res.horse_id
     where res.finish_position = 1 and e.race_id = any(${races.map((r) => r.id)})
  `;
  const winnerNumber = new Map(winners.map((w) => [w.race_id, Number(w.number)]));
  console.log(`[chronos] ${races.length} courses de trot sans chrono depuis le ${from} (${apply ? "ÉCRITURE" : "à blanc"})`);

  let withChrono = 0;
  let without = 0;
  let values = 0;
  let bestWins = 0;
  for (const [index, { id }] of races.entries()) {
    const [, y, m, d, r, c] = id.match(/^(\d{4})-(\d{2})-(\d{2})-R(\d+)-C(\d+)$/) ?? [];
    if (!y) continue;
    try {
      const payload = await fetchJson(`${PMU_BASE}/${d}${m}${y}/R${r}/C${c}/participants`);
      // Présence en base d'un gagnant : l'arrivée est connue, `realizedKm` n'a plus qu'à filtrer la plage.
      const rows = (payload?.participants ?? []).flatMap((p) => {
        const km = realizedKm(p, [[winnerNumber.get(id) ?? 0]]);
        return km === null ? [] : [{ number: Number(p.numPmu), km }];
      });
      if (rows.length === 0) {
        without += 1;
      } else {
        withChrono += 1;
        values += rows.length;
        const best = rows.reduce((a, b) => (b.km < a.km ? b : a));
        if (best.number === winnerNumber.get(id)) bestWins += 1;
        if (apply) {
          await sql.query(
            `update entries e set realized_km = v.km
               from unnest($2::int[], $3::numeric[]) as v(number, km)
              where e.race_id = $1 and e.number = v.number and e.realized_km is null`,
            [id, rows.map((x) => x.number), rows.map((x) => x.km)],
          );
        }
      }
    } catch (error) {
      without += 1;
      if (!error?.permanent) console.warn(`[chronos] ${id} : ${error.message}`);
    }
    if ((index + 1) % 100 === 0) console.log(`[chronos] ${index + 1}/${races.length}`);
    await delay(150);
  }
  const share = withChrono ? ((100 * bestWins) / withChrono).toFixed(1) : "—";
  console.log(`[chronos] terminé : ${withChrono} courses, ${values} chronos, ${without} courses sans chrono publié ; le meilleur chrono gagne ${share} %`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
