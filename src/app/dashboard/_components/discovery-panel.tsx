import { Search } from "lucide-react";
import Link from "next/link";
import { XiAgentsWidget } from "@/components/widgets/xiagents";
import { getCurrentUser } from "@/lib/current-user";
import { xiAgentSummaries } from "@/lib/xiagents/server";

// Every block states plainly that the feature does not exist yet: no invented topics, trends or accounts.
const TOPICS = { title: "Sujets suivis", description: "Vous ne suivez aucun sujet. Le suivi de sujets n’est pas encore disponible." };
const SECTIONS = [
  { title: "Tendances", description: "Ξ ne calcule pas encore de tendances." },
  { title: "Suggestions", description: "Les suggestions de comptes ne sont pas encore disponibles." },
];

function Placeholder({ id, title, description }: { id: string; title: string; description: string }) {
  return (
    <section aria-labelledby={id} className="rounded-2xl border px-4 py-3">
      <h2 id={id} className="text-xl font-extrabold">{title}</h2>
      <p className="mt-1 text-[15px] leading-snug text-muted-foreground">{description}</p>
    </section>
  );
}

/** Right column on large screens. */
export async function DiscoveryPanel() {
  const user = await getCurrentUser();
  // An unreadable agent list must not break every dashboard page: the widget then loads it itself.
  const agents = await xiAgentSummaries(user.id).catch(error => {
    console.error("ΞAgents widget data failed", error instanceof Error ? error.name : "unknown");
    return null;
  });
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
        <Placeholder id="discovery-topics" {...TOPICS} />
        <XiAgentsWidget initial={agents} />
        {SECTIONS.map(({ title, description }, index) => <Placeholder key={title} id={`discovery-${index}`} title={title} description={description} />)}
        <nav aria-label="Informations" className="flex flex-wrap gap-x-3 gap-y-1 px-4 text-[13px] text-muted-foreground">
          <Link href="/dashboard/about-us" className="hover:underline">À propos</Link>
          <Link href="/dashboard/terms" className="hover:underline">Utiliser Ξ</Link>
          <span>Ξ · MVP</span>
        </nav>
      </div>
    </aside>
  );
}
