import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { AutoRefresh, PipelineLauncher } from "@/components/konstruktor/pipeline-actions";
import { dateTime, duration, Progress, StatusBadge } from "@/components/konstruktor/pipeline-status";
import { getAccountStore } from "@/lib/accounts/server";
import { getCurrentUser } from "@/lib/current-user";
import { getKnowledgePipelines } from "@/lib/konstruktor/server";
export const metadata = { title: "Ξ | Pipelines Konstruktor" };
export const dynamic = "force-dynamic";

/** The session user's knowledge pipeline runs, newest first, filterable by one of their ΞAgents. */
export default async function PipelinesPage({ searchParams }: { searchParams: Promise<{ agent?: string }> }) {
  const user = await getCurrentUser();
  const agents = (await (await getAccountStore()).list(user.id)).filter(account => account.owner === user.id).map(({ id, name }) => ({ id, name }));
  const { agent } = await searchParams;
  const selected = agents.some(item => item.id === agent) ? agent! : null;
  const runs = (await getKnowledgePipelines()).list(user.id, { agent: selected ?? undefined });
  const names = new Map(agents.map(item => [item.id, item.name]));
  const chip = (active: boolean) => `rounded-full border px-3 py-1 text-sm ${active ? "border-primary bg-primary text-primary-foreground" : "hover:bg-accent"}`;
  return <><PageHeader title="Pipelines Konstruktor" subtitle="Réindexation des connaissances" back={{ href: "/dashboard/konstruktor", label: "Retour à Konstruktor" }} />
    <AutoRefresh active={runs.some(run => run.status === "queued" || run.status === "running")} />
    <div className="space-y-4 p-4 pb-24">
      <PipelineLauncher agents={agents} selected={selected} />
      <nav aria-label="Filtrer par ΞAgent" className="flex flex-wrap gap-2">
        <Link href="/dashboard/konstruktor/pipelines" className={chip(!selected)} aria-current={!selected ? "page" : undefined}>Tous</Link>
        {agents.map(item => <Link key={item.id} href={`/dashboard/konstruktor/pipelines?agent=${item.id}`} className={chip(selected === item.id)} aria-current={selected === item.id ? "page" : undefined}>{item.name}</Link>)}
      </nav>
      {runs.length ? <ol aria-label="Runs" className="divide-y rounded-xl border">
        {runs.map(run => <li key={run.id}>
          <Link href={`/dashboard/konstruktor/pipelines/${run.id}`} className="flex items-start gap-3 p-3 text-sm hover:bg-accent/60">
            <span className="pt-0.5"><StatusBadge status={run.status} compact /></span>
            <span className="min-w-0 flex-1 space-y-1">
              <span className="flex items-baseline gap-2"><span className="shrink-0 font-semibold tabular-nums">#{run.number}</span><span className="truncate font-semibold">{run.pipeline}</span></span>
              <span className="block text-xs text-muted-foreground">{names.get(run.agent) ?? "ΞAgent supprimé"} · {run.mode === "force" ? "réanalyse complète" : "manquantes"} · {run.trigger === "manual" ? "Manuel" : "Automatique"} · {dateTime(run.startedAt ?? run.createdAt)} · <span className="tabular-nums">{duration(run.durationMs)}</span></span>
            </span>
            <span className="w-24 shrink-0 pt-1 sm:w-40"><Progress done={run.progress.done} total={run.progress.total} label={`Progression du run #${run.number}`} /></span>
          </Link>
        </li>)}
      </ol> : <p className="rounded-xl border p-6 text-center text-sm text-muted-foreground">Aucun run{selected ? " pour ce ΞAgent" : ""}.</p>}
    </div>
  </>;
}
