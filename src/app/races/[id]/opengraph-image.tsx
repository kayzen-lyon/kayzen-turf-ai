import { ImageResponse } from "next/og";
import { probableArrival, raceToContext } from "@/lib/bet-recommendations";
import { MARQUE_DATA_URI, MARQUE_RATIO } from "@/lib/brand-mark";
import { properName } from "@/lib/format";
import { getRaceById } from "@/lib/race-repository";

/**
 * Image de partage propre à chaque course : code, hippodrome, heure et les
 * trois premiers de l'ordre probable de l'IA. Un lien de course collé sur
 * WhatsApp montre ainsi la course elle-même, plus l'image générique du site.
 * Une course inconnue retombe sur un visuel neutre, jamais sur une erreur.
 */
export const alt = "Pronostic Kayzen Turf pour cette course";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
// Chaque aperçu de lien relisait toute la course en base : une heure suffit
// pour une image de partage.
export const revalidate = 3600;

// Sans cette liste, même vide, la route est rendue à chaque appel malgré
// `revalidate` (voir la page de course).
export function generateStaticParams() {
  return [];
}

function safeDecode(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export default async function RaceOpengraphImage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const race = await getRaceById(safeDecode(id)).catch(() => null);
  const top = race ? probableArrival(race.horses, raceToContext(race)).slice(0, 3) : [];

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "64px 80px",
          background: "linear-gradient(135deg, #0c2318 0%, #123a26 55%, #0a1c12 100%)",
          color: "#e2ede5",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={MARQUE_DATA_URI} alt="" width={96} height={Math.round(96 / MARQUE_RATIO)} />
          <div style={{ display: "flex", fontSize: 24, fontWeight: 700, letterSpacing: 4, textTransform: "uppercase", color: "#7fd9a2" }}>
            Kayzen Turf
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <div style={{ display: "flex", fontSize: 30, color: "#a7c9b4" }}>
            {race ? `${race.programCode} · ${properName(race.racecourse)} · départ ${race.startTime}` : "Course PMU"}
          </div>
          <div style={{ display: "flex", fontSize: 60, fontWeight: 700, lineHeight: 1.1, letterSpacing: -1 }}>
            {race ? properName(race.name) : "Pronostic assisté par IA"}
          </div>
          {top.length > 0 && (
            <div style={{ display: "flex", gap: 16, marginTop: 8 }}>
              {top.map((h, i) => (
                <div
                  key={h.number}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 14,
                    padding: "12px 22px",
                    borderRadius: 18,
                    background: i === 0 ? "#3dca7a" : "rgba(226,237,229,0.10)",
                    color: i === 0 ? "#0c1a10" : "#e2ede5",
                    fontSize: 30,
                    fontWeight: 700,
                  }}
                >
                  <div style={{ display: "flex", fontSize: 38 }}>{h.number}</div>
                  <div style={{ display: "flex", fontSize: 24 }}>{properName(h.horse).slice(0, 18)}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 22, color: "#7fd9a2", fontWeight: 700 }}>
          <div style={{ display: "flex" }}>Ordre probable de l&apos;IA — aucune garantie de gain</div>
          <div style={{ display: "flex" }}>Jouer comporte des risques. 18+</div>
        </div>
      </div>
    ),
    size,
  );
}
