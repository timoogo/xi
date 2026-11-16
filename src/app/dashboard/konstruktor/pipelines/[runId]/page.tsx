import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { AutoRefresh, RunActions } from "@/components/konstruktor/pipeline-actions";
import { dateTime, duration, Progress, StatusBadge, statusLabel } from "@/components/konstruktor/pipeline-status";
import { getAccountStore } from "@/lib/accounts/server";
import { getCurrentUser } from "@/lib/current-user";
import { getKnowledgePipelines } from "@/lib/konstruktor/server";
import { TopicError } from "@/lib/topics/types";
export const metadata = { title: "Ξ | Run Konstruktor" };
export const dynamic = "force-dynamic";
const attemptLabel: Record<string, string> = { running: "en cours", done: "terminée", waiting: "en attente", retrying: "à réessayer", failed: "échouée", interrupted: "interrompue", lost: "bail perdu" };

/** One run of the session user: stages, publications, attempts and logs. Another user's run is a 404. */
export default async function PipelineRunPage({ params }: { params: Promise<{ runId: string }> }) {
  const user = await getCurrentUser();
  const { runId } = await params;
  const run = await getKnowledgePipelines().then(pipelines => pipelines.get(user.id, runId)).catch(error => { if (error instanceof TopicError && error.status === 404) notFound(); throw error; });
  const agent = (await (await getAccountStore()).list(user.id)).find(account => account.id === run.agent && account.owner === user.id);
  const active = run.status === "queued" || run.status === "running";
  return <><PageHeader title={`Run #${run.number}`} subtitle={run.pipeline} back={{ href: `/dashboard/konstruktor/pipelines?agent=${run.agent}`, label: "Retour aux pipelines" }} />
    <AutoRefresh active={active} />
    <div className="space-y-4 p-4 pb-24 text-sm">
      <section aria-label="Résumé" className="space-y-3 rounded-xl border p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-lg font-bold"><StatusBadge status={run.status} /><span className="text-muted-foreground">·</span>{agent?.name ?? "ΞAgent supprimé"}</h2>
          <RunActions runId={run.id} canRetry={!active && run.counts.failed > 0} canCancel={active} />
        </div>
        <Progress done={run.progress.done} total={run.progress.total} label="Progression globale" />
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 sm:grid-cols-[auto_1fr_auto_1fr]">
          <dt className="text-muted-foreground">Identifiant</dt><dd className="break-all font-mono text-xs leading-5">{run.id}</dd>
          <dt className="text-muted-foreground">Déclencheur</dt><dd>{run.trigger === "manual" ? "Manuel" : "Automatique"}</dd>
          <dt className="text-muted-foreground">Portée</dt><dd>{run.mode === "force" ? "Réanalyse complète" : "Publications manquantes"}</dd>
          <dt className="text-muted-foreground">Durée</dt><dd className="tabular-nums">{duration(run.durationMs)}</dd>
          <dt className="text-muted-foreground">Début</dt><dd>{dateTime(run.startedAt)}</dd>
          <dt className="text-muted-foreground">Fin</dt><dd>{dateTime(run.finishedAt)}</dd>
        </dl>
        <p className="text-muted-foreground">{run.counts.success} réussie(s) · {run.counts.failed} en échec · {run.counts.skipped} ignorée(s){run.counts.cancelled ? ` · ${run.counts.cancelled} annulée(s)` : ""}</p>
      </section>
      <section aria-label="Étapes"><ol className="grid gap-2 sm:grid-cols-3">
        {run.stages.map((stage, index) => <li key={stage.name} className="rounded-xl border p-3">
          <div className="flex items-center justify-between gap-2"><span className="font-semibold">{index + 1}. {stage.name}</span><StatusBadge status={stage.status} /></div>
          <p className="mt-1 text-xs text-muted-foreground">{stage.detail}</p>
        </li>)}
      </ol></section>
      <section aria-label="Publications" className="rounded-xl border">
        <h3 className="border-b p-3 font-semibold">Publications ({run.jobs.length})</h3>
        <ol className="divide-y">{run.jobs.map(job => <li key={job.publication} data-publication={job.publication} className="p-3">
          <details className="group">
            <summary className="flex cursor-pointer list-none items-start gap-3 [&::-webkit-details-marker]:hidden">
              <StatusBadge status={job.status} compact />
              <span className="min-w-0 flex-1"><span className="block truncate font-medium">{job.title}</span>
                <span className="block text-xs text-muted-foreground">{statusLabel(job.status)}{job.reason ? ` — ${job.reason}` : ""}{job.attempts.length ? ` · ${job.attempts.length} tentative(s)` : ""}</span></span>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{duration(job.startedAt === null ? null : (job.finishedAt ?? Date.now()) - job.startedAt)}</span>
            </summary>
            <div className="mt-2 space-y-2 pl-7">
              <Link href={`/dashboard/publications/${job.publication}`} className="text-xs text-primary hover:underline">Voir la publication</Link>
              {job.attempts.length ? job.attempts.map(attempt => <div key={attempt.attempt + ":" + attempt.startedAt} aria-label={`Logs de la tentative ${attempt.attempt}`} className="rounded-md bg-muted/60 p-2">
                <p className="text-xs font-medium">Tentative {attempt.attempt} · {attemptLabel[attempt.status] ?? attempt.status} · {dateTime(attempt.startedAt)} → {dateTime(attempt.finishedAt)}</p>
                <ol className="mt-1 space-y-0.5 overflow-x-auto font-mono text-xs">{attempt.logs.map((log, index) => <li key={index} className={`whitespace-pre-wrap break-words ${log.level === "error" ? "text-destructive" : log.level === "warn" ? "text-amber-700 dark:text-amber-400" : ""}`}>
                  <span className="text-muted-foreground">{new Date(log.at).toLocaleTimeString("fr-FR", { timeZone: "Europe/Paris" })}</span> {log.message}</li>)}</ol>
              </div>) : <p className="text-xs text-muted-foreground">Aucune tentative journalisée.</p>}
            </div>
          </details>
        </li>)}</ol>
      </section>
    </div>
  </>;
}
