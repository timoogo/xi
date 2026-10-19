import { Search } from "lucide-react";
import Link from "next/link";

// Every block states plainly that the feature does not exist yet: no invented topics, trends or accounts.
const SECTIONS = [
  { title: "Sujets suivis", description: "Vous ne suivez aucun sujet. Le suivi de sujets n’est pas encore disponible." },
  { title: "Générateurs Ξ", description: "Aucun générateur actif. Les générateurs de veille arriveront dans une prochaine version." },
  { title: "Tendances", description: "Ξ ne calcule pas encore de tendances." },
  { title: "Suggestions", description: "Les suggestions de comptes ne sont pas encore disponibles." },
];

/** Right column on large screens. */
export function DiscoveryPanel() {
  return (
    <aside aria-label="Découverte" className="hidden w-[320px] shrink-0 pl-6 lg:block xl:w-[350px] xl:pl-8">
      <div className="sticky top-0 space-y-4 pb-6">
        <div role="search" className="sticky top-0 z-10 bg-background py-1.5">
          <label className="flex h-11 items-center gap-3 rounded-full border bg-muted/60 px-4 text-muted-foreground">
            <Search aria-hidden="true" className="size-[18px] shrink-0" />
            <span className="sr-only">Rechercher (bientôt disponible)</span>
            <input type="search" disabled placeholder="Rechercher (bientôt)" className="min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed" />
          </label>
        </div>
        {SECTIONS.map(({ title, description }, index) => (
          <section key={title} aria-labelledby={`discovery-${index}`} className="rounded-2xl border px-4 py-3">
            <h2 id={`discovery-${index}`} className="text-xl font-extrabold">{title}</h2>
            <p className="mt-1 text-[15px] leading-snug text-muted-foreground">{description}</p>
          </section>
        ))}
        <nav aria-label="Informations" className="flex flex-wrap gap-x-3 gap-y-1 px-4 text-[13px] text-muted-foreground">
          <Link href="/dashboard/about-us" className="hover:underline">À propos</Link>
          <Link href="/dashboard/terms" className="hover:underline">Utiliser Ξ</Link>
          <span>Ξ · MVP</span>
        </nav>
      </div>
    </aside>
  );
}
