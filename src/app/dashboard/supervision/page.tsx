import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { SupervisionFilters } from "@/components/xiagents/supervision/supervision-filters";
import { ActivityList, DayTimeline, Empty, MonthHeatmap, QueueList } from "@/components/xiagents/supervision/supervision-views";
import { getAccountStore } from "@/lib/accounts/server";
import { getAppDatabase } from "@/lib/auth";
import { getCurrentUser } from "@/lib/current-user";
import { getPublicationStore } from "@/lib/publications/server";
import { getTopicStore } from "@/lib/topics/server";
import { cn } from "@/lib/utils";
import { globalRetentionDays } from "@/lib/watch/orchestrator";
import { diffusionContext, parseSupervisionQuery, queryError, QUEUE_STATE_LABELS, QUEUE_STATES, supervision, SUPERVISION_VIEW_LABELS, SUPERVISION_VIEWS, supervisionHref, type SupervisionParams } from "@/lib/xiagents/supervision";
export const metadata = { title: "Ξ | Supervision éditoriale" };
export const dynamic = "force-dynamic";

/**
 * Global calendar and editorial supervision of the viewer's ΞAgents: rendered once on the server
 * from the URL (filters, month, day), read-only, without polling.
 */
export default async function SupervisionPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await getCurrentUser();
  const raw = await searchParams;
  const params = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value])) as SupervisionParams;
  const parsed = parseSupervisionQuery(raw);
  const accounts = await getAccountStore();
  const [agents, topics] = await Promise.all([accounts.watchAgents(), getTopicStore().then(store => store.list())]);
  const header = <PageHeader title="Supervision éditoriale" subtitle="Calendriers, queue éditoriale et exécutions de vos ΞAgents" back={{ href: "/dashboard/xiagents", label: "Retour aux ΞAgents" }} />;
  if (!parsed.success) return <>{header}<div className="space-y-3 p-4" role="alert"><p className="font-medium">{queryError(parsed.error)}</p><Link className="underline" href="/dashboard/supervision">Revenir à la vue par défaut</Link></div></>;
  const publications = await getPublicationStore();
  await publications.ensureIndexed();
  const data = supervision(getAppDatabase(), user.id, agents, parsed.data, Date.now(), diffusionContext(publications));
  const names = { agents: new Map(data.agents.map(agent => [agent.id, agent.handle])), topics: new Map(topics.map(topic => [topic.id, topic.tag])) };
  const usedTopics = [...new Set(data.agents.flatMap(agent => agent.topicIds))];
  const options = {
    agents: data.agents.map(agent => ({ value: agent.id, label: `@${agent.handle}` })),
    topics: usedTopics.map(id => ({ value: id, label: `#${names.topics.get(id) ?? "Topic indisponible"}` })),
  };
  const filtered = !!(params.agent || params.topic);
  return <>
    {header}
    <div className="space-y-4 p-4 pb-24">
      <nav aria-label="Vues de supervision" className="flex flex-wrap gap-1 border-b">
        {SUPERVISION_VIEWS.map(view => <Link key={view} href={supervisionHref({ agent: params.agent, topic: params.topic, tz: params.tz }, { view })} aria-current={data.view === view ? "page" : undefined}
          className={cn("-mb-px border-b-2 px-3 py-2 text-sm", data.view === view ? "border-foreground font-semibold" : "border-transparent text-muted-foreground hover:text-foreground")}>{SUPERVISION_VIEW_LABELS[view]}</Link>)}
      </nav>
      {!data.agents.length ? <Empty>Vous n’avez encore aucun ΞAgent. <Link className="underline" href="/dashboard/xiagents">Créer un ΞAgent</Link> pour suivre ici ses calendriers et ses publications.</Empty> : <>
        <SupervisionFilters view={data.view} params={params} agents={options.agents} topics={options.topics} period={data.view === "activity" ? { from: data.from, to: data.to } : undefined} />
        {!data.scoped.length ? <Empty>Aucun de vos ΞAgents ne correspond à ces filtres.</Empty>
          : data.view === "calendar" ? <div className="space-y-6">
            <MonthHeatmap month={data.month} days={data.days} selected={data.day.date} today={data.today} agentCount={data.scoped.length} params={params} />
            <DayTimeline day={data.day} timeZone={data.timeZone} names={names} params={params} />
          </div>
          : data.view === "queue" ? <section aria-labelledby="supervision-queue" className="space-y-3">
            <h2 id="supervision-queue" className="text-lg font-bold">Queue éditoriale</h2>
            <p className="flex flex-wrap gap-x-4 text-sm">{QUEUE_STATES.map(state => <span key={state}>{QUEUE_STATE_LABELS[state]} : <strong>{data.counts[state]}</strong></span>)}</p>
            <p className="text-xs text-muted-foreground">Vue en lecture seule : les contenus prêts sont publiés par le diffuseur central, dans les fenêtres de publication et après tous les contrôles.</p>
            {data.rows.length ? <QueueList rows={data.rows} timeZone={data.timeZone} names={names} params={params} />
              : <Empty>{data.state ? `Aucun contenu à l’état « ${QUEUE_STATE_LABELS[data.state]} »${filtered ? " pour cette sélection" : ""}.` : "La queue éditoriale est vide : aucun brouillon validé n’attend de publication."}</Empty>}
          </section>
          : <section aria-labelledby="supervision-activity" className="space-y-3">
            <h2 id="supervision-activity" className="text-lg font-bold">Exécutions et décisions</h2>
            <p className="text-xs text-muted-foreground">Du {data.from} au {data.to} (fuseau {data.timeZone}). Les journaux détaillés d’exécution sont conservés {globalRetentionDays()} jours par défaut ; les décisions de publication et d’arbitrage restent consultables.</p>
            {data.story && <p className="text-sm">Historique d’une actualité. <Link className="underline" href={supervisionHref(params, { story: undefined })}>Voir toutes les actualités</Link></p>}
            {data.items.length ? <ActivityList items={data.items} timeZone={data.timeZone} names={names} params={params} />
              : <Empty>Aucune exécution ni décision sur cette période{data.state || filtered || data.story ? " pour cette sélection" : ""}.</Empty>}
            {data.more && <Link className="inline-block text-sm underline" href={supervisionHref(params, { before: String(data.more) })}>Plus anciennes</Link>}
          </section>}
      </>}
    </div>
  </>;
}
