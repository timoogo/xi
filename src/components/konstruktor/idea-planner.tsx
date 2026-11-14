"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { duration, StatusBadge } from "@/components/konstruktor/pipeline-status";
import type { IdeaPlan, PlanGroup } from "@/lib/konstruktor/idea";
import { ideaElapsed, ideaSteps, ideaTaskLabel, type IdeaStepState, type IdeaTaskView } from "@/lib/konstruktor/idea-steps";
import type { IdeaGroupResult } from "@/lib/konstruktor/service";

const TASKS = "/api/system-agents/konstruktor/tasks";
const STEP_STATUS: Record<IdeaStepState, "queued" | "running" | "success" | "failed"> = { waiting: "queued", running: "running", done: "success", error: "failed" };
const STEP_LABEL: Record<IdeaStepState, string> = { waiting: "En attente", running: "En cours", done: "Terminée", error: "Erreur" };
/** The request followed by the page, kept in the address so that a reload resumes following it (never relaunches it). */
const PARAM = "request";
const remember = (id: string | null) => { const url = new URL(window.location.href); if (id) url.searchParams.set(PARAM, id); else url.searchParams.delete(PARAM); window.history.replaceState(window.history.state, "", url); };
const MAX_INTENT = 2_000;

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init, headers: init?.body ? { "Content-Type": "application/json" } : undefined });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "Konstruktor indisponible. Réessayez.");
  return data as T;
}

const KIND = { existing: "ΞAgent existant, réutilisé", "sub-agent": "Nouveau sous-agent", root: "Nouvel ΞAgent racine" } as const;

function Group({ group, result }: { group: PlanGroup; result?: IdeaGroupResult }) {
  const agent = group.agent;
  const agentId = result?.agentId ?? (agent.type === "existing" ? agent.id : null);
  const kind = agent.type === "existing" ? "existing" : agent.parent ? "sub-agent" : "root";
  return <article aria-label={`ΞAgent ${agent.name}`} data-agent={kind} className="rounded-xl border p-4">
    <p className="text-xs font-medium uppercase text-muted-foreground">{KIND[kind]} · {group.domain}</p>
    {agent.type === "new" && agent.parent ? <p className="text-sm">Sous-agent de <span className="font-medium">{agent.parent.name}</span> <span className="text-muted-foreground">@{agent.parent.handle}</span></p> : null}
    <h3 className="mt-1 break-words font-semibold">{agent.name} <span className="font-normal text-muted-foreground">@{agent.handle}</span></h3>
    {agent.type === "new" && agent.about ? <p className="text-sm"><span className="text-muted-foreground">Mission : </span>{agent.about}</p> : group.description ? <p className="text-sm">{group.description}</p> : null}
    {agent.note ? <p className="text-xs text-muted-foreground">{agent.note}</p> : null}
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

function Pipeline({ view, now }: { view: IdeaTaskView; now: number }) {
  return <section aria-label="Pipeline de génération" className="space-y-2 rounded-xl border p-4">
    <p className="flex flex-wrap items-center gap-x-3 text-sm"><span role="status" data-state={view.state} className="font-medium">{ideaTaskLabel(view, now)}</span><span className="tabular-nums text-muted-foreground">Temps écoulé : {duration(ideaElapsed(view, now))}</span></p>
    <ol className="space-y-1">{ideaSteps(view).map((step, index) => <li key={step.key} data-step={step.key} data-state={step.state} className="flex items-center gap-2 text-sm">
      <StatusBadge status={STEP_STATUS[step.state]} compact /><span>{index + 1}. {step.label}</span><span className="text-xs text-muted-foreground">{STEP_LABEL[step.state]}</span>
    </li>)}</ol>
  </section>;
}

/** « Créer à partir d'une idée » : intention → the topics it needs, grouped by ΞAgent (preview) → confirmation. */
export function IdeaPlanner() {
  const [text, setText] = useState("");
  const [requestId, setRequestId] = useState<string | null>(null);
  const [view, setView] = useState<IdeaTaskView | null>(null);
  const [results, setResults] = useState<IdeaGroupResult[] | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const running = !!view && (view.state === "pending" || view.state === "running");
  const plan = view?.state === "done" ? view.result as IdeaPlan : null;

  function follow(id: string) {
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try {
        const { request } = await call<{ request: IdeaTaskView }>(`${TASKS}/${id}`);
        setView(request);
        if (request.state === "pending" || request.state === "running") follow(id);
      } catch (cause) { setError((cause as Error).message); }
    }, 2_000);
  }
  // After a reload: the request in the address is read back and followed, never sent again.
  useEffect(() => {
    const id = new URL(window.location.href).searchParams.get(PARAM);
    if (!id) return;
    setRequestId(id);
    call<{ request: IdeaTaskView & { task: string; input?: unknown } }>(`${TASKS}/${id}`).then(({ request }) => {
      setView(request);
      if (request.state === "pending" || request.state === "running") follow(id);
    }, cause => { setError((cause as Error).message); remember(null); setRequestId(null); });
    return () => clearTimeout(timer.current);
    // Once, on load: the address names the request to follow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!running) return;
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(tick);
  }, [running]);
  useEffect(() => { if (plan?.intent) setText(current => current || plan.intent); }, [plan?.intent]);

  async function generate() {
    const id = crypto.randomUUID();
    setError(null); setResults(null); setRequestId(id); setNow(Date.now());
    try {
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const { request } = await call<{ request: IdeaTaskView }>(TASKS, { method: "POST", body: JSON.stringify({ requestId: id, task: "plan-idea", input: { text, timeZone } }) });
      remember(id);
      setView(request);
      if (request.state === "pending" || request.state === "running") follow(id);
    } catch (cause) { setError((cause as Error).message); setRequestId(null); }
  }

  async function confirm() {
    if (!requestId) return;
    setConfirming(true); setError(null);
    try { setResults((await call<{ results: IdeaGroupResult[] }>("/api/konstruktor/ideas", { method: "POST", body: JSON.stringify({ requestId }) })).results); }
    catch (cause) { setError((cause as Error).message); }
    finally { setConfirming(false); }
  }

  const blocked = !!plan?.groups.some(group => group.issues.length);
  const done = !!results && results.every(result => result.status !== "failed");
  return <section aria-label="Créer à partir d’une idée" className="max-w-3xl space-y-4">
    <label className="block space-y-2">
      <span className="font-medium">Votre idée</span>
      <Textarea aria-label="Votre idée" className="max-w-none" value={text} maxLength={MAX_INTENT} disabled={running || confirming} onChange={event => setText(event.target.value)}
        placeholder="Ex. : suivre la transition énergétique en Bretagne, les startups de l’hydrogène et la réglementation européenne sur les batteries." />
    </label>
    <p className="text-sm text-muted-foreground">Konstruktor propose les topics utiles à votre idée et les range parmi vos ΞAgents : rattachés à un ΞAgent existant dont la mission les couvre, confiés à un nouveau sous-agent spécialisé, ou à un nouvel ΞAgent au nom inventé, avec votre modèle local (plusieurs minutes sur un petit modèle). Rien n’est créé avant votre confirmation.</p>
    <Button onClick={generate} disabled={running || confirming || text.trim().length < 3}>{running ? "Génération en cours…" : plan ? "Régénérer" : "Générer"}</Button>
    {view ? <Pipeline view={view} now={now} /> : null}
    {view?.state === "failed" ? <p role="alert" className="text-sm text-destructive">{view.message ?? "La génération a échoué. Rien n’a été créé."}</p> : null}
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    {plan ? <div aria-label="Prévisualisation" className="space-y-3">
      <h2 className="font-semibold">{(count => `${count} topic${count > 1 ? "s" : ""}`)(plan.groups.reduce((sum, group) => sum + group.topics.length, 0))}, {plan.groups.length > 1 ? `${plan.groups.length} ΞAgents` : "1 ΞAgent"}</h2>
      {plan.groups.map(group => <Group key={group.deploymentId} group={group} result={results?.find(result => result.deploymentId === group.deploymentId)} />)}
      {plan.notes.length ? <ul aria-label="Remarques" className="list-disc pl-5 text-sm text-muted-foreground">{plan.notes.map(note => <li key={note}>{note}</li>)}</ul> : null}
      <p className="text-xs text-muted-foreground">Proposé par {plan.model}.</p>
      {!done ? <Button onClick={confirm} disabled={confirming || blocked}>{confirming ? "Création…" : results ? "Réessayer la création" : "Confirmer et créer"}</Button> : null}
    </div> : null}
  </section>;
}
