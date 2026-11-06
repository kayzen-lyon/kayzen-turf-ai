# Journal des modifications

Toutes les évolutions notables de Kayzen Turf sont consignées ici.

Le format suit [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/). Le
projet n'a pas de numéros de version publiés : les entrées sont datées par mise
en ligne (déploiement continu depuis `main`). La version publique, limitée à ce
qu'un visiteur peut constater, vit dans `src/lib/changelog.ts` et s'affiche sur
`/nouveautes` ; les deux sont mises à jour ensemble.

## [Non publié]

### Ajouté
- Mises en direct PMU+ / PMU Play × Force IA (`src/lib/stake-board.ts`, `src/lib/live/stakes.ts`, `src/components/course/stake-board.tsx`, `GET /api/races/[id]/stakes`) : enjeux par cheval des masses `SIMPLE_GAGNANT` et `E_SIMPLE_GAGNANT` (endpoint PMU `combinaisons`), cotes des deux masses, historique espacé dans `stake_snapshots`, cache CDN d'une minute. Cote du matin figée avant le recalage PMU de H-30. Note de force sur 100 tirée du modèle fondamental, sans cote.
- Pronostiqueurs × Marché (`src/lib/press-consensus.ts`, `src/components/course/press-panel.tsx`) : sélections des sites de pronostics (table `press_selections`, `scripts/import-press.mjs`) comparées au marché ; trois catégories, deux alertes, degré d'accord ; signaux `presse-*` au backtest, sélections relevées avant la cote de décision seulement.

### Modifié
- Plus aucun changement de course automatique (retour client) : glissement horizontal entre courses supprimé (`SwipeNavigation`, `swipeDirection`) ; la course active de l'accueil est fixée à la première lecture de l'horloge et ne change qu'avec le jour (`use-home-programme.ts`).

### Ajouté
- Score de surprise « Chevaux cachés · Surprise IA » (`src/lib/surprise.ts`, version `surprise-v1`) : note sur 100 en cinq briques (écart IA / marché, rang de l'IA, forme, entourage, marché du jour), alertes Sous-coté IA / Surprise IA / Tocard malin / À surveiller, trois au plus par course, raisons et conclusion par cheval. Page course : panneau dédié, onglet « Analyse complète », bloc dans la fiche cheval. Accueil : « Top 3 surprises du jour » (`src/lib/home/surprises.ts`). Méthode : section 6. Backtest : signaux `surprise-sg` et `surprise-sp`. Mesure préalable sur 1 571 courses (24/08 → 07/10/2026) contre la cote finale : aucune brique n'apporte d'information au-delà de la cote — le score est présenté comme un outil de lecture, pas comme une prévision.
- Page course : carré magique 16 partants (`src/lib/magic-square.ts`, `src/components/course/magic-square.tsx`). Carré d'ordre 4 bâti sur deux carrés latins diagonaux orthogonaux : ses 16 alignements (lignes, colonnes, diagonales, quarts, centre, coins) totalisent 34 et prennent chacun un cheval par quart du classement. Chances exactes Plackett-Luce (gagnant, 2 sur 4, Quarté+ désordre) ; meilleure lecture au 2 sur 4.
- /pronostics : navigation latérale par réunion, filtres, recherche, tri, vue compacte, sélecteur de jour, raccourcis clavier (`src/components/pronostics/`, `src/lib/pronostics-filters.ts`).
- /direct : courses des 30 prochaines minutes (`src/lib/direct.ts`).
- Page course : sommaire, navigation entre courses, comparateur, graphique de toutes les cotes, nuage IA × marché, différences depuis la dernière visite, lexique au survol, partage du ticket en image, image Open Graph par course, cartes mobiles, glissement entre courses, éclair des cotes, comparaison H-60 → départ.
- Accueil découpé en `src/components/home/` et `src/lib/home/` : ligne du temps, chevaux suivis, résumé du jour, bilan d'hier, aperçu au survol, blocs personnalisables.
- Alertes push : smart money, délaissé, arrivée (`src/lib/push/market-alerts.ts`) ; historique `/alertes` ; nouveaux motifs dans `push_deliveries`.
- Backtest : série quotidienne par signal, signaux placés de la confrontation, contrôle « argent sortant » ; `npm run model:confrontation`.
- Export CSV `/api/races/[id]/historique.csv`.
- PWA : service worker réseau d'abord avec copies hors ligne, invitation à l'installation, barre de navigation mobile.
- Workflow Lighthouse (seuils en avertissement).
- Page publique « État du service » (`/etat`) : âge des dernières cotes, dernier import du programme, couverture des cotes sur les courses du jour, dernier rapport de suivi de performance ; état « mode démonstration » explicite sans base.
- Page publique « Nouveautés » (`/nouveautes`), alimentée par `src/lib/changelog.ts`.
- Tests de bout en bout Playwright (`npm run test:e2e`, dossier `e2e/`) avec audit d'accessibilité axe-core sur l'accueil, une page course, `/pronostics` et `/methode` ; tâche CI `e2e` distincte.
- Couverture des tests unitaires (`npm run test:coverage`) sur `src/lib`, cible 80 %, non bloquante.
- Remontée structurée des erreurs serveur (`src/instrumentation.ts`, `onRequestError`) : une ligne JSON sans chaîne de requête ni en-têtes.
- `.env.example` documentant chaque variable d'environnement.
- Tests unitaires de `src/lib/rate-limit.ts`.

### Modifié
- Probabilités recalibrées au maximum de vraisemblance (`scripts/fit-market.ts`, coefficients et mesures dans `src/lib/market-calibration.json`, version `2026.10-marche-gamma-henery`) sur 1 562 courses (ajustement avant le 16/09/2026, validation sur 795 courses après) : marge retirée par un exposant γ = 1,076 au lieu du retrait proportionnel ; mélange de Benter α/β par discipline, β fixé à 0 faute de gain hors échantillon (la probabilité servie est le marché recalibré) ; ordre d'arrivée corrigé de Henery (λ2 = 0,774, λ3 = 0,526), qui ramène le réel / attendu du Top 3 de 0,87-1,65 à 0,86-1,04.
- « Value » calculée à la cote finale attendue (`src/lib/value-signal.ts`), seuil unique de +10 %, jamais affichée à plus de 30 minutes du départ ni sans cote ; ailleurs « écart IA / marché » en points de probabilité (accueil, /pronostics, profil « Écart IA »).
- Simulation de mise : plus de cote inventée sans cote publiée, plus de bankroll fictive ; mise de Kelly affichée seulement si l'espérance à la cote finale attendue est positive, en théorique. Fiche du modèle (`/api/model-card`) réécrite sur la chaîne réelle.
- Tickets : retour estimé pour 1 € (« Retour estimé ×0,82 · en dessous de la mise »), P_modèle × (1 − prélèvement) / P_public. Carré magique présenté comme lecture ludique.

### Corrigé
- Non-partants jamais retirés dans les petits pelotons : la garde « réponse tronquée » de `planScratches` comparait les seuls partants à 70 % des chevaux connus (6 chevaux dont 2 retirés : 4 < 4,2). Elle juge désormais la liste PMU complète, et retire toujours les non-partants déclarés.
- Relance des cotes : le verrou `odds_refreshed_at` est rendu si une étape SQL échoue après la lecture PMU.
- Course sans cotes publiées : probabilités de l'IA seule au lieu d'un mélange à 90 % avec une répartition uniforme (30 % devenait 11,6 % sur 10 partants).
- `src/app/loading.tsx` supprimé : deux `<main>` dans le HTML servi et statut 200 sur une course introuvable (le `notFound()` arrivait après le début du flux).
- Carré magique : cases vides et meilleure lecture annoncées aux lecteurs d'écran, case du cheval affiché en `aria-pressed`, « — » au lieu de « 0,00 % » quand moins de 4 chevaux ont une probabilité.
- Relevés react-doctor : valeurs par défaut stables dans la page course, lien interne via `next/link`, minuteur de la mémoire de défilement nettoyé, ancre mal encodée ignorée sur /pronostics, formateurs `Intl` créés une fois.
- Page course sur mobile : la grille principale n'avait pas de colonne explicite sous 1280 px et s'élargissait à son contenu (page de ~600 px sur un écran de 375 px).

## 2026-10-04

### Ajouté
- Confrontation IA × marché et signaux d'argent sur la page course (retour client).

### Modifié
- Fondations partagées : état de course (`src/lib/race-status.ts`), badges de paris sur variables de thème.

## 2026-10-03

### Ajouté
- Le site devient Kayzen Turf (le nom PronoTurf était déjà pris).
- Analyse IA de dernière minute relançable sur chaque course, avec le détail des changements.
- Classement MVT et argent ; signal MVT mesuré au backtest.
- Alertes push sur les chevaux suivis, sans compte.

### Modifié
- Site 100 % gratuit.

### Corrigé
- Boucle de rafraîchissement live continue ; alerte de fraîcheur sur les données de la veille.
- Audit complet : bugs, visuel, accessibilité, sécurité.

## 2026-10-02

### Ajouté
- Fondations données : boucle live, parts d'enjeux historisées, pronostics gelés (H-60, H-15, H-2), rapports officiels PMU.
- IA sans cote (modèle fondamental), profils mesurés, page course refondue, suivi de performance public.
- Chevaux suivis et alertes de départ, tests de stratégie, documentation.

### Corrigé
- Rapports officiels des réunions régionales, publiés hors audience nationale.
- Page Tarifs : deux affirmations fausses remplacées par ce qui existe.
- CI suivi de performance : rattrapage des rapports borné à 400 courses par passage.

## 2026-09-04

### Corrigé
- Une cote absente n'est plus fabriquée, et le site le dit.
- Audit complet : modèle débranché, pipeline destructif, sécurité, interface.

## 2026-08-30

### Ajouté
- Rafraîchissement horaire des cotes avant le départ ; cotes plus fraîches, non-partants retirés.
- Bancs de mesure : fraîcheur des cotes, confrontation des Quintés, poids du modèle par taille de peloton, variables d'avant-course.
- Diagnostic de santé de la base, en lecture seule.
- La sélection passe de 6 à 8 chevaux.

### Corrigé
- L'apprentissage se validait sur les courses qui l'avaient réglé.
- Import PMU : le journal réécrivait 12 000 courses à chaque passage ; l'apprentissage dépassait le timeout.

## 2026-08-16

### Ajouté
- Banc de mesure du pouvoir prédictif, modèle contre marché.
- Récupération de l'historique depuis l'API officielle PMU.

### Corrigé
- Poids du modèle ramené à l'optimum mesuré (0,30 → 0,10).
- Probabilités cohérentes, sélection unique, confiance des tickets en vraie probabilité.
- Arrivée provisoire remplacée par l'arrivée définitive.
- Indexation et TTFB : robots, sitemap, rendu incrémental ; calcul serveur rapatrié en Europe (fra1).
- Import PMU bloqué : la base Neon saturait de doublons.

### Sécurité
- Audit production : sécurité, RGPD, indexation et performance.

## 2026-05-12

### Ajouté
- Premières versions publiques : programme PMU complet, PDF des pronostics du jour, lexique, comparateur, favoris, compte à rebours, PWA.
