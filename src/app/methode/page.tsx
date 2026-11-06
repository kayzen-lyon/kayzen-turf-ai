import Link from "next/link";
import type { Metadata } from "next";
import { ArrowLeft, Scale } from "lucide-react";
import modelFile from "@/lib/fundamental/model.json";
import { FEATURE_LABELS } from "@/lib/fundamental/features";
import { FUNDAMENTAL_TRAIN_CUTOFF, FUNDAMENTAL_VERSION } from "@/lib/fundamental/model";
import { ACCORD_MAX_GAP_PTS, ACCORD_RATIO_MAX, ACCORD_RATIO_MIN, CONFRONT_MIN_PCT } from "@/lib/confrontation";
import { FLOW_ACCEL_PTS, FLOW_ACCEL_WINDOW_MIN, FLOW_WINDOW_MIN, MVT_NOISE_PCT, STRONG_MONEY_PTS } from "@/lib/market";
import { MARKET_GAMMA, MODEL_VERSION, PLACE_LAMBDAS } from "@/lib/probability";
import { PROFILES_VERSION, PROFILE_LABELS, PROFILE_RULES, READING_LABELS, READING_RULES, type RaceReading } from "@/lib/profiles";
import { ProfileBadge } from "@/components/course/shared";
import { PRESS_THRESHOLDS } from "@/lib/press-consensus";
import { STAKE_WINDOW_MIN } from "@/lib/stake-board";
import {
  SURPRISE_FULL_AI_PCT,
  SURPRISE_FULL_RATIO,
  SURPRISE_KIND_LABELS,
  SURPRISE_LEVELS,
  SURPRISE_MAX_PER_RACE,
  SURPRISE_MIN_ODDS,
  SURPRISE_MIN_RATIO,
  SURPRISE_ODDS_BANDS,
  SURPRISE_PART_LABELS,
  SURPRISE_VERSION,
  SURPRISE_WEIGHTS,
  type SurprisePart,
} from "@/lib/surprise";

export const metadata: Metadata = {
  title: "Méthode — comment Kayzen Turf calcule ses pronostics",
  description:
    "Les règles publiées de Kayzen Turf : probabilité du marché, avis de l'IA sans cote, profils des chevaux (Base, Caché, Value, Outsider, Tocard, À éviter), score de surprise, MVT et parts des mises PMU.",
  alternates: { canonical: "/methode" },
};

type Evaluation = Record<string, { trainRaces: number; testRaces: number; uniform: { top1: number }; fundamental: { top1: number; logLoss: number }; marketClosing: { top1: number; logLoss: number } }>;
const evaluation = (modelFile as { evaluation: Evaluation }).evaluation;

function Section({ title, id, children }: { title: string; id?: string; children: React.ReactNode }) {
  return (
    <section className="scroll-mt-20 rounded-2xl border border-border bg-surface p-6 shadow-sm" id={id}>
      <h2 className="font-display text-xl font-bold text-fg">{title}</h2>
      <div className="mt-3 space-y-3 text-sm leading-6 text-muted">{children}</div>
    </section>
  );
}

const fr = (v: number) => v.toFixed(1).replace(".", ",");
const num = (v: number) => String(v).replace(".", ",");

const SURPRISE_PART_RULES: Record<SurprisePart, string> = {
  value: `rapport IA ÷ marché : plein à ${num(SURPRISE_FULL_RATIO)} fois ou plus, réduit si l'IA donne moins de ${SURPRISE_FULL_AI_PCT} % au cheval (trois fois 1 % ne vaut pas trois fois 8 %)`,
  ia: "1er de l'IA 15, 2e 12, 3e 10, 4e 7, 5e 5, 6e à 8e 2",
  forme: "cinq dernières courses de la musique : victoire 4, 2e-3e 3, 4e-5e 1, incident −2",
  entourage: "réussite du jockey/driver et de l'entraîneur, rétrécie vers la moyenne",
  marche: "MVT et argent : joué, argent entrant, smart money montent la note ; délaissé ne l'annule pas ; argent sortant la baisse",
};

export default function MethodePage() {
  return (
    <main className="min-h-screen bg-bg pb-20" id="contenu-principal">
      <div className="mx-auto max-w-4xl px-4 pt-6 sm:px-6 lg:px-8">
        <Link
          className="mb-6 inline-flex items-center gap-2 rounded-xl border border-border bg-surface px-3.5 py-2 text-sm font-medium text-muted shadow-sm transition hover:border-accent hover:text-accent-text"
          href="/"
        >
          <ArrowLeft size={14} /> Accueil
        </Link>

        <div className="mb-8 flex items-center gap-4">
          <div className="grid size-14 place-items-center rounded-2xl bg-accent-lo">
            <Scale className="text-accent-text" size={26} />
          </div>
          <div>
            <p className="text-xs font-bold uppercase tracking-widest text-muted">Méthode · {MODEL_VERSION} · {PROFILES_VERSION}</p>
            <h1 className="font-display text-3xl font-bold text-fg">Comment nous calculons, en toutes lettres</h1>
            <p className="mt-1 text-sm text-muted">
              Toutes les règles du site sont ici, avec leurs seuils. Leur rendement réel est publié sur le{" "}
              <Link className="font-semibold text-accent-text underline" href="/track-record">suivi de performance</Link>.
            </p>
          </div>
        </div>

        <div className="grid gap-6">
          <Section title="1. Deux avis indépendants : le marché et l'IA">
            <p>
              <strong className="text-fg">Le marché</strong> : la cote PMU, convertie en probabilité (1 ÷ cote), puis
              normalisée sur le peloton pour retirer la marge du PMU. C&apos;est le meilleur prédicteur gratuit qui
              existe, surtout à l&apos;approche du départ.
            </p>
            <p>
              <strong className="text-fg">L&apos;IA</strong> : un modèle fondamental ({FUNDAMENTAL_VERSION}) qui estime
              la probabilité de victoire <em>sans jamais voir la cote</em>. Il compare les chevaux d&apos;une même course
              (logit conditionnel, un modèle par discipline) à partir de :
            </p>
            <ul className="grid gap-1 sm:grid-cols-2">
              {Object.values(FEATURE_LABELS).map((label) => (
                <li key={label} className="rounded-lg bg-surface-sub px-3 py-1.5 text-xs text-fg">{label}</li>
              ))}
            </ul>
            <p>
              Il a été ajusté sur les courses antérieures au {new Date(FUNDAMENTAL_TRAIN_CUTOFF).toLocaleDateString("fr-FR")} et mesuré
              sur les suivantes, qu&apos;il n&apos;avait jamais vues :
            </p>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[480px] text-left text-xs">
                <thead>
                  <tr className="border-b border-border text-[10px] uppercase tracking-widest text-muted">
                    <th className="py-2">Discipline</th>
                    <th className="py-2 text-right">Courses mesurées</th>
                    <th className="py-2 text-right">Hasard</th>
                    <th className="py-2 text-right">IA</th>
                    <th className="py-2 text-right">Marché (cote finale)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border text-fg">
                  {Object.entries(evaluation).map(([discipline, e]) => (
                    <tr key={discipline}>
                      <td className="py-2 font-semibold">{discipline}</td>
                      <td className="py-2 text-right font-mono">{e.testRaces}</td>
                      <td className="py-2 text-right font-mono">{fr(e.uniform.top1)} %</td>
                      <td className="py-2 text-right font-mono">{fr(e.fundamental.top1)} %</td>
                      <td className="py-2 text-right font-mono">{fr(e.marketClosing.top1)} %</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-xs">Part des courses où le cheval jugé le plus probable a gagné.</p>
            </div>
            <p>
              Conclusion honnête : l&apos;IA lit vraiment la forme, mais elle trouve moins de gagnants que le marché. Son
              intérêt est d&apos;être <strong className="text-fg">indépendante</strong> : quand elle contredit le marché, le
              site le signale — et mesure si ce désaccord a de la valeur.
            </p>
          </Section>

          <Section title="2. La probabilité retenue et le classement">
            <p>
              Le classement de la page course suit une probabilité unique : le marché, dont la marge du PMU est retirée par
              un exposant ajusté sur les arrivées réelles (p ∝ (1/cote)<sup>γ</sup>, γ = {MARKET_GAMMA.toLocaleString("fr-FR", { maximumFractionDigits: 3 })}).
              L&apos;IA y est mélangée selon la méthode de Benter (p ∝ exp(α·log marché + β·log IA)), avec un poids β ajusté
              par discipline : mesuré sur 795 courses hors échantillon, contre la cote finale, il n&apos;apporte rien — β est
              donc fixé à 0. Nous ne prétendons pas battre le marché.
            </p>
            <p>
              Les probabilités Top 3 et Top 5 sont tirées par simulation (20 000 arrivées par course) d&apos;un modèle de
              Plackett-Luce corrigé de Henery : les places d&apos;honneur sont tirées avec des forces aplaties (p<sup>λ</sup>,
              λ = {PLACE_LAMBDAS[0].toLocaleString("fr-FR")} pour la 2e place, {PLACE_LAMBDAS[1].toLocaleString("fr-FR")} ensuite), sinon
              les favoris étaient surestimés à la place (réel / attendu 0,87) et les outsiders sous-estimés (1,40 à 1,65).
              La sélection publiée compte huit chevaux ; son Top 3 est simplement les trois premiers.
            </p>
          </Section>

          <Section title="3. Les profils des chevaux">
            <p>Chaque partant reçoit un seul profil, évalué dans cet ordre. Le premier qui s&apos;applique l&apos;emporte.</p>
            <ol className="space-y-2">
              {PROFILE_RULES.map(({ profile, rule }, i) => (
                <li key={profile} className="flex gap-3 rounded-xl border border-border bg-surface-sub p-3">
                  <span className="font-mono text-xs font-bold text-muted">{i + 1}</span>
                  <div>
                    <ProfileBadge profile={profile} />
                    <p className="mt-1 text-sm text-fg">{rule}</p>
                  </div>
                </li>
              ))}
            </ol>
            <p>
              Ces seuils sont des points de départ. Le suivi de performance publie le rendement de chacun — y compris
              lorsqu&apos;il est négatif — et toute modification change la version ({PROFILES_VERSION}).
              Le bandeau, les badges, la fiche cheval et le suivi lisent tous cette même classification.
            </p>
          </Section>

          <Section title="4. La lecture de la course">
            <ul className="space-y-2">
              {(Object.keys(READING_LABELS) as RaceReading[]).map((r) => (
                <li key={r}>
                  <strong className="text-fg">{READING_LABELS[r]}</strong> — {READING_RULES[r]}
                </li>
              ))}
            </ul>
            <p>Aucun pourcentage de « confiance » n&apos;est affiché : aucune mesure ne permettrait de le justifier.</p>
          </Section>

          <Section title="5. Mouvement des cotes (MVT) et parts des mises">
            <p>
              <strong className="text-fg">MVT</strong> : variation de la cote depuis le premier relevé du jour de la
              course. Sous ±{MVT_NOISE_PCT} %, nous parlons de stabilité. Une cote qui baisse signifie que le cheval est
              joué.
            </p>
            <p>
              <strong className="text-fg">Parts des mises</strong> : part du cheval dans le pool simple gagnant du PMU,
              et sa variation sur {FLOW_WINDOW_MIN} minutes ({FLOW_ACCEL_WINDOW_MIN} minutes pour l&apos;accélération).
              La tuile « Argent fort » s&apos;allume à +{STRONG_MONEY_PTS} points en {FLOW_WINDOW_MIN} minutes. Le PMU publie les
              enjeux par cheval, jamais par parieur : nous mesurons de l&apos;argent joué, jamais « l&apos;argent des initiés ».
            </p>
            <p>
              <strong className="text-fg">Mises en direct</strong> : enjeux du simple gagnant publiés par le PMU, en point
              de vente (PMU+) et en ligne (PMU Play). Le classement suit l&apos;argent reçu depuis un relevé vieux d&apos;au
              moins {STAKE_WINDOW_MIN} minutes. Les mises d&apos;un cheval ne baissent pas en pari mutuel : la flèche est verte
              s&apos;il reçoit plus vite que la course, rouge s&apos;il reçoit moins vite. La cote du matin est la cote de
              référence du PMU, figée avant son recalage à 30 minutes du départ.
            </p>
            <p>
              <strong className="text-fg">Force IA sur 100</strong> : probabilité du modèle fondamental, qui ne voit jamais
              la cote, rapportée à une chance égale entre les partants. 50 correspond à la chance moyenne de la course, et
              la note gagne 14 points chaque fois que cette chance double. Elle lit la musique, les gains, l&apos;âge, le sexe,
              les œillères, le recul ou le numéro, et la réussite du jockey et de l&apos;entraîneur. Le modèle en production
              ne lit encore ni la distance, ni le terrain, ni les chronos, ni le poids.
            </p>
            <p>
              <strong className="text-fg">Confrontation IA × marché</strong> : seuls les chevaux à au moins{" "}
              {CONFRONT_MIN_PCT} % pour l&apos;IA ou pour le marché sont classés. <em>Accord IA + marché</em> : écart de{" "}
              {ACCORD_MAX_GAP_PTS} points au plus, ou rapport IA ÷ marché entre {String(ACCORD_RATIO_MIN).replace(".", ",")} et{" "}
              {String(ACCORD_RATIO_MAX).replace(".", ",")}. Au-delà, le cheval est <em>favori IA</em> si l&apos;IA l&apos;estime plus
              haut que le marché, <em>favori marché</em> dans le cas inverse.
            </p>
            <p>
              <strong className="text-fg">Signaux d&apos;argent</strong> : <em>argent entrant</em> à +{STRONG_MONEY_PTS} points de
              part des mises en {FLOW_WINDOW_MIN} minutes ; <em>accélération</em> à +{FLOW_ACCEL_PTS} point en{" "}
              {FLOW_ACCEL_WINDOW_MIN} minutes, plus vite que sur les 10 minutes précédentes ; <em>smart money</em> quand
              l&apos;argent entre ou accélère, que la cote baisse et que l&apos;IA — qui ne voit jamais la cote — est
              favorable ou d&apos;accord. C&apos;est un argent que notre modèle indépendant confirme, pas une information sur
              ceux qui misent. À l&apos;inverse, <em>argent sortant</em> signale une part des mises en baisse de{" "}
              {STRONG_MONEY_PTS} points ou plus en {FLOW_WINDOW_MIN} minutes : le cheval est délaissé. Le rendement de chaque famille et de chaque signal est mesuré et publié sur le suivi de
              performance.
            </p>
          </Section>

          <Section id="surprise" title="6. Chevaux cachés · le score de surprise">
            <p>
              Une note de 0 à 100 ({SURPRISE_VERSION}) par partant, qui résume <strong className="text-fg">pourquoi</strong> l&apos;IA
              le juge sous-estimé. Elle additionne cinq briques :
            </p>
            <ul className="space-y-1.5">
              {(Object.keys(SURPRISE_WEIGHTS) as SurprisePart[]).map((part) => (
                <li key={part} className="rounded-lg bg-surface-sub px-3 py-2 text-xs text-fg">
                  <strong>{SURPRISE_PART_LABELS[part]}</strong> — {SURPRISE_WEIGHTS[part]} pts : {SURPRISE_PART_RULES[part]}.
                </li>
              ))}
            </ul>
            <p>
              <strong className="text-fg">Alertes</strong> : seulement si l&apos;IA voit le cheval au moins {num(SURPRISE_MIN_RATIO)} fois
              au-dessus du marché et si sa cote dépasse {SURPRISE_MIN_ODDS}/1 (le favori n&apos;est pas une surprise).{" "}
              <em>{SURPRISE_KIND_LABELS.value}</em> sous {SURPRISE_ODDS_BANDS.value}/1, <em>{SURPRISE_KIND_LABELS.surprise}</em> de{" "}
              {SURPRISE_ODDS_BANDS.value}/1 à {SURPRISE_ODDS_BANDS.tocard}/1, <em>{SURPRISE_KIND_LABELS.tocard}</em> au-delà. Niveau
              fort à {SURPRISE_LEVELS.forte}/100, possible à {SURPRISE_LEVELS.possible}, à surveiller à {SURPRISE_LEVELS.surveiller}. Un
              tocard n&apos;est signalé qu&apos;au niveau fort — l&apos;IA, moins tranchée que le marché, remonte presque toutes les
              grosses cotes — et une course compte {SURPRISE_MAX_PER_RACE} alertes au plus.
            </p>
            <p>
              <strong className="text-fg">Ce que le score n&apos;est pas.</strong> Mesuré sur 1 571 courses courues entre le 24 août et
              le 7 octobre 2026, hors de la période d&apos;entraînement de l&apos;IA, contre la cote finale : aucune des cinq briques
              n&apos;annonce plus de gagnants ni plus de chevaux placés que la cote elle-même. Le marché de clôture intègre déjà la
              forme, l&apos;entourage et le désaccord de l&apos;IA. Le score est un outil de lecture — il montre où l&apos;IA et le marché
              divergent, et pourquoi — et le rendement réel de ses alertes (simple gagnant et simple placé, rapports officiels)
              est publié sur le suivi de performance.
            </p>
          </Section>

          <Section id="pronostiqueurs" title="7. Pronostiqueurs × Marché">
            <p>
              Avec l&apos;accord des sites concernés, nous relevons avant le départ la sélection publique de Geny, Paris-Turf, ZEturf,
              Canalturf et Turfomania, ainsi que le pronostic presse publié par le PMU. Seuls les numéros et leur ordre sont repris,
              avec le nom de la source et un lien : jamais leurs textes. Un relevé fait après le départ n&apos;est jamais enregistré.
            </p>
            <p>
              Pour chaque cheval : le nombre de sites qui le citent et son rang chez chacun, la part des sites qui le citent
              (consensus), son rang sur le marché par la cote. Le degré d&apos;accord d&apos;une course mesure la part de chevaux
              communs entre les sélections, deux à deux, sur leurs cinq premiers.
            </p>
            <ul className="space-y-1.5">
              <li className="rounded-lg bg-surface-sub px-3 py-2 text-xs text-fg">
                <strong>Consensus sites + marché</strong> — cité par au moins {Math.round(PRESS_THRESHOLDS.sitesStrongShare * 100)} % des
                sites et dans les {PRESS_THRESHOLDS.marketStrongRank} premiers du marché.
              </li>
              <li className="rounded-lg bg-surface-sub px-3 py-2 text-xs text-fg">
                <strong>Alerte : recommandé par les sites, délaissé par le marché</strong> — cité par au moins{" "}
                {Math.round(PRESS_THRESHOLDS.sitesStrongShare * 100)} % des sites, mais au-delà du {PRESS_THRESHOLDS.marketWeakRank}e rang
                du marché.
              </li>
              <li className="rounded-lg bg-surface-sub px-3 py-2 text-xs text-fg">
                <strong>Alerte : soutenu par le marché, négligé par les sites</strong> — dans les {PRESS_THRESHOLDS.marketStrongRank}{" "}
                premiers du marché, mais cité par au plus {Math.round(PRESS_THRESHOLDS.sitesWeakShare * 100)} % des sites.
              </li>
            </ul>
            <p>
              Avec une seule source disponible, « cité » veut dire « dans ses {PRESS_THRESHOLDS.singleSourceTopRank} premiers » et la
              page l&apos;indique. Ces seuils ont été posés le 31 octobre 2026 sans mesure préalable : tout leur historique est donc
              hors échantillon. Le rendement de chaque catégorie, en simple gagnant et en simple placé, est calculé chaque semaine sur
              les rapports officiels et publié sur le suivi de performance.
            </p>
          </Section>

          <Section title="8. Fraîcheur, pronostics gelés et suivi">
            <p>
              Les cotes des courses imminentes sont relues toutes les 15 minutes au-delà d&apos;une heure du départ, toutes
              les 10 minutes jusqu&apos;à H-15, puis toutes les 2 minutes. Chaque page affiche l&apos;âge de la cote. Le pari mutuel
              ne fixe la cote qu&apos;après le départ : aucune cote affichée n&apos;est définitive.
            </p>
            <p>
              Le pronostic affiché est gelé à H-60, H-15 et juste avant le départ, avec la version du modèle. Le suivi de
              performance se calcule sur ces pronostics gelés et sur les rapports officiels du PMU — jamais sur un
              pronostic recalculé après l&apos;arrivée.
            </p>
          </Section>

          <Section title="9. Ce que nous ne faisons pas">
            <ul className="list-disc space-y-1 pl-5">
              <li>Aucune promesse de gain. Un rendement est toujours donné avec sa période, son nombre de paris et sa marge d&apos;erreur.</li>
              <li>Aucune source de cotes autre que le PMU : Betfair n&apos;est pas agréé par l&apos;ANJ, et les opérateurs n&apos;ouvrent pas de flux de données. Les sélections des sites de pronostics ne sont reprises qu&apos;avec leur accord.</li>
              <li>Aucun « {PROFILE_LABELS.cache.toLowerCase()} », « value » ou « surprise » présenté comme un pari gagnant : ce sont des désaccords entre l&apos;IA et le marché, dont nous mesurons la valeur.</li>
            </ul>
          </Section>
        </div>
      </div>
    </main>
  );
}
