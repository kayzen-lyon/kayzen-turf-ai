import { NextResponse } from "next/server";
import { getRaces } from "@/lib/race-repository";
import { adresseAppelant, limiterDebit, reponseTropDeRequetes } from "@/lib/rate-limit";
import {
  lireParametreOptionnel,
  reponseParametreInvalide,
  schemaDateRecente,
  schemaJourRelatif,
} from "@/lib/validation";

const LIMITE_APPELS = 60;
const FENETRE_MS = 60_000;

export async function GET(request: Request) {
  const limite = limiterDebit(`races:${adresseAppelant(request)}`, LIMITE_APPELS, FENETRE_MS);
  if (!limite.autorise) return reponseTropDeRequetes(limite);

  const { searchParams } = new URL(request.url);

  const date = lireParametreOptionnel(schemaDateRecente, searchParams.get("date"));
  if (!date.ok) return reponseParametreInvalide("date", date.message);

  const jour = lireParametreOptionnel(schemaJourRelatif, searchParams.get("day"));
  if (!jour.ok) return reponseParametreInvalide("day", jour.message);

  // Le dépôt lève `ErreurSourceDonnees` quand la base ne répond pas : sans
  // filet, Next renvoyait un 500 générique et laissait le CDN en mémoriser
  // l'absence. Un 503 non mis en cache dit la panne et invite à réessayer.
  let races;
  try {
    races = await getRaces({ date: date.valeur, day: jour.valeur });
  } catch (cause) {
    console.error("GET /api/races : lecture des courses impossible", cause instanceof Error ? cause.message : cause);
    return NextResponse.json(
      { error: "Données momentanément indisponibles." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  return NextResponse.json(
    { generatedAt: new Date().toISOString(), data: races },
    // Programme partagé : garder la réponse en cache évite de recharger tous
    // les partants et leur historique à chaque visite.
    { headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=900" } },
  );
}
