import { notFound } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { runDuration } from "@/components/xiagents/run-history";
import { getAccountStore } from "@/lib/accounts/server";
import { getAppDatabase } from "@/lib/auth";
import { getCurrentUser } from "@/lib/current-user";
import { TopicError } from "@/lib/topics/types";
import { RUN_KIND_LABELS, RUN_STATUS_LABELS, runDetail, TRIGGER_LABELS } from "@/lib/xiagents/runs";
export const metadata = { title: "Ξ | Exécution" };
export const dynamic = "force-dynamic";
const date = (ms: number | null) => ms === null ? "—" : new Date(ms).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "medium" });
export default async function RunPage({ params }: { params: Promise<{ id: string; runId: string }> }) {
  const user = await getCurrentUser();
  const { id, runId } = await params;
  await (await getAccountStore()).getOwned(user.id, id).catch(error => { if (error instanceof TopicError && error.status === 404) notFound(); throw error; });
  const detail = runDetail(getAppDatabase(), user.id, decodeURIComponent(runId));
  if (!detail || (detail.run.agentId !== null && detail.run.agentId !== id)) notFound();
  const { run, job, candidate, claims, decisions } = detail;
  return <><PageHeader title="Exécution" back={{ href: `/dashboard/xiagents/${id}#xiagent-runs`, label: "Retour au ΞAgent" }} />
    <div className="space-y-4 p-4 pb-24 text-sm">
      <section className="rounded-xl border p-4">
        <h2 className="text-lg font-bold">{RUN_KIND_LABELS[run.kind] ?? run.kind}</h2>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          <dt className="text-muted-foreground">Déclencheur</dt><dd>{TRIGGER_LABELS[run.trigger]}</dd>
          <dt className="text-muted-foreground">Statut</dt><dd className={run.status === "failed" ? "text-destructive" : ""}>{RUN_STATUS_LABELS[run.status]}</dd>
          <dt className="text-muted-foreground">Tentative</dt><dd>{run.attempt}/{run.maxAttempts}</dd>
          <dt className="text-muted-foreground">Début</dt><dd>{date(run.startedAt)}</dd>
          <dt className="text-muted-foreground">Fin</dt><dd>{date(run.finishedAt)}</dd>
          <dt className="text-muted-foreground">Durée</dt><dd>{runDuration(run)}</dd>
          {run.error && <><dt className="text-muted-foreground">Erreur</dt><dd className="break-words text-destructive">{run.error}</dd></>}
          {job && <><dt className="text-muted-foreground">Tâche</dt><dd className="break-all">{job.key} · {job.state}{job.lastError ? ` · dernier message : ${job.lastError}` : ""}</dd></>}
        </dl>
      </section>
      <section className="rounded-xl border p-4"><h3 className="font-semibold">Journal</h3>
        <ol className="mt-2 space-y-1 font-mono text-xs">{run.logs.map((log, index) => <li key={index} className={log.level === "error" ? "text-destructive" : log.level === "warn" ? "text-amber-700 dark:text-amber-400" : ""}><span className="text-muted-foreground">{date(log.at)}</span> {log.message}</li>)}</ol>
      </section>
      {run.result !== null && <section className="rounded-xl border p-4"><h3 className="font-semibold">Résultat</h3><pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(run.result, null, 2)}</pre></section>}
      {candidate && <section className="space-y-2 rounded-xl border p-4">
        <h3 className="font-semibold">Information : {candidate.title ?? "fusionnée ou expirée"}</h3>
        <p>État actuel : {candidate.status} · étape {candidate.stage}{candidate.lane ? ` · voie ${candidate.lane}` : ""}{candidate.reason ? ` — ${candidate.reason}` : ""}</p>
        <p>Pertinence {candidate.relevance ?? "—"} · nouveauté {candidate.novelty ?? "—"} · importance {candidate.importance ?? "—"}</p>
        {candidate.sources.length > 0 && <><h4 className="font-medium">Sources examinées</h4><ul className="list-inside list-disc">{candidate.sources.map(source => <li key={source.url} className="break-all"><a className="underline" href={source.url} rel="noreferrer noopener" target="_blank">{source.publisher}</a>{source.official ? " (officielle)" : ""}</li>)}</ul></>}
        {claims.length > 0 && <><h4 className="font-medium">Affirmations vérifiées</h4><ul className="list-inside list-disc">{claims.map((claim, index) => <li key={index}>{claim.text} <span className="text-muted-foreground">[{claim.status} : {claim.reason}]</span></li>)}</ul></>}
      </section>}
      {decisions.length > 0 && <section className="rounded-xl border p-4"><h3 className="font-semibold">Décisions éditoriales</h3>
        <ul className="mt-2 space-y-1">{decisions.map((decision, index) => <li key={index}>{date(decision.at)} · {decision.outcome}{decision.lane ? ` (${decision.lane})` : ""} — {decision.reason}</li>)}</ul>
      </section>}
    </div></>;
}
