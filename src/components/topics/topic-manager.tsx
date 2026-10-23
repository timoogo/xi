"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { Draft, Run, Topic } from "@/lib/topics/types";

async function api<T>(path: string, payload?: unknown, method = "POST"): Promise<T> {
  const response = await fetch(`/api/topics${path}`, { cache: "no-store", ...(payload === undefined ? {} : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? "Opération impossible.");
  return value;
}
const states = { pending: "En attente", running: "En cours", waiting: "À confirmer", completed: "Terminé", failed: "Échec", cancelled: "Annulé" };
const selectClass = "w-full rounded-md border bg-background p-2 text-sm";
function DraftFields({ draft, onChange, topics, exclude }: { draft: Draft; onChange: (draft: Draft) => void; topics: Topic[]; exclude?: string }) {
  const tagHelp = useId();
  const set = (key: keyof Draft, value: Draft[keyof Draft]) => onChange({ ...draft, [key]: value });
  return <div className="space-y-4">
    <label className="block space-y-1"><span>Nom public</span><Input required maxLength={160} value={draft.name} onChange={e => set("name", e.target.value)} /></label>
    <label className="block space-y-1"><span>Tag hiérarchique</span><Input required aria-describedby={tagHelp} maxLength={180} value={draft.tag} onChange={e => set("tag", e.target.value)} /></label><p id={tagHelp} className="text-xs text-muted-foreground">Minuscules, points et tirets. Exemple : politiks.france</p>
    <label className="block space-y-1"><span id={`${tagHelp}-parent`}>Parent principal</span><select aria-labelledby={`${tagHelp}-parent`} className={selectClass} value={draft.parentId ?? ""} onChange={e => {
      const parent = topics.find(t => t.id === e.target.value);
      onChange({ ...draft, parentId: parent?.id ?? null, tag: `${parent ? parent.tag + "." : ""}${draft.tag.split(".").at(-1)}` });
    }}><option value="">Aucun (racine)</option>{topics.filter(t => t.id !== exclude).map(t => <option key={t.id} value={t.id}>{t.tag}</option>)}</select></label>
    <label className="block space-y-1"><span id={`${tagHelp}-scope`}>Scope public — périmètre spécialisé</span><Textarea aria-labelledby={`${tagHelp}-scope`} required maxLength={4000} value={draft.scope} onChange={e => set("scope", e.target.value)} /></label>
    <label className="block space-y-1"><span id={`${tagHelp}-description`}>Description publique</span><Textarea aria-labelledby={`${tagHelp}-description`} maxLength={4000} value={draft.description} onChange={e => set("description", e.target.value)} /></label>
    <fieldset className="space-y-2 rounded-md border p-3"><legend>Relations transversales à valider</legend><p className="text-xs text-muted-foreground">Indépendantes du parent. Aucun lien n’est accepté implicitement.</p>
      <div className="max-h-40 overflow-y-auto">{topics.filter(t => t.id !== exclude).map(t => <label key={t.id} className="flex items-center gap-2 py-1"><input type="checkbox" checked={draft.relatedIds.includes(t.id)} onChange={e => set("relatedIds", e.target.checked ? [...draft.relatedIds, t.id] : draft.relatedIds.filter(id => id !== t.id))} />{t.tag}</label>)}{topics.length === 0 && <p>Aucun topic disponible.</p>}</div>
    </fieldset>
  </div>;
}
export function TopicManager({ owner }: { owner: string }) {
  const [topics, setTopics] = useState<Topic[]>([]);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [intent, setIntent] = useState("");
  const [run, setRun] = useState<Run | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [edit, setEdit] = useState<Draft | null>(null);
  const [validated, setValidated] = useState(false);
  const [editValidated, setEditValidated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [connection, setConnection] = useState("");
  const [requestText, setRequestText] = useState("");
  const [routing, setRouting] = useState<{ primaryId: string | null; secondaryIds: string[]; explanation: string } | null>(null);
  const cursor = useRef("");
  const load = useCallback(async () => setTopics((await api<{ topics: Topic[] }>("")).topics), []);
  const show = (id: string) => { setSelected(id); setEdit(null); const url = new URL(window.location.href); url.searchParams.set("topic", id); window.history.replaceState(null, "", url); };
  useEffect(() => {
    if (selected) document.getElementById("topic-detail")?.focus();
  }, [selected]);
  useEffect(() => {
    void load().catch(e => setError(e.message));
    const params = new URLSearchParams(window.location.search);
    setSelected(params.get("topic"));
    const runId = params.get("run");
    if (runId) void api<{ run: Run }>(`/runs/${runId}`).then(({ run }) => { setRun(run); setDraft(run.draft); }).catch(e => setError(e.message));
  }, [load]);
  useEffect(() => {
    if (!run || ["completed", "cancelled"].includes(run.state)) return;
    const source = new EventSource(`/api/topics/runs/${run.id}/events`);
    source.onopen = () => setConnection("Synchronisé");
    source.onerror = () => setConnection("Reconnexion automatique…");
    const receive = (event: MessageEvent) => {
      if (event.lastEventId === cursor.current) return;
      cursor.current = event.lastEventId;
      const current = JSON.parse(event.data) as Run;
      setRun(previous => {
        if (previous?.id === current.id && (previous.events.length > current.events.length || ["completed", "cancelled"].includes(previous.state))) return previous;
        return current;
      });
      if (current.state === "completed") void load().catch(e => setError(e.message));
    };
    source.addEventListener("pipeline", receive);
    return () => source.close();
  }, [run?.id, run?.state, load]); // eslint-disable-line react-hooks/exhaustive-deps
  async function perform(task: () => Promise<void>) {
    setError(""); setBusy(true);
    try { await task(); } catch (e) { setError(e instanceof Error ? e.message : "Opération impossible."); } finally { setBusy(false); }
  }
  async function action(action: "confirm" | "resume" | "cancel" | "parent") {
    if (!run) return;
    await perform(async () => {
      const result = await api<{ run: Run }>(`/runs/${run.id}`, { action, ...(action === "confirm" ? { draft, relationsConfirmed: validated } : {}) });
      setRun(result.run); if (!result.run.confirmed) setDraft(result.run.draft); setValidated(false);
      const url = new URL(window.location.href); url.searchParams.set("run", result.run.id); window.history.replaceState(null, "", url); await load();
    });
  }
  const topic = topics.find(t => t.id === selected);
  const visible = topics.filter(t => `${t.tag} ${t.name} ${t.scope} ${t.aliases.join(" ")}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const label = (id: string) => topics.find(t => t.id === id)?.tag ?? id;
  return <div className="space-y-8 p-4 pb-24">
    {error && <p role="alert" className="rounded-md border border-destructive p-3 text-destructive">{error}</p>}
    <section aria-labelledby="topics-list"><h2 id="topics-list" className="mb-3 text-lg font-bold">Explorer la hiérarchie</h2>
      <label className="block"><span className="sr-only">Rechercher les topics</span><Input placeholder="Rechercher un tag, nom ou scope…" value={search} onChange={e => setSearch(e.target.value)} /></label>
      <ul className="my-3 max-h-72 overflow-auto rounded-lg border">{visible.map(t => <li key={t.id}><button className="block w-full p-3 text-left hover:bg-accent focus-visible:outline focus-visible:outline-2" style={{ paddingLeft: `${12 + t.tag.split(".").length * 12}px` }} aria-pressed={t.id === selected} onClick={() => show(t.id)}><span className="block font-medium">{t.tag}</span><span className="text-xs text-muted-foreground">{t.name} · {t.parentId ? `enfant de ${label(t.parentId)}` : "racine"}</span></button></li>)}</ul>
      {!visible.length && <p className="text-sm text-muted-foreground">Aucun topic trouvé.</p>}
    </section>
    {topic && <section aria-labelledby="topic-detail" className="space-y-3 rounded-xl border p-4"><h2 id="topic-detail" tabIndex={-1} className="text-lg font-bold">{topic.name} <span className="text-sm font-normal">{topic.tag}</span></h2>
      <p className="whitespace-pre-wrap">{topic.description}</p><p className="whitespace-pre-wrap"><strong>Scope :</strong> {topic.scope}</p>
      <p className="text-sm">Parent : {topic.parentId ? <button className="underline" onClick={() => show(topic.parentId!)}>{label(topic.parentId)}</button> : "aucun"}</p>
      <div className="text-sm">Enfants : {topics.filter(t => t.parentId === topic.id).map(t => <button key={t.id} className="mr-2 underline" onClick={() => show(t.id)}>{t.tag}</button>)}</div>
      <div className="text-sm">Relations : {topic.relatedIds.map(id => <button key={id} className="mr-2 underline" onClick={() => show(id)}>{label(id)}</button>)}</div>
      {topic.aliases.length > 0 && <p className="text-sm">Anciens tags : {topic.aliases.join(", ")}</p>}
      <p className="break-all text-xs text-muted-foreground">UUID : {topic.id}<br />Créé le {new Date(topic.createdAt).toLocaleString("fr-FR")} · Modifié le {new Date(topic.updatedAt).toLocaleString("fr-FR")}</p>
      {topic.createdBy === owner && !edit && <Button variant="outline" onClick={() => { setEdit(topic); setEditValidated(false); }}>Modifier</Button>}
      {edit && <form className="space-y-4" onSubmit={e => { e.preventDefault(); void perform(async () => {
        await api("", { id: topic.id, revision: topic.revision, draft: edit, relationsConfirmed: editValidated }, "PATCH"); setEdit(null); await load();
      }); }}><DraftFields draft={edit} topics={topics} exclude={topic.id} onChange={d => { setEdit(d); setEditValidated(false); }} /><label className="flex gap-2"><input type="checkbox" checked={editValidated} onChange={e => setEditValidated(e.target.checked)} />Je valide le périmètre et les relations sélectionnées.</label><p className="text-xs text-muted-foreground">Un renommage actualise les tags descendants et conserve les anciens tags.</p><div className="flex gap-2"><Button disabled={busy || !editValidated}>Enregistrer</Button><Button type="button" variant="outline" onClick={() => setEdit(null)}>Annuler</Button></div></form>}
    </section>}
    <section aria-labelledby="topic-create" className="space-y-4"><h2 id="topic-create" className="text-lg font-bold">Proposer un topic</h2><p className="text-sm text-muted-foreground">Analyse déterministe, sans IA ni recherche documentaire. Votre intention reste privée. Aucun ΞAgent ni publication ne sera créé.</p>
      <form className="space-y-3" onSubmit={e => { e.preventDefault(); void perform(async () => {
        const { run } = await api<{ run: Run }>("/runs", { intent }); setRun(run); setDraft(run.draft); setValidated(false); cursor.current = "";
        const url = new URL(window.location.href); url.searchParams.set("run", run.id); window.history.replaceState(null, "", url);
        const analyzed = await api<{ run: Run }>(`/runs/${run.id}`, { action: "resume" });
        setRun(analyzed.run); setDraft(analyzed.run.draft);
      }); }}><label className="block space-y-1"><span id="topic-intent-label">Intention privée</span><Textarea aria-labelledby="topic-intent-label" required minLength={3} maxLength={2000} value={intent} onChange={e => setIntent(e.target.value)} placeholder="La politique française, les élections…" /></label><Button disabled={busy}>Analyser et proposer</Button></form>
    </section>
    {run && <section aria-labelledby="pipeline" className="space-y-4 rounded-xl border p-4"><h2 id="pipeline" className="font-bold">Pipeline de création</h2><p role="status" aria-live="polite" aria-atomic="true">{states[run.state]}{run.state === "running" ? ` · ${run.steps.find(s => s.status === "running")?.name ?? "Traitement"}` : ""}</p><p className="text-xs text-muted-foreground">{connection}</p>
      <ol className="space-y-2">{run.steps.map((step, i) => <li key={step.name}><details className="rounded-lg border p-2"><summary className="cursor-pointer text-sm"><span className={step.status === "failed" ? "text-destructive" : ""}>{i + 1}. {step.name} — {states[step.status]}</span>{step.finishedAt && step.startedAt && <span className="ml-2 text-xs text-muted-foreground">{step.finishedAt - step.startedAt} ms</span>}</summary><div className="mt-2 space-y-1 text-xs">{run.events.filter(event => event.step === i).map(event => <p key={event.id}>{new Date(event.at).toLocaleTimeString("fr-FR")} · {states[event.status]}{event.error ? ` — ${event.error}` : ""}</p>)}{step.result !== undefined && <pre className="overflow-auto whitespace-pre-wrap break-words">{JSON.stringify(step.result, null, 2)}</pre>}{step.error && <p className="text-destructive">{step.error}</p>}</div></details></li>)}</ol>
      {run.state === "waiting" && !!run.missingParents?.length && <div className="space-y-3 rounded-lg border p-3">
        <h3 className="font-semibold">Parent manquant à confirmer</h3>
        <p>Sujet demandé : {run.subject} · {run.draft.tag}</p><p>Scope proposé : {run.draft.scope}</p>
        <p>Le parent {run.missingParents.at(-1)!.tag} est nécessaire pour respecter la hiérarchie. Chaque parent sera proposé et confirmé séparément avant de revenir à ce topic.</p>
        <p>{run.missingParents.at(-1)!.name} : {run.missingParents.at(-1)!.scope}</p>
        <Button disabled={busy} onClick={() => void action("parent")}>Proposer le parent manquant</Button>
        <Button variant="outline" disabled={busy} onClick={() => void action("resume")}>Rechercher à nouveau le parent</Button>
      </div>}
      {run.existingTopicId && <p>Ce topic existe déjà. <button className="underline" onClick={() => show(run.existingTopicId!)}>Ouvrir le topic existant</button> Son scope et ses relations sont conservés.</p>}
      {run.returnRunId && (run.state === "completed" || run.existingTopicId) && <Button disabled={busy} onClick={() => void perform(async () => {
        const result = await api<{ run: Run }>(`/runs/${run.returnRunId}`, { action: "resume" });
        setRun(result.run); setDraft(result.run.draft); setValidated(false); cursor.current = "";
        const url = new URL(window.location.href); url.searchParams.set("run", result.run.id); window.history.replaceState(null, "", url); await load();
      })}>Continuer vers le topic demandé</Button>}
      {run.state === "waiting" && !run.missingParents?.length && draft && <form className="space-y-4" onSubmit={e => { e.preventDefault(); void action("confirm"); }}>
        <div><h3 className="font-semibold">Topics proches / doublons possibles</h3>{run.matches.length ? run.matches.map(id => <button type="button" key={id} className="mr-3 underline" onClick={() => show(id)}>{label(id)}</button>) : <p className="text-sm">Aucune correspondance déterministe.</p>}</div>
        <p className="text-sm">Vérifiez les champs ci-dessous : ils deviendront partagés après confirmation.</p><DraftFields draft={draft} topics={topics} onChange={d => { setDraft(d); setValidated(false); }} />
        <label className="flex gap-2"><input type="checkbox" checked={validated} onChange={e => setValidated(e.target.checked)} />Je confirme le contenu public, la spécialisation du parent et chacune des relations sélectionnées.</label><div className="flex flex-wrap gap-2"><Button disabled={busy || !validated}>Confirmer la création</Button><Button type="button" variant="outline" disabled={busy} onClick={() => void action("cancel")}>Annuler la proposition</Button></div>
      </form>}
      {(run.state === "failed" || run.state === "running") && <Button disabled={busy} onClick={() => void action("resume")}>Reprendre l’opération</Button>}
      
      {run.state === "completed" && <Button onClick={() => { show(run.topicId); document.getElementById("topic-detail")?.scrollIntoView(); }}>Ouvrir la fiche du topic</Button>}
    </section>}
    <section aria-labelledby="routing" className="space-y-4 border-t pt-6"><h2 id="routing" className="text-lg font-bold">Router une demande privée</h2><form className="space-y-3" onSubmit={e => { e.preventDefault(); void perform(async () => setRouting(await api("/route-request", { intent: requestText }))); }}><label className="block space-y-1"><span id="topic-request-label">Demande</span><Textarea aria-labelledby="topic-request-label" required minLength={3} maxLength={2000} value={requestText} onChange={e => { setRequestText(e.target.value); setRouting(null); }} /></label><Button disabled={busy}>Proposer un routage</Button></form>
      {routing && <div className="space-y-3"><p>{routing.explanation}</p><label className="block space-y-1"><span id="topic-primary-label">Topic principal responsable</span><select aria-labelledby="topic-primary-label" className={selectClass} value={routing.primaryId ?? ""} onChange={e => setRouting({ ...routing, primaryId: e.target.value || null, secondaryIds: routing.secondaryIds.filter(id => id !== e.target.value) })}><option value="">Choisir un responsable</option>{topics.map(t => <option key={t.id} value={t.id}>{t.tag}</option>)}</select></label><fieldset><legend>Topics secondaires — contexte uniquement</legend>{topics.filter(t => t.id !== routing.primaryId).map(t => <label key={t.id} className="flex gap-2 py-1"><input type="checkbox" checked={routing.secondaryIds.includes(t.id)} onChange={e => setRouting({ ...routing, secondaryIds: e.target.checked ? [...routing.secondaryIds, t.id] : routing.secondaryIds.filter(id => id !== t.id) })} />{t.tag}</label>)}</fieldset><Button variant="outline" disabled={busy || !routing.primaryId} onClick={() => void perform(async () => setRouting(await api("/route-request", { intent: requestText, correction: { primaryId: routing.primaryId, secondaryIds: routing.secondaryIds } })))}>Valider la correction humaine</Button></div>}
    </section>
  </div>;
}
