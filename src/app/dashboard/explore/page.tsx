import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { PublicationFeed } from "@/components/publications/publication-feed";
import { AgentItem, ResultSection, TopicItem } from "@/components/search/result-items";
import { SearchForm } from "@/components/search/search-form";
import { openPersonalTopic } from "@/lib/apis/topics";
import { getCurrentUser } from "@/lib/current-user";
import { MAX_QUERY_LENGTH, searchHref } from "@/lib/search/query";
import { searchCatalog } from "@/lib/search/resolve";
import { searchData } from "@/lib/search/server";

export const metadata: Metadata = { title: "Ξ | Explorer", description: "Rechercher des sujets, des #topics et des @ΞAgents." };

const VIA = { tag: undefined, alias: "ancien tag", segment: "correspondance du dernier segment" } as const;

export default async function ExplorePage({ searchParams }: { searchParams: Promise<{ q?: string | string[]; cursor?: string }> }) {
  const [{ q, cursor }, viewer] = await Promise.all([searchParams, getCurrentUser()]);
  const query = (Array.isArray(q) ? q[0] : q ?? "").slice(0, MAX_QUERY_LENGTH).trim();
  if (!query) return <>
    <PageHeader title="Explorer" />
    <div className="border-b p-4"><SearchForm autoFocus /></div>
    <section aria-label="Syntaxe de recherche" className="space-y-1 p-4 text-[15px] text-muted-foreground">
      <p><strong className="text-foreground">transport</strong> : publications contenant ces mots (accents, majuscules et pluriels courants ignorés), topics et ΞAgents correspondants.</p>
      <p><strong className="text-foreground">#transport</strong> : ouvre le topic correspondant (tag actuel ou ancien tag) ; s’il n’existe pas, crée votre fiche personnelle, visible uniquement par vous.</p>
      <p><strong className="text-foreground">@agent</strong> : ouvre le ΞAgent correspondant.</p>
      <p><strong className="text-foreground">#transport #climat</strong> : publications associées à tous ces topics, et liens déclarés entre eux.</p>
    </section>
  </>;

  const { topics, agents } = await searchData(viewer.id);
  const result = searchCatalog(query, topics, agents);
  if (result.redirect) redirect(result.redirect);
  const name = new Map(topics.map(topic => [topic.id, topic.name]));
  const resolvedTopics = result.topics.filter(ref => ref.match);
  // Publications: text terms and/or every referenced topic, by immutable id. An unresolved #tag matches nothing.
  const allTopicsResolved = result.topics.every(ref => ref.match);
  const topicIds = [...new Set(resolvedTopics.map(ref => ref.match!.topic.id))];
  const searchPublications = allTopicsResolved && (!!result.query.text || topicIds.length > 1);
  const empty = !searchPublications && !result.topics.length && !result.agents.length && !result.textTopics.length && !result.textAgents.length;

  return <>
    <PageHeader title="Explorer" subtitle={query} />
    <div className="border-b p-4"><SearchForm defaultValue={query} /></div>
    {result.topics.length ? (
      <ResultSection id="search-topics" title={resolvedTopics.length > 1 ? "Recherche croisée" : "Topics"}>
        <ul>{result.topics.map(ref => ref.match
          ? <TopicItem key={ref.tag} topic={ref.match.topic} note={VIA[ref.match.via]} />
          : <li key={ref.tag} className="px-3 py-2">
              <p><span className="font-semibold">#{ref.tag}</span> <span className="text-sm text-muted-foreground">: aucun topic ne porte ce tag.</span></p>
              {ref.candidates.length ? <><p className="mt-1 text-sm text-muted-foreground">{ref.ambiguous ? "Plusieurs topics se terminent par ce tag, choisissez :" : "Topics proches :"}</p><ul>{ref.candidates.map(topic => <TopicItem key={topic.id} topic={topic} />)}</ul></> : null}
              <form action={openPersonalTopic} className="mt-2">
                <input type="hidden" name="tag" value={ref.tag} />
                <button type="submit" className="rounded-full border px-3 py-1 text-sm font-medium hover:bg-accent">Créer et ouvrir ma fiche personnelle #{ref.tag}</button>
              </form>
            </li>)}
        </ul>
        {resolvedTopics.length > 1 ? (
          result.links.length
            ? <ul aria-label="Liens entre ces topics" className="mt-2 space-y-1 px-3 text-sm">{result.links.map(link => <li key={`${link.kind}:${link.from}:${link.to}`}>
                {name.get(link.from)} {link.kind === "parent" ? "→ spécialisé par →" : "↔ relation déclarée ↔"} {name.get(link.to)}
              </li>)}</ul>
            : <p className="mt-2 px-3 text-sm text-muted-foreground">Aucun lien direct déclaré entre ces topics.</p>
        ) : null}
      </ResultSection>
    ) : null}
    {result.agents.length ? (
      <ResultSection id="search-agents" title="ΞAgents">
        <ul>{result.agents.map(ref => ref.agent
          ? <AgentItem key={ref.handle} agent={ref.agent} />
          : <li key={ref.handle} className="px-3 py-2">
              <p><span className="font-semibold">@{ref.handle}</span> <span className="text-sm text-muted-foreground">: aucun ΞAgent visible ne porte ce handle.</span></p>
              {ref.candidates.length ? <ul>{ref.candidates.map(agent => <AgentItem key={agent.id} agent={agent} />)}</ul> : null}
            </li>)}
        </ul>
      </ResultSection>
    ) : null}
    {result.textTopics.length ? <ResultSection id="search-text-topics" title="Topics correspondants"><ul>{result.textTopics.map(topic => <TopicItem key={topic.id} topic={topic} />)}</ul></ResultSection> : null}
    {result.textAgents.length ? <ResultSection id="search-text-agents" title="ΞAgents correspondants"><ul>{result.textAgents.map(agent => <AgentItem key={agent.id} agent={agent} />)}</ul></ResultSection> : null}
    {empty ? <p className="p-4 text-[15px] text-muted-foreground">Aucun topic ni ΞAgent ne correspond à « {query} ».</p> : null}
    {searchPublications ? <>
      <h2 className="border-b px-4 pt-3 pb-2 text-lg font-bold">Publications</h2>
      {topicIds.length > 1 ? <p className="border-b px-4 py-2 text-sm text-muted-foreground">Publications associées à chacun de ces topics. Ce croisement ne constitue pas une relation entre eux.</p> : null}
      <PublicationFeed viewer={viewer} scope={{ kind: "search", text: result.query.text || undefined, topicIds }} cursor={cursor} path={searchHref(query)} label="Publications trouvées"
        empty={{ title: "Aucune publication", description: "Aucune publication accessible ne correspond à cette recherche." }} />
    </> : null}
  </>;
}
