import Link from "next/link";
import type { RunRecord } from "@/lib/watch/orchestrator";
import { RUN_KIND_LABELS, RUN_STATUS_LABELS, TRIGGER_LABELS } from "@/lib/xiagents/runs";

/** Execution history (distinct from deployments): real records of the orchestrator, newest first. */
const date = (ms: number) => new Date(ms).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "medium" });
export const runDuration = (run: RunRecord) => run.finishedAt === null ? "en cours" : `${Math.max(0, (run.finishedAt - run.startedAt) / 1000).toFixed(1).replace(".", ",")} s`;
export function RunHistory({ agentId, runs, retentionDays }: { agentId: string; runs: RunRecord[]; retentionDays: number }) {
  const last = runs.at(-1);
  return <section aria-labelledby="xiagent-runs" className="space-y-3 border-b p-4">
    <h3 id="xiagent-runs" className="text-lg font-bold">Historique d’exécution</h3>
    <p className="text-xs text-muted-foreground">Exécutions des tâches de veille, d’analyse et de publication, et commandes du propriétaire. Journal détaillé conservé {retentionDays} jours ; publications, sources et décisions éditoriales toujours conservées.</p>
    {!runs.length ? <p className="text-sm">Aucune exécution enregistrée.</p> : <div className="relative overflow-x-auto">
      <table className="w-full min-w-[40rem] text-left text-sm">
        <thead className="text-xs text-muted-foreground"><tr><th className="py-1 pr-2 font-medium">Début</th><th className="pr-2 font-medium">Type</th><th className="pr-2 font-medium">Déclencheur</th><th className="pr-2 font-medium">Statut</th><th className="pr-2 font-medium">Durée</th><th className="font-medium"><span className="sr-only">Détail</span></th></tr></thead>
        <tbody>{runs.map(run => <tr key={run.id} className="border-t">
          <td className="py-1.5 pr-2 whitespace-nowrap">{date(run.startedAt)}</td>
          <td className="pr-2">{RUN_KIND_LABELS[run.kind] ?? run.kind}{run.agentId === null ? " (commune)" : ""}</td>
          <td className="pr-2">{TRIGGER_LABELS[run.trigger]}</td>
          <td className={`pr-2 ${run.status === "failed" ? "text-destructive" : ""}`}>{RUN_STATUS_LABELS[run.status]}{run.maxAttempts > 1 ? ` · ${run.attempt}/${run.maxAttempts}` : ""}</td>
          <td className="pr-2 whitespace-nowrap">{runDuration(run)}</td>
          <td><Link className="underline" href={`/dashboard/xiagents/${agentId}/runs/${encodeURIComponent(run.id)}`}>Détail</Link></td>
        </tr>)}</tbody>
      </table>
    </div>}
    {runs.length === 30 && last && <Link className="text-sm underline" href={`/dashboard/xiagents/${agentId}?runsBefore=${last.startedAt}#xiagent-runs`}>Exécutions plus anciennes</Link>}
  </section>;
}
