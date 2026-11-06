# Modèle fondamental enrichi : évaluation hors échantillon

Banc du 06/11/2026, en lecture seule. Rien n'est en production : `model.json` n'a pas changé.

## Verdict

- **Format 2 complet : rejeté.** Il ne bat pas le modèle actuel.
- **`MODEL_USES_HISTORY` en direct : rejeté.** Il ajouterait de 3,4 à 9 Go par mois pour un quota de 5 Go.
- **Chronos passés au trot : seul gain réel.** Log loss +0,0173, gagnant trouvé +0,9 pt, positif 8 mois sur 8. Candidat : `src/lib/fundamental/model.candidate.json`, non branché.
- **Le marché reste très loin devant.** Écart de log loss de 0,246 ; 32,9 % de gagnants trouvés contre 24,4 %. Le chrono améliore la note IA seule, pas le pronostic mélangé au marché.

## Protocole

- **Données :** 166 277 partants ; 6 468 courses de test, d'avril à novembre 2026.
- **Validation :** chaque mois est appris uniquement sur les mois précédents.
- **Sélection :** λ et groupes de variables sont choisis sur les 3 mois précédant le test, jamais sur le test.
- **Référence :** format 1 réajusté de la même façon, objectif gagnant seul. Gains appariés course par course, IC à 95 %.
- **Rejouer :** `npx tsx scripts/eval-fundamental-variants.ts --cache rows.json`, puis `--confirm-chrono` pour la confirmation.

## Résultats, toutes disciplines

Gain positif = meilleur que la référence.

| Variante | Log loss | Gain | IC 95 % | Gagnant trouvé | Gagnant dans le top 3 |
|---|---|---|---|---|---|
| Format 1 réajusté (référence) | 2,1784 | | | 24,4 % | 53,1 % |
| Format 2 complet sans chrono | 2,1827 | −0,0043 | −0,0105 ; +0,0019 | 23,8 % | 53,8 % |
| Format 2 complet avec chrono | 2,1768 | +0,0016 | −0,0048 ; +0,0080 | 24,1 % | 54,0 % |
| Format 2 sélectionné sans chrono | 2,1790 | −0,0007 | −0,0055 ; +0,0042 | 24,4 % | 53,8 % |
| Format 2 sélectionné avec chrono | 2,1727 | +0,0056 | +0,0005 ; +0,0108 | 24,7 % | 54,1 % |
| Marché à la clôture | 1,9331 | +0,2458 | +0,2304 ; +0,2612 | 32,9 % | 65,5 % |

Par discipline, le meilleur format 2 (sélectionné avec chrono) :

| Discipline | Courses | Gain | IC 95 % |
|---|---|---|---|
| Plat | 2 279 | +0,0017 | −0,0042 ; +0,0076 |
| Trot | 3 635 | +0,0074 | −0,0005 ; +0,0154 |
| Obstacle | 554 | +0,0103 | −0,0065 ; +0,0272 |

## Critères demandés par Fadi

Gain de chaque groupe ajouté au format 1, à objectif identique (top 3), sur avril-novembre.

| Critère | Plat | Trot | Obstacle | Lecture |
|---|---|---|---|---|
| Forme, 5 dernières, jockey, entraîneur | | | | Déjà dans le format 1 |
| Distance, terrain, hippodrome (`aptitude`) | +0,0006 | +0,0012 | +0,0032 | Négligeable, non significatif |
| Poids (`weight`) | −0,0013 | sans objet | −0,0233 | Pas mesurable : voir ci-dessous |
| Chronos (`chrono`) | sans objet | **+0,0162** | sans objet | Seul signal net |
| Fraîcheur (`recency`) | +0,0037 | +0,0072 | +0,0118 | Prometteur, à reconfirmer |

Ces écarts restent à prendre avec prudence : une quinzaine de variantes par discipline ont été comparées, et seul le chrono tient sur tous les mois.

## Confirmation du chrono au trot

Comparaison à objectif identique à la production (gagnant seul).

| Comparaison | Courses | Log loss | IC 95 % | Gagnant trouvé |
|---|---|---|---|---|
| Format 1 + chrono contre format 1, avril-novembre | 3 635 | +0,0173 | +0,0132 ; +0,0214 | +0,91 pt |
| Glissant contre production figée, juin-novembre | 2 751 | +0,0184 | +0,0133 ; +0,0235 | +0,95 pt |
| Candidat figé au 01/10 contre production, octobre-novembre | 385 | +0,0088 | −0,0062 ; +0,0238 | +2,86 pt |

Une fois mélangé au marché à w=0,10, le gain tombe à +0,0011. Le mélange passe d'environ 1,9501 à 1,949, et reste moins bon que le marché seul (1,9475).

Le candidat figé, seul test sans aucune information postérieure, n'est donc pas significatif en log loss : l'échantillon est petit et les chronos se raréfient (voir ci-dessous).

**Fuite :** le meilleur chrono passé gagne 12,8 % des courses, contre environ 80 % pour le chrono de la course elle-même. Un test vérifie qu'une course n'entre dans l'historique qu'après son jour.

## Limites des données

- **`entries.speed_figure` est inutilisable.** Elle est vide sur toutes les courses terminées, et n'a que 3 valeurs sur 1 684 partants récents. Le groupe `chrono` lit donc `reduction_km` des sorties antérieures du cheval, jamais celle du jour.
- **Les chronos ne sont plus enregistrés.** L'import n'écrit plus `reduction_km` une fois la course partie (couverture au trot : 70 % en septembre, 34 % en octobre, 0 % en novembre). Le gain s'efface déjà en novembre (+0,0008 sur 97 courses), avec 24,7 % de chronos manquants.
- **Poids et corde n'existent que depuis septembre 2026.** Le déferrage aussi, à 70 % au trot. Ces variables n'ont qu'un à deux mois d'apprentissage : pas de verdict possible avant quelques mois.
- **Le terrain est presque vide au trot** (environ 5 %).
- **Le jeu de données a des trous de plusieurs mois**, ce qui fausse les variables de fraîcheur.
- **Le périmètre a changé le 10/10** (programme point de vente seul) : octobre-novembre n'est pas tout à fait la même population.

## Coût en transfert Neon

Mesure réelle : 364 963 octets pour l'historique des 446 partants du 06/11 (2 140 lignes, 171 octets par ligne).

| Poste | Hypothèse | Par mois |
|---|---|---|
| Programme (3 jours, 1,19 Mo à chaque recharge) | 96 à 144 recharges par jour, cache de 10 min | 3,4 à 5,1 Go |
| Pages de course (environ 10 Ko chacune) | Au pire 80 courses, toutes les 5 min, 14 h par jour | jusqu'à 4 Go |
| **Total en direct** | | **3,4 à 9 Go** |
| Variante précalculée : 2 colonnes sur `entries` | Estimation, non mesurée | environ 0,1 Go |
| Un entraînement ou un banc complet | Mesuré : 55,2 Mo | 1 % du quota par exécution |

Ce sont des bornes : le nombre réel de recharges dépend du trafic, et la consommation du mois en cours n'a pas été lue (pas de clé d'API Neon). Autre risque non vérifié : l'objet `history` gonfle la valeur mise en cache, et Vercel refuse les entrées de plus de 2 Mo, ce qui annulerait le cache du programme.

## Recommandation

1. Ne pas activer le format 2 ni l'historique en direct.
2. Ne pas brancher le candidat tel quel : en production, il lirait des chronos manquants pour tous les chevaux récents.
3. S'il faut le gain au trot, procéder dans cet ordre :
   - enregistrer le chrono réalisé dans une colonne dédiée, et rattraper octobre-novembre depuis l'API PMU ;
   - calculer `chronoBest` et `chronoLast` à l'import, sans historique à la lecture ;
   - suivre le candidat en parallèle pendant 4 semaines, puis l'activer seulement si le gain tient.
4. Présenter la note sur 100 comme une note sportive, sans lui prêter une supériorité sur la cote.

## Changements de code

Aucun effet sur le site tant que `model.json` reste en format 1.

- Groupe `chrono` dans `features.ts` et `history.ts`.
- `reduction_km` ajouté à `fetchHorseHistories`, et variables chrono à `HISTORY_FEATURES`, pour qu'un modèle qui les lit reçoive les mêmes données en production.
- **Attention :** le workflow `train_model.yml` testera désormais aussi ce groupe et peut le retenir. Un `model.json` qui le contient déclenche `MODEL_USES_HISTORY`, avec le coût ci-dessus.
