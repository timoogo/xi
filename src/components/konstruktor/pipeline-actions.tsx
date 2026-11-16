"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

async function post(url: string, data: unknown) {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error ?? "Action impossible.");
  return result;
}

/** Refreshes the server-rendered view while something is queued or running; state itself lives in SQLite. */
export function AutoRefresh({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => router.refresh(), 1500);
    return () => clearInterval(timer);
  }, [active, router]);
  return null;
}

export function PipelineLauncher({ agents, selected }: { agents: { id: string; name: string }[]; selected: string | null }) {
  const router = useRouter();
  const [agent, setAgent] = useState(selected ?? agents[0]?.id ?? "");
  const [mode, setMode] = useState<"missing" | "force">("missing");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!agents.length) return <p className="text-sm text-muted-foreground">Aucun ΞAgent : créez-en un pour analyser ses publications.</p>;
  async function launch(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(null);
    try { const { run } = await post("/api/konstruktor/pipelines", { agent, mode }); router.push(`/dashboard/konstruktor/pipelines/${run.id}`); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Lancement impossible."); setBusy(false); }
  }
  return <form onSubmit={launch} aria-label="Nouveau run" className="flex flex-wrap items-end gap-3 rounded-xl border p-3 text-sm">
    <label className="flex min-w-48 flex-1 flex-col gap-1"><span className="font-medium">ΞAgent</span>
      <select value={agent} onChange={event => setAgent(event.target.value)} className="h-9 rounded-md border bg-background px-2">
        {agents.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select>
    </label>
    <fieldset className="flex flex-col gap-1"><legend className="mb-1 font-medium">Portée</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        <label className="inline-flex items-center gap-1.5"><input type="radio" name="mode" checked={mode === "missing"} onChange={() => setMode("missing")} />Publications manquantes</label>
        <label className="inline-flex items-center gap-1.5"><input type="radio" name="mode" checked={mode === "force"} onChange={() => setMode("force")} />Réanalyse complète</label>
      </div>
    </fieldset>
    <Button type="submit" disabled={busy || !agent}>{busy ? "Lancement…" : "Lancer un run"}</Button>
    {mode === "force" && <p className="w-full text-xs text-muted-foreground">Les exclusions, corrections et décisions sur les relations sont conservées ; les concepts existants sont réutilisés.</p>}
    {error && <p role="alert" className="w-full text-destructive">{error}</p>}
  </form>;
}

export function RunActions({ runId, canRetry, canCancel }: { runId: string; canRetry: boolean; canCancel: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function act(action: "retry" | "cancel") {
    setBusy(true); setError(null);
    try { await post(`/api/konstruktor/pipelines/${runId}`, { action }); router.refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Action impossible."); }
    finally { setBusy(false); }
  }
  if (!canRetry && !canCancel) return null;
  return <div className="flex flex-wrap items-center gap-2">
    {canRetry && <Button size="sm" disabled={busy} onClick={() => void act("retry")}>Relancer les échecs</Button>}
    {canCancel && <Button size="sm" variant="outline" disabled={busy} onClick={() => void act("cancel")}>Annuler</Button>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </div>;
}
