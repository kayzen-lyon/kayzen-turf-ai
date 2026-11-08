import { renderToBuffer } from "@react-pdf/renderer";
import { NextResponse } from "next/server";
import { getRaces } from "@/lib/race-repository";
import { PronosticsPDF } from "@/lib/pronostics-pdf";
import { adresseAppelant, limiterDebit, reponseTropDeRequetes } from "@/lib/rate-limit";
import { lireParametreOptionnel, reponseParametreInvalide, schemaDateRecente } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Rendu PDF complet : coûteux en CPU, donc plafonné plus bas que les autres. */
const LIMITE_APPELS = 5;
const FENETRE_MS = 60_000;

function parisToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export async function GET(request: Request) {
  const limite = limiterDebit(
    `pdf:${adresseAppelant(request)}`,
    LIMITE_APPELS,
    FENETRE_MS,
  );
  if (!limite.autorise) return reponseTropDeRequetes(limite);

  const { searchParams } = new URL(request.url);

  // `date` finissait dans un cast `::date` SQL et dans l'en-tête
  // `Content-Disposition`, sans le moindre contrôle.
  const date = lireParametreOptionnel(schemaDateRecente, searchParams.get("date"));
  if (!date.ok) return reponseParametreInvalide("date", date.message);

  const jour = date.valeur ?? parisToday();

  // Une panne de la source (`ErreurSourceDonnees`) répond 503 sans cache,
  // distinct du 404 « aucune course ce jour-là ».
  let races;
  try {
    races = await getRaces({ date: jour });
  } catch (cause) {
    console.error("GET /api/pdf/pronostics : lecture des courses impossible", cause instanceof Error ? cause.message : cause);
    return NextResponse.json(
      { error: "Données momentanément indisponibles." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  if (!races.length) {
    return NextResponse.json(
      { error: `Aucune course disponible pour le ${jour}` },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }

  const buffer = await renderToBuffer(<PronosticsPDF races={races} date={jour} />);

  // `jour` a passé le schéma : il ne contient que des chiffres et des tirets.
  const filename = `kayzen-pronostics-${jour}.pdf`;

  return new Response(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
      "X-RateLimit-Remaining": String(limite.restant),
    },
  });
}
