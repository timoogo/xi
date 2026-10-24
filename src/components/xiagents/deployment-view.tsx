"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { Deployment, StepStatus } from "@/lib/xiagents/deployments";
import { cn } from "@/lib/utils";

/**
 * Live view of a deployment: every step, status and log line comes from the stored record,
 * re-read while it runs. Opening the page runs (or resumes) an unfinished deployment; the
 * server lock guarantees one execution at a time, so several tabs never duplicate anything.
 */
const STATUS: Record<StepStatus, { label: string; mark: string; className: string }> = {
  pending: { label: "En attente", mark: "○", className: "text-muted-foreground" },
  running: { label: "En cours", mark: "◐", className: "text-foreground" },
  completed: { label: "Terminé", mark: "✓", className: "text-emerald-700 dark:text-emerald-400" },
  failed: { label: "Échec", mark: "✕", className: "text-destructive" },
};
const STATE_LABEL: Record<Deployment["state"], string> = { pending: "En attente", running: "En cours", completed: "Déployé", failed: "Échec" };
const time = (value: string | null) => value ? new Date(value).toLocaleTimeString("fr-FR") : "";
const duration = (from: string | null, to: string | null) => from && to ? `${((Date.parse(to) - Date.parse(from)) / 1000).toFixed(1).replace(".", ",")} s` : "";

export function DeploymentView({ initial }: { initial: Deployment }) {
  const [deployment, setDeployment] = useState(initial);
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);
  const started = useRef(false);
  const id = initial.id;

  async function run() {
    setRunning(true); setError("");
    try {
      for (let attempt = 0; attempt < 30; attempt++) {
        const response = await fetch(`/api/xiagents/deployments/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "run" }) });
        const result = await response.json().catch(() => ({}));
        if (response.ok) { setDeployment(result.deployment); return; }
        // Another tab or request holds the deployment: keep watching, then try again.
        if (response.status !== 409) throw new Error(result.error ?? "Déploiement impossible.");
        await new Promise(resolve => setTimeout(resolve, 2_000));
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Déploiement impossible."); }
    finally { setRunning(false); }
  }
  useEffect(() => {
    if (started.current || !["pending", "running"].includes(initial.state)) return;
    started.current = true;
    void run();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const live = running || deployment.state === "running";
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => {
      void fetch(`/api/xiagents/deployments/${id}`, { cache: "no-store" }).then(response => response.ok ? response.json() : null)
        .then(result => { if (result?.deployment) setDeployment(current => current.updatedAt > result.deployment.updatedAt ? current : result.deployment); }).catch(() => {});
    }, 1_000);
    return () => clearInterval(timer);
  }, [live, id]);

  const agent = deployment.spec.agent;
  const done = deployment.steps.filter(step => step.status === "completed").length;
  return <div className="space-y-4 p-4 pb-24">
    <section className="space-y-1 rounded-xl border p-4">
      <p className="text-sm text-muted-foreground">{deployment.target === "agent" ? "Déploiement d’un ΞAgent" : "Création d’un topic"} · créé le {new Date(deployment.createdAt).toLocaleString("fr-FR")} · tentative {deployment.attempts || 1}</p>
      <h2 className="text-xl font-bold">{agent ? `${agent.name} @${agent.handle}` : deployment.spec.newTopics[0]?.draft.name}</h2>
      <p aria-live="polite" className={cn("font-medium", deployment.state === "failed" && "text-destructive")}>{STATE_LABEL[deployment.state]} — {done}/{deployment.steps.length} étapes terminées</p>
      <div className="flex flex-wrap gap-3 pt-2">
        {deployment.state === "completed" && deployment.ids.agentId && <Link className="underline" href={`/dashboard/xiagents/${deployment.ids.agentId}`}>Ouvrir la page du ΞAgent</Link>}
        {deployment.state === "completed" && !agent && <Link className="underline" href="/dashboard/topics">Voir les topics</Link>}
        {deployment.state === "failed" && <Button disabled={running} onClick={() => void run()}>{running ? "Reprise…" : "Reprendre le déploiement"}</Button>}
        <Link className="text-sm underline" href="/dashboard/xiagents/deployments">Historique des déploiements</Link>
      </div>
      <p role="alert" className="text-sm text-destructive">{error}</p>
    </section>
    <ol className="space-y-2">
      {deployment.steps.map(step => {
        const status = STATUS[step.status];
        return <li key={step.key} className="rounded-xl border">
          <details open={step.status === "running" || step.status === "failed"}>
            <summary className="flex cursor-pointer flex-wrap items-center gap-2 p-3">
              <span aria-hidden className={cn("w-4 text-center", status.className, step.status === "running" && "motion-safe:animate-pulse")}>{status.mark}</span>
              <span className="font-medium">{step.name}</span>
              <span className={cn("text-sm", status.className)}>{status.label}</span>
              <span className="ml-auto text-xs text-muted-foreground">{duration(step.startedAt, step.finishedAt)}</span>
            </summary>
            <div className="border-t p-3">
              {step.error && <p className="mb-2 text-sm text-destructive">{step.error}</p>}
              {step.logs.length ? <ol className="space-y-1 font-mono text-xs">
                {step.logs.map((log, index) => <li key={index} className={cn(log.level === "error" && "text-destructive", log.level === "warn" && "text-amber-700 dark:text-amber-400")}>
                  <span className="text-muted-foreground">{time(log.at)}</span> {log.level === "warn" ? "⚠ " : log.level === "error" ? "✕ " : ""}{log.message}
                </li>)}
              </ol> : <p className="text-xs text-muted-foreground">Pas encore exécutée.</p>}
            </div>
          </details>
        </li>;
      })}
    </ol>
  </div>;
}
