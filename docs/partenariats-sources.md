# Sources partenaires — sélections presse

Kayzen Turf compare ses analyses aux sélections publiques de cinq sites de
pronostics, qui ont donné leur accord pour cette réutilisation, et au pronostic
presse publié par le PMU. Ce document décrit ce qui est collecté, comment, et
où consigner les accords.

## Sources

| Clé (`press_selections.source`) | Site | Ce qui est lu | Statut au 31/10/2026 |
|---|---|---|---|
| `geny` | [geny.com](https://www.geny.com) | Pronostic de la rédaction Geny : « base » puis « belles chances » (pas les pronostics d'autres journaux repris sur la page) | Opérationnel |
| `zeturf` | [zeturf.fr](https://www.zeturf.fr) | Bloc « Notre choix » | Opérationnel |
| `canalturf` | [canalturf.com](https://www.canalturf.com) | Bloc « La sélection de … » (base, chances régulières, outsiders) | Opérationnel |
| `turfomania` | [turfomania.fr](https://www.turfomania.fr) | — | **Bloqué** : 403 Cloudflare |
| `paris-turf` | [paris-turf.com](https://www.paris-turf.com) | — | **Bloqué** : 403 Cloudflare |
| `pmu-presse` | API PMU (`online.turfinfo.api.pmu.fr`, source DATAHIPPIQUE) | 8 premiers du classement presse | Opérationnel |

Adresses utilisées :

- Geny : `/programme/{AAAA-MM-JJ}` puis `/course/{id}-{slug}/partants-pronostics` ;
- ZEturf : `/fr/programmes-et-pronostics-du-jour` puis `/fr/course-du-jour/{AAAA-MM-JJ}/R{r}C{c}-{slug}` (jour même uniquement) ;
- Canalturf : `/courses_liste_pronostics.php` (ou `_demain.php`) puis `/pronostics-PMU/{AAAA-MM-JJ}/{hippodrome}/{id}_{slug}.html` ;
- Turfomania : `/pronostics/` (sonde) ;
- Paris-Turf : `/programme-courses` (sonde) ;
- PMU : `/rest/client/61/programme/{JJMMAAAA}/R{r}/C{c}/pronostics`.

## Ce qui est collecté — et ce qui ne l'est pas

Pour chaque course : la date, la réunion (R), la course (C), **l'ordre des
numéros de selle** retenus par la source (5 à 8 chevaux en général) et l'adresse
de la page. Rien d'autre : ni commentaire, ni analyse, ni titre, ni nom de
pronostiqueur. Table `press_selections (race_id, source, ranks, url, fetched_at)`.

Une sélection n'est enregistrée que pour une course **pas encore partie**
(heure de départ, à Paris, postérieure au moment de l'écriture, vérifiée deux
fois) : tout ce qui est stocké est d'avant-course, sans relecture rétrospective.

Rapprochement avec nos courses : par numéro de réunion et de course PMU quand le
site les publie (ZEturf, Canalturf, Geny, PMU), confirmé par l'heure et
l'hippodrome ; en cas de désaccord, par hippodrome + heure de départ, qui doivent
désigner une seule course. Une course qu'on ne rapproche pas avec certitude est
ignorée.

## Cadence

La boucle en direct (`scripts/live-refresh.ts`, workflow `Live refresh`) lance
une passe en tâche de fond à son démarrage, puis toutes les 2 h 30, entre 6 h et
minuit (Paris) ; à partir de 18 h, la passe relève aussi les courses du
lendemain. Ces passes utilisent `--missing-only` : une course déjà relevée chez
une source n'est pas redemandée à son site, et une source complète n'est pas
contactée. Règles dans `scripts/lib/press-sources/schedule.mjs`.

Une passe complète (qui rafraîchit aussi les sélections déjà relevées) reste
faite par le workflow `Import PMU programme`
(`.github/workflows/import_pmu.yml`, étape « Import press selections »), deux
fois par jour après l'import PMU. Elle ne suffit pas seule : GitHub déclenche ce
workflow avec des heures de retard (13 h 28 au lieu de 05 h 30 à Paris le
13/11/2026), et comme seules les courses pas encore parties sont écrites, les
courses du matin restaient sans sélection.

Chaque passe est séquentielle : une source après l'autre.

## Identité et politesse du robot

- User-Agent : `KayzenTurfBot/1.0 (+https://kayzen-turf-ai.vercel.app/methode)`,
  jamais celui d'un navigateur ;
- au moins 1,5 s entre deux requêtes vers un même site ;
- respect des règles `Disallow` de robots.txt (groupe `*`, ou groupe nommant
  notre robot), relu à chaque exécution ;
- délai maximal de 20 s par requête ;
- au plus 120 requêtes par site et par passe (une journée de courses) ;
- aucune reprise automatique sur un refus (401, 403, 429, 451).

## Règle : aucun contournement

Aucune protection technique n'est contournée : pas d'usurpation de navigateur,
pas de résolution de captcha ou de défi anti-robot, pas de connexion à un
compte, pas de proxy. Un refus est enregistré comme statut `blocked` et la source
est simplement absente pour la journée.

## Paris-Turf et Turfomania : demande d'autorisation du robot

Au 31/10/2026, robots.txt est lisible sur les deux sites (et le sitemap chez
Paris-Turf), mais toutes les pages de contenu répondent **403** avec un défi
Cloudflare à notre robot. La collecte rend donc `blocked`.

À demander à chacun : ajouter le User-Agent
`KayzenTurfBot/1.0 (+https://kayzen-turf-ai.vercel.app/methode)` à la liste
blanche de leur pare-feu (règle Cloudflare « Allow » sur ce User-Agent), ou
fournir un flux dédié (JSON / RSS) des sélections. Une fois l'accès ouvert, le
collecteur rendra `error` (« parseur à écrire ») tant que le parseur n'aura pas
été écrit sur une page réelle : aucun parseur n'a été écrit à l'aveugle.

## Accords écrits

| Source | Accord écrit | Date | Référence |
|---|---|---|---|
| Geny | | | |
| Paris-Turf | | | |
| ZEturf | | | |
| Canalturf | | | |
| Turfomania | | | |
| PMU (pronostic presse) | | | |

## Exploitation

```bash
node scripts/import-press.mjs                         # aujourd'hui, écrit en base
node scripts/import-press.mjs --dry-run               # affiche sans écrire
node scripts/import-press.mjs --from-pmu --dry-run    # sans base : courses lues sur l'API PMU
node scripts/import-press.mjs --date 2026-11-01 --only geny,zeturf
```

Le script sort en 0 même si une source échoue ; il affiche un récapitulatif par
source (statut, courses rapprochées).
