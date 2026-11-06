"use client";

import { useEffect, useRef, useState } from "react";

/**
 * SOMMAIRE DE LA PAGE COURSE — rail latéral sur grand écran, barre de
 * pastilles défilante sous l'en-tête du site sur mobile. La section lue est
 * surlignée (IntersectionObserver, aucun calcul au défilement).
 *
 * Les ancres sont posées par course-detail.tsx sur chaque bloc. Les sections
 * portent `scroll-mt-*` pour ne pas passer sous les barres collantes.
 */

export const COURSE_SECTIONS = [
  { id: "verdict", label: "Verdict" },
  { id: "surprises", label: "Surprises IA" },
  { id: "pronostiqueurs", label: "Pronostiqueurs" },
  { id: "partants", label: "Partants" },
  { id: "carre-magique", label: "Carré magique" },
  { id: "fiche-cheval", label: "Fiche cheval" },
  { id: "tickets", label: "Tickets" },
  { id: "marche", label: "Marché" },
  { id: "simulation", label: "Simulation" },
  { id: "apres-course", label: "Après-course" },
  { id: "mises-direct", label: "Mises en direct" },
] as const;

type SectionId = (typeof COURSE_SECTIONS)[number]["id"];

function useActiveSection(): SectionId {
  const [active, setActive] = useState<SectionId>("verdict");
  const visible = useRef(new Set<string>());

  useEffect(() => {
    const elements = COURSE_SECTIONS.map((s) => document.getElementById(s.id)).filter((el): el is HTMLElement => el !== null);
    if (elements.length === 0 || typeof IntersectionObserver === "undefined") return;
    const seen = visible.current;
    // Bande de lecture : du tiers supérieur de l'écran à 40 % de sa hauteur.
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) seen.add(entry.target.id);
          else seen.delete(entry.target.id);
        }
        const first = COURSE_SECTIONS.find((s) => seen.has(s.id));
        if (first) setActive(first.id);
      },
      { rootMargin: "-30% 0px -60% 0px" },
    );
    elements.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, []);

  return active;
}

/** Barre de pastilles sous l'en-tête du site, sous 1024 px. */
export function SectionNavBar() {
  const active = useActiveSection();
  const barRef = useRef<HTMLUListElement>(null);

  // Garde la pastille active visible dans la barre, sans faire défiler la page.
  useEffect(() => {
    const bar = barRef.current;
    const chip = bar?.querySelector<HTMLElement>(`[data-section="${active}"]`);
    if (!bar || !chip || bar.offsetParent === null) return;
    bar.scrollTo({ left: chip.offsetLeft - bar.clientWidth / 2 + chip.clientWidth / 2, behavior: "smooth" });
  }, [active]);

  return (
    <nav aria-label="Sommaire de la course" className="sticky top-[65px] z-30 -mx-4 mt-4 border-y border-border bg-bg/95 backdrop-blur-sm sm:-mx-6 lg:hidden">
      <ul ref={barRef} className="kz-scroll relative flex gap-2 overflow-x-auto px-4 py-2 sm:px-6">
        {COURSE_SECTIONS.map((s) => (
          <li key={s.id} className="shrink-0" data-section={s.id}>
            <a
              aria-current={active === s.id ? "location" : undefined}
              className={`inline-flex min-h-8 items-center rounded-full border px-3 text-xs font-semibold transition ${
                active === s.id ? "border-accent bg-accent text-accent-fg" : "border-border bg-surface text-muted hover:text-fg"
              }`}
              href={`#${s.id}`}
            >
              {s.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** Rail latéral collant, à partir de 1024 px. */
export function SectionNavRail() {
  const active = useActiveSection();
  return (
    <nav aria-label="Sommaire de la course" className="sticky top-24 hidden self-start lg:block">
      <p className="px-3 text-[10px] font-bold uppercase tracking-widest text-muted">Sur cette page</p>
      <ul className="mt-2 grid gap-0.5 border-l border-border">
        {COURSE_SECTIONS.map((s) => (
          <li key={s.id}>
            <a
              aria-current={active === s.id ? "location" : undefined}
              className={`-ml-px block border-l-2 px-3 py-1.5 text-sm transition ${
                active === s.id ? "border-accent font-semibold text-accent-text" : "border-transparent text-muted hover:text-fg"
              }`}
              href={`#${s.id}`}
            >
              {s.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
