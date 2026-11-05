"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { BloubEditor } from "@/components/bloub/bloub-editor";
import { toChoice } from "@/components/llm/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { DraftSections, FIELD_LABELS, ORIGIN_LABELS, Summary, type LLMChoices } from "@/components/xiagents/create/review";
import { browserTimeZone, ScheduleForm } from "@/components/xiagents/schedule/schedule-form";
import { bloubFromSeed } from "@/lib/bloub/presets";
import { acceptedIds, pending, previewDraft, previewTopic, proposalFields, selectAll, TOPIC_FIELDS, type PreviewState, type Selection, type TopicField } from "@/lib/konstruktor/preview";
import type { Configuration } from "@/lib/konstruktor/service";
import { PROPOSAL_LABELS, type KonstruktorSession, type Proposal, type TopicPatch } from "@/lib/konstruktor/types";
import type { InstancesResponse } from "@/lib/llm/types";
import type { Deployment } from "@/lib/xiagents/deployments";
import { draftIssues, draftToSpec, newDraft, type AgentDraft, type DraftField, type DraftPatch } from "@/lib/xiagents/draft";
import { changedSections, draftToEditSpec, EDIT_SECTIONS, topicEditSpec } from "@/lib/xiagents/edit";

/**
 * Interactive preview of Konstruktor's proposals before anything is written. The base is the
 * target's configuration read now (or a new draft); each proposal field can be accepted or left out,
 * each proposal refused; every section stays editable, labelled with where its value comes from
 * (current value, Konstruktor, the owner), and the owner's edits always win (`previewDraft`).
 * Validation sends one deployment (creation, or edit at the revisions read): the server checks
 * ownership, revisions (409: review the differences) and problems before writing, and the
 * deployment is the durable, resumable application log.
 */
type Result = { deployment: Deployment | null; error: string | null; stale: boolean };
const TOPIC_LABELS: Record<TopicField, string> = { name: "Nom", scope: "Périmètre", description: "Description" };
const TOPIC_ORIGINS = { existing: ORIGIN_LABELS.existing, ai: "Proposé par Konstruktor", manual: ORIGIN_LABELS.manual } as const;
const fieldLabel = (field: string) => FIELD_LABELS[field as DraftField] ?? TOPIC_LABELS[field as TopicField] ?? field;
const randomSeed = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init, headers: init?.body ? { "Content-Type": "application/json" } : undefined });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(typeof data.error === "string" ? data.error : "Requête impossible."), { status: response.status });
  return data as T;
}

/** The draft the preview starts from; a new one is rebuilt identically from its saved seed and time zone. */
function baseDraft(configuration: Configuration, origin: { seed: string; timeZone: string }): AgentDraft | null {
  if (configuration.kind === "agent") return configuration.draft;
  if (configuration.kind === "topic") return null;
  return newDraft({ presets: configuration.presets, timeZone: origin.timeZone, bloub: bloubFromSeed(origin.seed), target: configuration.kind === "new-topic" ? "topic" : "agent" });
}

export function KonstruktorReview({ session, onChanged }: { session: KonstruktorSession; onChanged: (session: KonstruktorSession) => void }) {
  const proposals = useMemo(() => session.history.flatMap(message => message.proposals), [session.history]);
  const [configuration, setConfiguration] = useState<Configuration | null>(null);
  const [base, setBase] = useState<AgentDraft | null>(null);
  const [changedMeanwhile, setChangedMeanwhile] = useState<string[]>([]);
  const [llm, setLlm] = useState<LLMChoices>({ instances: null, defaultInstanceId: null });
  const [selection, setSelection] = useState<Selection>(() => selectAll(proposals));
  const [manual, setManual] = useState<DraftPatch>({});
  const [topicManual, setTopicManual] = useState<TopicPatch>({});
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [result, setResult] = useState<Result>({ deployment: null, error: null, stale: false });
  // Same validated configuration, same deployment id: a retried validation never applies twice.
  const attempt = useRef<{ key: string; id: string } | null>(null);
  const agentKind = session.target.type.endsWith("agent");
  // Saved with the choices: a reload rebuilds the same new draft and finds the owner's work again.
  const origin = useRef({ seed: randomSeed(), timeZone: browserTimeZone() });
  const [restored, setRestored] = useState(false);

  /** Reads the configuration now; `compare`: says which sections changed since the previous read. */
  async function load(compare = false) {
    const [{ configuration: next }, saved] = await Promise.all([
      call<{ configuration: Configuration }>(`/api/konstruktor/sessions/${session.id}/configuration`),
      restored ? null : call<{ preview: { state: PreviewState } | null }>(`/api/konstruktor/sessions/${session.id}/preview`).then(result => result.preview),
    ]);
    if (saved) {
      const { state } = saved;
      if (state.seed && state.timeZone) origin.current = { seed: state.seed, timeZone: state.timeZone };
      setSelection(current => ({ ...current, ...state.selection })); setManual(state.manual as DraftPatch); setTopicManual(state.topicManual);
    }
    if (!restored) setRestored(true);
    const draft = baseDraft(next, origin.current);
    if (compare && configuration?.kind === "agent" && base && draft) setChangedMeanwhile(changedSections(base, draft).map(section => EDIT_SECTIONS[section].label));
    if (compare && configuration?.kind === "topic" && next.kind === "topic") setChangedMeanwhile(configuration.topic.revision !== next.topic.revision ? ["Topic"] : []);
    setConfiguration(next); setBase(draft);
  }
  useEffect(() => {
    load().catch(cause => setResult({ deployment: null, error: cause instanceof Error ? cause.message : "Configuration indisponible.", stale: false }));
    if (!agentKind) return;
    call<InstancesResponse>("/api/llm/instances")
      .then(result => setLlm({ instances: result.instances.map(toChoice), defaultInstanceId: result.settings.defaultInstanceId }))
      .catch(() => setLlm({ instances: [], defaultInstanceId: null }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);
  // New proposals arriving in the conversation are accepted by default; the owner's choices are kept.
  useEffect(() => { setSelection(current => ({ ...selectAll(proposals), ...current })); }, [proposals]);
  // The work in progress is saved (debounced, and when the page is left): choices and edits only.
  const state = useMemo<PreviewState>(() => ({ selection, manual, topicManual, ...(session.target.type.startsWith("new") ? origin.current : { seed: null, timeZone: null }) }), [selection, manual, topicManual, session.target.type]);
  useEffect(() => {
    if (!restored) return;
    const save = (keepalive = false) => fetch(`/api/konstruktor/sessions/${session.id}/preview`, { method: "PUT", keepalive, headers: { "Content-Type": "application/json" }, body: JSON.stringify(state) }).catch(() => undefined);
    const timer = setTimeout(() => void save(), 400);
    const leave = () => { clearTimeout(timer); void save(true); };
    window.addEventListener("pagehide", leave);
    return () => { clearTimeout(timer); window.removeEventListener("pagehide", leave); };
  }, [state, restored, session.id]);

  const preview = useMemo(() => base ? previewDraft(base, proposals, selection, manual) : null, [base, proposals, selection, manual]);
  const topicPreview = useMemo(() => configuration?.kind === "topic" ? previewTopic(configuration.topic, proposals, selection, topicManual) : null, [configuration, proposals, selection, topicManual]);
  const issues = useMemo(() => preview && configuration ? draftIssues(preview.draft, configuration.catalog, configuration.presets, llm.instances ?? undefined) : [], [preview, configuration, llm.instances]);
  const changes = configuration?.kind === "agent" && base && preview ? changedSections(base, preview.draft) : null;
  const conflicts = preview?.conflicts ?? topicPreview?.conflicts ?? [];
  const open = pending(proposals);

  const edit = (patch: DraftPatch) => setManual(current => ({ ...current, ...patch }));
  const drop = (field: string) => { setManual(current => { const next = { ...current }; delete next[field as DraftField]; return next; }); setTopicManual(current => { const next = { ...current }; delete next[field as TopicField]; return next; }); };
  const toggle = (proposal: Proposal, field: string, on: boolean) => setSelection(current => ({ ...current, [proposal.id]: on ? [...new Set([...(current[proposal.id] ?? []), field])] : (current[proposal.id] ?? []).filter(item => item !== field) }));

  async function decide(body: { refused?: string[]; reset?: string[] }) {
    setBusy(true);
    try { onChanged((await call<{ session: KonstruktorSession }>(`/api/konstruktor/sessions/${session.id}/decisions`, { method: "POST", body: JSON.stringify(body) })).session); }
    catch (cause) { setResult({ deployment: null, error: cause instanceof Error ? cause.message : "Décision non enregistrée.", stale: false }); }
    finally { setBusy(false); }
  }

  function spec() {
    if (!configuration) throw new Error("Configuration non chargée.");
    if (configuration.kind === "topic") {
      if (!topicPreview || !Object.keys(topicPreview.patch).length) throw new Error("Aucune modification du topic à appliquer.");
      return topicEditSpec(configuration.topic, topicPreview.patch, topicPreview.model);
    }
    if (!preview) throw new Error("Aperçu indisponible.");
    if (issues.length) throw new Error(issues.map(issue => issue.message).join(" "));
    if (configuration.kind === "agent") {
      if (!changes?.length) throw new Error("Aucune modification à appliquer.");
      return draftToEditSpec(base!, preview.draft, configuration.base);
    }
    return draftToSpec(preview.draft);
  }

  /** Runs (or resumes) the deployment until it ends; another tab holding it (409) is waited for. */
  async function run(id: string) {
    for (let attempt = 0; attempt < 30; attempt++) {
      try { return (await call<{ deployment: Deployment }>(`/api/xiagents/deployments/${id}`, { method: "POST", body: JSON.stringify({ action: "run" }) })).deployment; }
      catch (cause) { if ((cause as { status?: number }).status !== 409) throw cause; await new Promise(resolve => setTimeout(resolve, 1_000)); }
    }
    throw new Error("Application toujours en cours dans un autre onglet : suivez-la dans le journal.");
  }

  async function apply() {
    setBusy(true); setAttempted(true); setResult({ deployment: null, error: null, stale: false });
    try {
      const body = spec();
      const key = JSON.stringify(body);
      if (attempt.current?.key !== key) attempt.current = { key, id: crypto.randomUUID() };
      const applied = await call<{ deployment: Deployment; session: KonstruktorSession }>(`/api/konstruktor/sessions/${session.id}/apply`, {
        method: "POST", body: JSON.stringify({ deploymentId: attempt.current.id, spec: body, accepted: acceptedIds(proposals, selection) }),
      });
      onChanged(applied.session);
      const deployment = await run(applied.deployment.id);
      const failed = deployment.steps.find(step => step.status === "failed");
      setResult({ deployment, error: failed?.error ?? null, stale: !!failed?.error?.includes("depuis l’aperçu") });
      onChanged((await call<{ session: KonstruktorSession }>(`/api/konstruktor/sessions/${session.id}`)).session);
      if (deployment.state === "completed") { attempt.current = null; setManual({}); setTopicManual({}); setAttempted(false); await load(); }
    } catch (cause) {
      const status = (cause as { status?: number }).status;
      setResult({ deployment: null, error: cause instanceof Error ? cause.message : "Application impossible.", stale: status === 409 });
    } finally { setBusy(false); }
  }

  async function review() {
    setBusy(true);
    try { attempt.current = null; await load(true); setResult({ deployment: null, error: null, stale: false }); }
    catch (cause) { setResult({ deployment: null, error: cause instanceof Error ? cause.message : "Configuration indisponible.", stale: false }); }
    finally { setBusy(false); }
  }

  if (!configuration) return <p className="text-sm text-muted-foreground" role="status">{result.error ?? "Chargement de la configuration actuelle…"}</p>;
  const editable = configuration.kind !== "topic" || configuration.editable;
  return <section aria-label="Aperçu avant application" className="space-y-3 rounded-lg border p-3">
    <h3 className="font-semibold">Aperçu avant application</h3>
    <p className="text-xs text-muted-foreground">Rien n’est modifié avant votre validation. Chaque section indique l’origine de ses valeurs : valeur actuelle, proposition de Konstruktor ou modification de votre part ; vos modifications ne sont jamais remplacées par une proposition.</p>
    {changedMeanwhile.length > 0 && <p role="note" className="rounded-md bg-muted p-2 text-sm">Modifié depuis votre précédent aperçu : {changedMeanwhile.join(", ")}. L’aperçu repart de la configuration actuelle ; vos choix et vos modifications sont conservés.</p>}

    <ul aria-label="Propositions à valider" className="space-y-2">
      {proposals.map(proposal => {
        const live = open.includes(proposal);
        return <li key={proposal.id} data-status={proposal.status} className="rounded-md border p-2 text-sm">
          <p className="font-medium">{proposal.summary}</p>
          <p className="text-xs text-muted-foreground">{PROPOSAL_LABELS[proposal.status]}</p>
          {live && <fieldset className="mt-1 flex flex-wrap gap-3 text-xs"><legend className="sr-only">Éléments de « {proposal.summary} » à appliquer</legend>
            {proposalFields(proposal).map(field => <label key={field} className="flex items-center gap-1">
              <input type="checkbox" checked={selection[proposal.id]?.includes(field) ?? false} onChange={event => toggle(proposal, field, event.target.checked)} />{fieldLabel(field)}
            </label>)}
          </fieldset>}
          <div className="mt-1 flex flex-wrap gap-2">
            {live && <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => { setSelection(current => ({ ...current, [proposal.id]: [] })); void decide({ refused: [proposal.id] }); }}>Refuser</Button>}
            {proposal.status === "refused" && <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => { setSelection(current => ({ ...current, [proposal.id]: proposalFields(proposal) })); void decide({ reset: [proposal.id] }); }}>Reconsidérer</Button>}
            {proposal.deploymentId && proposal.status !== "refused" && <Link className="text-xs underline" href={`/dashboard/xiagents/deployments/${proposal.deploymentId}`}>{proposal.status === "applied" ? "Journal d’application" : "Reprendre l’application"}</Link>}
          </div>
        </li>;
      })}
    </ul>

    {conflicts.length > 0 && <div role="note" aria-label="Modifications manuelles conservées" className="space-y-1 rounded-md border border-amber-500/60 p-2 text-sm">
      <p className="font-medium">Vos modifications sont conservées :</p>
      <ul className="space-y-1">{conflicts.map(conflict => <li key={`${conflict.proposalId}-${conflict.field}`} className="flex flex-wrap items-center gap-2">
        <span>{fieldLabel(conflict.field)} : Konstruktor propose une autre valeur.</span>
        <Button type="button" size="sm" variant="outline" onClick={() => drop(conflict.field)}>Reprendre la proposition</Button>
      </li>)}</ul>
    </div>}

    {!editable && <p role="alert" className="text-sm text-destructive">Seul le créateur de ce topic peut le modifier : les propositions restent consultables.</p>}
    {topicPreview && editable && <div className="space-y-2">
      {TOPIC_FIELDS.map(field => <label key={field} className="grid gap-1 text-sm">{TOPIC_LABELS[field]} <span className="text-xs text-muted-foreground">{TOPIC_ORIGINS[topicPreview.origins[field]]}</span>
        {field === "name" ? <Input maxLength={160} value={topicPreview.values[field]} onChange={event => setTopicManual(current => ({ ...current, [field]: event.target.value }))} />
          : <Textarea rows={3} maxLength={4000} value={topicPreview.values[field]} onChange={event => setTopicManual(current => ({ ...current, [field]: event.target.value }))} />}
      </label>)}
    </div>}
    {preview && <div className="space-y-3">
      <DraftSections draft={preview.draft} edit={edit} topics={configuration.catalog} presets={configuration.presets} issues={issues} attempted={attempted} handle={null} llm={llm} expand={false} />
      {preview.draft.target === "agent" && <>
        <details className="rounded-md border p-3"><summary className="cursor-pointer"><span className="font-medium">Calendriers</span>
          <span className="block text-xs text-muted-foreground">{preview.draft.schedule.timeZone} · {preview.draft.provenance.schedule ? ORIGIN_LABELS[preview.draft.provenance.schedule] : ""}</span></summary>
          <div className="mt-3"><ScheduleForm value={preview.draft.schedule} onChange={schedule => edit({ schedule })} /></div>
        </details>
        <details className="rounded-md border p-3"><summary className="cursor-pointer"><span className="font-medium">Avatar Bloub</span>
          <span className="block text-xs text-muted-foreground">{preview.draft.provenance.bloub ? ORIGIN_LABELS[preview.draft.provenance.bloub] : ""}</span></summary>
          <div className="mt-3"><BloubEditor value={preview.draft.bloub} onChange={bloub => edit({ bloub })} name={preview.draft.name || "ce ΞAgent"} /></div>
        </details>
      </>}
      {configuration.kind === "agent"
        ? <p className="text-sm" aria-live="polite">{changes?.length ? `Sections modifiées : ${changes.map(section => EDIT_SECTIONS[section].label).join(", ")}.` : "Aucune différence avec la configuration actuelle."}</p>
        : <Summary draft={preview.draft} topics={configuration.catalog} instances={llm.instances} />}
    </div>}

    <div className="flex flex-wrap items-center gap-2 border-t pt-3">
      <Button type="button" disabled={busy || !editable} onClick={() => void apply()}>{busy ? "Application…" : "Valider et appliquer"}</Button>
      {(result.stale || result.deployment?.state === "failed") && <Button type="button" variant="outline" disabled={busy} onClick={() => void review()}>Revoir les différences</Button>}
      {result.deployment && <Link className="text-sm underline" href={`/dashboard/xiagents/deployments/${result.deployment.id}`}>Journal d’application</Link>}
    </div>
    <p role="status" aria-live="polite" data-application={result.deployment?.state ?? (result.error ? "refused" : "none")} className={`text-sm ${result.error ? "text-destructive" : ""}`}>
      {result.deployment?.state === "completed" ? "Configuration appliquée." : result.error ? `${result.stale ? "La configuration a changé depuis l’aperçu : " : "Application impossible : "}${result.error}` : ""}
    </p>
  </section>;
}
