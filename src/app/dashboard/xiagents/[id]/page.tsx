import Link from "next/link";
import { Bot, Bug, Palette, Rss, Settings2 } from "lucide-react";
import { notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/current-user";
import { getAccountStore } from "@/lib/accounts/server";
import { getTopicStore } from "@/lib/topics/server";
import { TopicError } from "@/lib/topics/types";
import { KonstruktorPanel } from "@/components/konstruktor/konstruktor-panel";
import { PageHeader } from "@/components/page-header";
import { UserAvatar } from "@/components/user-avatar";
import { AvatarPanel } from "@/components/xiagents/avatar-panel";
import { ManualGenerator } from "@/components/xiagents/manual-generator";
import { PublicationGenerator } from "@/components/xiagents/publication-generator";
import { draftableCandidates } from "@/lib/xiagents/publication-generator";
import { PublicationFeed } from "@/components/publications/publication-feed";
import { WatchPanel } from "@/components/xiagents/watch-panel";
import { AgentLLMPanel } from "@/components/llm/agent-llm-panel";
import { toChoice } from "@/components/llm/format";
import { getLLMRuntime } from "@/lib/llm/server";
import { AgentControl } from "@/components/xiagents/agent-control";
import { RunHistory } from "@/components/xiagents/run-history";
import { AgentActivity, AgentAttention, AgentStatus } from "@/components/xiagents/agent-overview";
import { DashboardSection } from "@/components/xiagents/dashboard-section";
import { agentMode } from "@/components/xiagents/labels";
import { agentActivity, agentAttention } from "@/lib/xiagents/attention";
import { globalRetentionDays } from "@/lib/watch/orchestrator";
import { agentRuns } from "@/lib/xiagents/runs";
import { agentSchedule, nextPublishOpening, nextWatchOpening, publishOpen, watchOpen } from "@/lib/xiagents/schedule";
import { getFeedAuthors, getPublicationStore } from "@/lib/publications/server";
import { getAppDatabase } from "@/lib/auth";
import { watchDiagnostics } from "@/lib/watch/diagnostics";
import { autoPublishEnabled, getWatchServices, inferenceStatus, publicPublishingEnabled } from "@/lib/watch/server";
export const metadata = { title: "Ξ | Gestion du ΞAgent" };
export default async function XiAgentPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ cursor?: string; runsBefore?: string }> }) {
  const user = await getCurrentUser();
  const { id } = await params;
  const accounts = await getAccountStore();
  const account = await accounts.getOwned(user.id, id).catch(error => { if (error instanceof TopicError && error.status === 404) notFound(); throw error; });
  const topics = await (await getTopicStore()).list();
  const topicIds = account.editorial ? [account.editorial.primaryTopicId, ...account.editorial.secondaryTopicIds] : [];
  const { cursor, runsBefore } = await searchParams;
  const [avatar, author] = await Promise.all([accounts.avatar(user.id, id), getFeedAuthors(user, [id]).then(authors => authors.get(id))]);
  const current = author?.bloub ?? { config: avatar.config, activity: "unavailable" as const };
  // What the agent's runs will use (resolved now, no inference: the test is an explicit action).
  const llm = await getLLMRuntime();
  const [llmSettings, llmInstances, llmGlobal] = await Promise.all([accounts.llm(user.id, id), llm.store.list(user.id), llm.store.settings(user.id)]);
  const llmView = { settings: llmSettings, resolution: await llm.resolve(user.id, llmSettings) };
  const watch = await watchDiagnostics({ db: getAppDatabase(), accounts, sources: (await getWatchServices()).sources, publications: await getPublicationStore(), owner: user.id, agentId: id, autoPublish: autoPublishEnabled(), allowPublic: publicPublishingEnabled(), inference: inferenceStatus(), llm: llmView.resolution });
  const agent = (await accounts.watchAgents()).find(item => item.id === id && item.owner === user.id);
  const now = Date.now();
  const iso = (value: number | null) => value === null ? null : new Date(value).toISOString();
  const runs = agentRuns(getAppDatabase(), user.id, id, Number(runsBefore) || undefined);
  const when = (value: string | null) => value ? new Date(value).toLocaleString("fr-FR", { timeZone: "Europe/Paris", dateStyle: "medium", timeStyle: "short" }) : "aucune";
  const control = agent?.schedule ? { enabled: agent.watch.valid && agent.watch.policy.enabled, paused: agent.watch.policy.paused, active: agent.active, pause: agent.pause ?? null,
    status: { watchOpen: watchOpen(agent, now), publishOpen: publishOpen(agent, now), nextWatch: iso(nextWatchOpening(agent, now)), nextPublish: iso(nextPublishOpening(agent, now)) } } : null;
  const mode = control && agentMode(control, when);
  const status = control && {
    mode: mode!, tone: control.active && control.enabled ? control.paused ? "paused" as const : "ok" as const : "off" as const,
    windows: control.enabled && !control.paused ? `Veille ${control.status.watchOpen ? "ouverte" : `fermée · prochaine ouverture : ${when(control.status.nextWatch)}`} · publication ${control.status.publishOpen ? "ouverte" : `fermée · prochaine : ${when(control.status.nextPublish)}`}` : null,
    control: control.enabled ? { label: control.paused ? "Reprendre…" : "Mettre en pause…" } : null,
  };
  return <>
    <PageHeader title={account.name} subtitle={`@${account.handle}`} back={{ href: "/dashboard/xiagents", label: "Retour aux ΞAgents" }} />
    <section aria-label="Identité du ΞAgent" className="space-y-3 border-b p-4">
      <div className="flex items-center gap-3"><UserAvatar name={account.name} bloub={current} size={64} /><div className="min-w-0"><h1 className="break-words text-xl font-bold">{account.name}</h1><p className="break-all text-muted-foreground">@{account.handle}</p></div></div>
      <p className="whitespace-pre-wrap break-words">{account.description}</p>
      <p className="text-sm"><span className="sr-only">Topics : </span>{topicIds.length ? topicIds.map(id => <span key={id} className="mr-2 text-muted-foreground">#{topics.find(topic => topic.id === id)?.tag ?? "Topic indisponible"}</span>) : <span className="text-muted-foreground">Aucun topic associé</span>}</p>
      <div className="flex flex-wrap gap-4 text-sm">
        <Link href={`/dashboard/profiles/${id}`} className="underline">Voir le profil</Link>
        <a href={`/api/xiagents/${id}/export`} download className="underline">Exporter la configuration (YAML)</a>
        <Link href={`/dashboard/xiagents?duplicate=${id}`} className="underline">Dupliquer (sans historique)</Link>
      </div>
    </section>
    <KonstruktorPanel target={{ type: "agent", id: account.id }} intro={`Faites évoluer @${account.handle} : description, périmètre, charte ou topics.`} />
    <AgentStatus status={status} />
    <AgentAttention attention={agentAttention(watch)} />
    <AgentActivity items={agentActivity(watch)} lastFetch={watch.fetchLog[0] ?? null} nextWindow={watch.nextWindow} />

    <DashboardSection id="xiagent-control" title="Pilotage" icon={<Settings2 />}>
      {agent?.schedule && control ? <AgentControl agentId={id} enabled={control.enabled} paused={control.paused} active={control.active} pause={control.pause}
        schedule={agent.schedule} profile={agent.profile ?? null} candidates={watch.candidates.map(item => ({ storyId: item.storyId, title: item.title, status: item.status }))} status={control.status} />
        : <p className="p-4 text-sm">Complétez la configuration éditoriale de ce ΞAgent pour le piloter.</p>}
    </DashboardSection>
    <DashboardSection id="xiagent-llm" title="Intelligence artificielle" icon={<Bot />}>
      <AgentLLMPanel agentId={id} initial={llmView} instances={llmInstances.map(toChoice)} defaultInstanceId={llmGlobal.defaultInstanceId} environment={llm.environment()} />
    </DashboardSection>
    <DashboardSection id="xiagent-watch" title="Veille autonome" icon={<Rss />}>
      <WatchPanel agentId={id} data={watch} topics={topics.map(topic => ({ id: topic.id, tag: topic.tag, name: topic.name }))} agentTopicIds={topicIds} />
    </DashboardSection>
    <DashboardSection id="xiagent-avatar" title="Avatar" icon={<Palette />}>
      <AvatarPanel agentId={id} name={account.name} initial={avatar} current={current} />
    </DashboardSection>
    <DashboardSection id="xiagent-debug" title="Historique et outils de debug" icon={<Bug />}>
      <RunHistory agentId={id} runs={runs} retentionDays={agent ? agentSchedule(agent).retentionDays ?? globalRetentionDays() : globalRetentionDays()} />
      {account.editorial?.active ? <PublicationGenerator agentId={id} candidates={draftableCandidates(getAppDatabase(), id)} drafts={watch.drafts} llm={llmView.resolution} />
        : <p className="border-b p-4">Complétez et activez ce ΞAgent depuis la liste pour générer des publications.</p>}
      {account.editorial?.active && <details className="border-b">
        <summary className="cursor-pointer p-4 font-semibold">Outils de test et de développement</summary>
        <ManualGenerator agentId={id} revision={account.editorial.revision} />
      </details>}
    </DashboardSection>

    <h2 className="border-b p-4 text-lg font-bold">Historique des publications</h2>
    <PublicationFeed showPublicationLinks viewer={user} scope={{ kind: "author", authorId: id }} cursor={typeof cursor === "string" ? cursor : undefined} path={`/dashboard/xiagents/${id}`} label="Publications du ΞAgent" empty={{ title: "Aucune publication", description: "Générez une publication, relisez son brouillon, puis confirmez sa publication." }} />
  </>;
}
