import { PageHeader } from "@/components/page-header";
import { AddSource } from "@/components/sources/add-source";
import { SourceTrustList } from "@/components/sources/source-trust-list";
import { getAccountStore } from "@/lib/accounts/server";
import { getAppDatabase } from "@/lib/auth";
import { getCurrentUser } from "@/lib/current-user";
import { getTopicStore } from "@/lib/topics/server";
import { getWatchServices } from "@/lib/watch/server";
import { trustMatrix } from "@/lib/watch/trust";

export const metadata = { title: "Ξ | Sources" };
export const dynamic = "force-dynamic";

export default async function SourcesPage() {
  const user = await getCurrentUser();
  const [accounts, topics, { sources }] = await Promise.all([getAccountStore(), getTopicStore(), getWatchServices()]);
  const matrix = await trustMatrix({ db: getAppDatabase(), accounts, topics, sources }, user.id);
  return <>
    <PageHeader title="Sources" subtitle="Confiance accordée aux sources de vos ΞAgents">
      <AddSource topics={matrix.topics.filter(topic => matrix.agents.some(agent => agent.topicIds.includes(topic.id)))} />
    </PageHeader>
    <SourceTrustList initial={matrix} />
  </>;
}
