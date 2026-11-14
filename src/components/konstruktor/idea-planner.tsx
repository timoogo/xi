"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { IdeaPlan, PlanGroup } from "@/lib/konstruktor/idea";
import type { IdeaGroupResult } from "@/lib/konstruktor/service";

type TaskView = { state: "pending" | "running" | "done" | "failed"; result: unknown; message: string | null };
const TASKS = "/api/system-agents/konstruktor/tasks";
const MAX_INTENT = 2_000;

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init, headers: init?.body ? { "Content-Type": "application/json" } : undefined });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "Konstruktor indisponible. Réessayez.");
  return data as T;
}

function Group({ group, result }: { group: PlanGroup; result?: IdeaGroupResult }) {
  const agent = group.agent;
  const agentId = result?.agentId ?? (agent.type === "existing" ? agent.id : null);
  return <article aria-label={`ΞAgent ${agent.name}`} data-agent={agent.type} className="rounded-xl border p-4">
    <p className="text-xs font-medium uppercase text-muted-foreground">{agent.type === "new" ? "Nouveau ΞAgent" : "ΞAgent existant, réutilisé"} · {group.domain}</p>
    <h3 className="mt-1 break-words font-semibold">{agent.name} <span className="font-normal text-muted-foreground">@{agent.handle}</span></h3>
    {group.description ? <p className="text-sm">{group.description}</p> : null}
    {agent.type === "existing" && agent.note ? <p className="text-xs text-muted-foreground">{agent.note}</p> : null}
    <ul aria-label="Topics" className="mt-3 space-y-2">{group.topics.map(topic => <li key={topic.tag} data-topic={topic.existing ? (topic.attached ? "attached" : "existing") : "new"} className="text-sm">
      <span className="font-medium">{topic.name}</span> <span className="text-muted-foreground">#{topic.tag}</span>
      <span className="ml-2 rounded-full border px-2 text-xs">{topic.existing ? (topic.attached ? "déjà suivi" : "existant") : "à créer"}</span>
      <p className="text-xs text-muted-foreground">{topic.note ?? topic.scope}</p>
    </li>)}</ul>
    {group.issues.length ? <ul aria-label="Problèmes" className="mt-2 list-disc pl-5 text-sm text-destructive">{group.issues.map(issue => <li key={issue}>{issue}</li>)}</ul> : null}
    {result ? <p role="status" data-result={result.status} className={`mt-3 text-sm ${result.status === "failed" ? "text-destructive" : ""}`}>
      {result.status === "completed" ? "Créé." : result.status === "unchanged" ? "Rien à ajouter : ce ΞAgent suit déjà ces topics." : `Échec : ${result.error ?? "erreur inconnue"}`}
      {agentId && result.status !== "failed" ? <> <Link className="underline" href={`/dashboard/xiagents/${agentId}`}>Voir @{agent.handle}</Link></> : null}
    </p> : null}
  </article>;
}

/** « Créer à partir d'une idée » : intention → 5 topics grouped by ΞAgent (preview) → confirmation. */
export function IdeaPlanner() {
  const [text, setText] = useState("");
  const [requestId, setRequestId] = useState<string | null>(null);
  const [plan, setPlan] = useState<IdeaPlan | null>(null);
  const [results, setResults] = useState<IdeaGroupResult[] | null>(null);
  const [busy, setBusy] = useState<"generate" | "confirm" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  function poll(id: string) {
    timer.current = setTimeout(async () => {
      try {
        const { request } = await call<{ request: TaskView }>(`${TASKS}/${id}`);
        if (request.state === "done") { setPlan(request.result as IdeaPlan); setBusy(null); }
        else if (request.state === "failed") { setError(request.message ?? "La génération a échoué."); setBusy(null); }
        else poll(id);
      } catch (cause) { setError((cause as Error).message); setBusy(null); }
    }, 1_500);
  }

  async function generate() {
    clearTimeout(timer.current);
    const id = crypto.randomUUID();
    setBusy("generate"); setError(null); setPlan(null); setResults(null); setRequestId(id);
    try {
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const { request } = await call<{ request: TaskView }>(TASKS, { method: "POST", body: JSON.stringify({ requestId: id, task: "plan-idea", input: { text, timeZone } }) });
      if (request.state === "done") { setPlan(request.result as IdeaPlan); setBusy(null); } else poll(id);
    } catch (cause) { setError((cause as Error).message); setBusy(null); }
  }

  async function confirm() {
    if (!requestId) return;
    setBusy("confirm"); setError(null);
    try { setResults((await call<{ results: IdeaGroupResult[] }>("/api/konstruktor/ideas", { method: "POST", body: JSON.stringify({ requestId }) })).results); }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(null); }
  }

  const blocked = !!plan?.groups.some(group => group.issues.length);
  const done = !!results && results.every(result => result.status !== "failed");
  return <section aria-label="Créer à partir d’une idée" className="max-w-3xl space-y-4">
    <label className="block space-y-2">
      <span className="font-medium">Votre idée</span>
      <Textarea aria-label="Votre idée" className="max-w-none" value={text} maxLength={MAX_INTENT} disabled={!!busy} onChange={event => setText(event.target.value)}
        placeholder="Ex. : suivre la transition énergétique en Bretagne, les startups de l’hydrogène et la réglementation européenne sur les batteries." />
    </label>
    <p className="text-sm text-muted-foreground">Konstruktor propose 5 topics et les regroupe en un ou plusieurs ΞAgents, avec votre modèle local. Rien n’est créé avant votre confirmation.</p>
    <Button onClick={generate} disabled={!!busy || text.trim().length < 3}>{busy === "generate" ? "Génération… (modèle local)" : plan ? "Régénérer" : "Générer"}</Button>
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    {plan ? <div aria-label="Prévisualisation" className="space-y-3">
      <h2 className="font-semibold">{plan.groups.length > 1 ? `${plan.groups.length} ΞAgents proposés` : "1 ΞAgent proposé"}</h2>
      {plan.groups.map(group => <Group key={group.deploymentId} group={group} result={results?.find(result => result.deploymentId === group.deploymentId)} />)}
      {plan.notes.length ? <ul aria-label="Doublons écartés" className="list-disc pl-5 text-sm text-muted-foreground">{plan.notes.map(note => <li key={note}>{note}</li>)}</ul> : null}
      <p className="text-xs text-muted-foreground">Proposé par {plan.model}.</p>
      {!done ? <Button onClick={confirm} disabled={!!busy || blocked}>{busy === "confirm" ? "Création…" : results ? "Réessayer la création" : "Confirmer et créer"}</Button> : null}
    </div> : null}
  </section>;
}
