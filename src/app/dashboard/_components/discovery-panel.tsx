import { cookies } from "next/headers";
import Link from "next/link";
import { SearchForm } from "@/components/search/search-form";
import { XiAgentsWidget } from "@/components/widgets/xiagents";
import { getCurrentUser } from "@/lib/current-user";
import { topicHref } from "@/lib/search/query";
import { subscribedTopics } from "@/lib/search/server";
import { systemAgentSummaries, xiAgentSummaries } from "@/lib/xiagents/server";
import { parseCategory, widgetCategoryCookie } from "@/lib/xiagents/summary";

// Every block states plainly that the feature does not exist yet: no invented topics, trends or accounts.
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
  const system = await systemAgentSummaries(user.id).catch(error => {
    console.error("System agents widget data failed", error instanceof Error ? error.name : "unknown");
    return null;
  });
  // The user's own last choice; anything else (absent, foreign, invalid) is the editorial list.
  const preference = widgetCategoryCookie(user.id);
  const category = parseCategory((await cookies()).get(preference)?.value) ?? "editorial";
  const followed = await subscribedTopics(user.id).catch(error => {
    console.error("Followed topics failed", error instanceof Error ? error.name : "unknown");
    return null;
  });
  return (
    <aside aria-label="Découverte" className="hidden w-[320px] shrink-0 pl-6 lg:block xl:w-[350px] xl:pl-8">
      <div className="sticky top-0 space-y-4 pb-6">
        <div className="sticky top-0 z-10 bg-background py-1.5">
          <SearchForm />
        </div>
        <section aria-labelledby="discovery-topics" className="rounded-2xl border px-4 py-3">
          <h2 id="discovery-topics" className="text-xl font-extrabold">Sujets suivis</h2>
          {followed?.length ? <ul className="mt-1">{followed.map(topic => <li key={topic.id}><Link href={topicHref(topic.tag)} className="block py-1 text-[15px] hover:underline">{topic.name} <span className="text-muted-foreground">#{topic.tag}</span></Link></li>)}</ul>
            : <p className="mt-1 text-[15px] leading-snug text-muted-foreground">{followed ? "Abonnez-vous à un topic depuis sa page, par exemple en recherchant #transport." : "Vos sujets suivis sont momentanément indisponibles."}</p>}
        </section>
        <XiAgentsWidget initial={agents} initialSystem={system} initialCategory={category} preferenceCookie={preference} />
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
