import type { Metadata } from "next";
import Link from "next/link";
import { GraphExplorer } from "@/components/graph/graph-explorer";
import { KnowledgeNetworkView } from "@/components/graph/knowledge-network";
import { TopicNetworkView } from "@/components/graph/topic-network";
import { PageHeader } from "@/components/page-header";
import { getAccountStore } from "@/lib/accounts/server";
import { getCurrentUser } from "@/lib/current-user";
import { knowledgeHref, parseKnowledgeRequest } from "@/lib/konstruktor/knowledge-graph";
import { knowledgeGraph } from "@/lib/konstruktor/knowledge-graph-data";
import { getPublicationStore } from "@/lib/publications/server";
import { networkHref, parseNetworkRequest } from "@/lib/topics/network";
import { topicNetwork } from "@/lib/topics/network-data";
import { getTopicRelationStore, getTopicStore } from "@/lib/topics/server";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Ξ | Graphe", description: "Explorer les générateurs, les publications, leurs connexions et le réseau des topics." };

// Page-local: the graph takes the whole width and height left by the navigation (the layout's 640px column and
// the discovery panel are lifted only while this page is rendered).
const FULL_WIDTH = `
#main-content:has([data-xi-graph]) { max-width: none; padding-bottom: 0; }
div:has(> #main-content [data-xi-graph]) { max-width: none; }
body:has([data-xi-graph]) #main-content ~ aside { display: none; }
`;

/**
 * Three independent modes: the existing tree (its state stays in IndexedDB, untouched), the topic network and one
 * ΞAgent's knowledge (both with their state in the URL).
 */
export default async function GraphPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [user, params] = await Promise.all([getCurrentUser(), searchParams]);
  const topics = params.view === "topics", knowledge = params.view === "knowledge";
  const request = topics ? parseNetworkRequest(params) : null;
  const knowledgeRequest = knowledge ? parseKnowledgeRequest(params) : null;
  const network = request ? await Promise.all([getTopicStore(), getTopicRelationStore(), getPublicationStore(), getAccountStore()])
    .then(([topics, relations, publications, accounts]) => topicNetwork(user.id, request, { topics, relations, publications, accounts })) : null;
  const learned = knowledgeRequest ? await Promise.all([getTopicStore(), getTopicRelationStore(), getPublicationStore(), getAccountStore()])
    .then(([topics, relations, publications, accounts]) => knowledgeGraph(user.id, knowledgeRequest, { topics, relations, publications, accounts })) : null;
  const tree = !topics && !knowledge;
  const tab = "inline-flex h-9 items-center rounded-full px-2 text-[13px] font-semibold sm:px-3.5 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";
  return (
    <div data-xi-graph="" className="flex h-[calc(100dvh-3.5rem-env(safe-area-inset-bottom))] min-h-[420px] flex-col sm:h-dvh">
      <style dangerouslySetInnerHTML={{ __html: FULL_WIDTH }} />
      <PageHeader title="Graphe" subtitle={topics ? "Topics, vos connaissances, vos centres d’intérêt et les ΞAgents experts" : knowledge ? "Concepts et relations appris par vos ΞAgents" : "Générateurs, publications et connexions validées"}>
        <nav aria-label="Mode du graphe" className="flex rounded-full border p-0.5">
          <Link href="/dashboard/graph" aria-current={tree ? "page" : undefined} className={cn(tab, tree ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground")}>Arbre actuel</Link>
          <Link href={networkHref({ layers: ["knowledge", "interests", "experts"], focus: null, open: [], proposed: false })} aria-current={topics ? "page" : undefined}
            className={cn(tab, topics ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground")}>Réseau Topics</Link>
          <Link href={knowledgeHref({ agents: [], all: false, focus: null, open: [], excluded: false })} aria-current={knowledge ? "page" : undefined}
            className={cn(tab, knowledge ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground")}>Connaissances</Link>
        </nav>
      </PageHeader>
      {network ? <TopicNetworkView network={network} className="flex-1" />
        : learned ? <KnowledgeNetworkView key={learned.request.all ? "all" : learned.selected.map(agent => agent.id).join(",") || "none"} graph={learned} className="flex-1" />
          : <GraphExplorer userId={user.id} className="flex-1" />}
    </div>
  );
}
