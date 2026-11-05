import { notFound } from "next/navigation";
import { KonstruktorPanel } from "@/components/konstruktor/konstruktor-panel";
import { PageHeader } from "@/components/page-header";
import { AccountManager } from "@/components/accounts/account-manager";
import { XiAgentCategoryNav } from "@/components/xiagents/category-select";
import { SystemAgentList } from "@/components/xiagents/system-agent-list";
import { createArbitrationStore } from "@/lib/arbiter/arbitration";
import { getAppDatabase } from "@/lib/auth";
import { getCurrentUser } from "@/lib/current-user";
import { getSystemAgentStore } from "@/lib/system-agents/server";
import { TopicError } from "@/lib/topics/types";
import { systemAgentSummaries } from "@/lib/xiagents/server";
import { parseCategory } from "@/lib/xiagents/summary";
export const metadata = { title: "Ξ | ΞAgents" };

/** `?category=system` lists the instance's system agents; without it, the viewer's editorial agents (historical page). */
export default async function XiAgentsPage({ searchParams }: { searchParams: Promise<{ duplicate?: string | string[]; category?: string | string[] }> }) {
  const user = await getCurrentUser();
  const { duplicate, category: raw } = await searchParams;
  const category = parseCategory(typeof raw === "string" ? raw : undefined);
  if (!category) notFound();
  const header = <PageHeader title="ΞAgents" subtitle={category === "system" ? "Agents systèmes de l’instance" : "Vos identités éditoriales · validation humaine"}><XiAgentCategoryNav value={category} /></PageHeader>;
  if (category === "editorial") return <>{header}<KonstruktorPanel target={{ type: "new-agent", id: null }} intro="Décrivez la veille souhaitée : Konstruktor propose un ΞAgent et ses topics." /><AccountManager owner={user.id} duplicateId={typeof duplicate === "string" && /^[0-9a-f-]{36}$/.test(duplicate) ? duplicate : undefined} /></>;
  try {
    const [agents, summaries] = await Promise.all([getSystemAgentStore().then(store => store.list()), systemAgentSummaries(user.id)]);
    // The viewer's own arbitrations only, on @arbitre's card.
    const arbitrations = createArbitrationStore(getAppDatabase()).list(user.id, 30);
    return <>{header}<SystemAgentList agents={agents} summaries={summaries} arbitrations={arbitrations} /></>;
  } catch (error) {
    // A blocked initialisation (invalid file, handle conflict) is explained, never repaired here.
    if (!(error instanceof TopicError)) throw error;
    return <>{header}<p role="alert" className="p-4 text-[15px] text-destructive">{error.message}</p></>;
  }
}
