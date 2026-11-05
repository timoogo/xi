"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { BloubEditor } from "@/components/bloub/bloub-editor";
import { toChoice, type InstanceChoice } from "@/components/llm/format";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import type { Preset } from "@/lib/accounts/types";
import { bloubFromSeed } from "@/lib/bloub/presets";
import type { InstancesResponse } from "@/lib/llm/types";
import type { Topic } from "@/lib/topics/types";
import {
  applySuggestion, conflicts, draftIssues, draftToSpec, editDraft, emptyTopicDraft, newDraft,
  type AgentDraft, type DraftField, type DraftIssue, type DraftPatch, type Origin, type TopicPick,
} from "@/lib/xiagents/draft";
import { suggestDraft, type Suggestion } from "@/lib/xiagents/suggest";
import { draftToYaml, MAX_YAML_BYTES, parseAgentYaml, type YamlIssue } from "@/lib/xiagents/yaml";
import { browserTimeZone, ScheduleForm } from "../schedule/schedule-form";
import { DraftSections, exclusions, FIELD_LABELS, ORIGIN_LABELS, Summary, type HandleCheck, type LLMChoices } from "./review";

/**
 * Creation of a ΞAgent (or of a topic alone) from one shared draft (`lib/xiagents/draft`), whatever
 * the entry: a few words analysed by local rules (no AI needed), a YAML file or paste, or manual
 * entry. The review is a compact summary whose sections open for editing; the local model can
 * enrich the draft afterwards without overwriting what the owner edited. Calendars and Bloub keep
 * their own steps; nothing is written before the deployment, which is the same for every entry.
 */
type Mode = "smart" | "yaml" | "manual";
type Match = { id: string; tag: string; name: string; hits: string[] | number };
type RulesResponse = { ok: true; mode: "rules"; suggestion: Suggestion };
type AiResponse = { ok: true; patch: DraftPatch; proposal: { model: string } } | { ok: false; unavailable: boolean; reason: string };

async function request<T>(url: string, method = "GET", data?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { method, cache: "no-store", signal, ...(data ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) } : {}) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error ?? "Requête impossible.");
  return result as T;
}
const randomSeed = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
const STEPS = { agent: ["Décrire", "Vérifier", "Calendriers", "Personnaliser", "Déployer"], topic: ["Décrire", "Vérifier", "Déployer"] } as const;

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/yaml;charset=utf-8" }));
  const link = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function ReviewStep({ draft, setDraft, edit, topics, presets, issues, attempted, notes, matches, handle, llm }: {
  draft: AgentDraft; setDraft: (update: (draft: AgentDraft) => AgentDraft) => void; edit: (patch: DraftPatch) => void; topics: Topic[]; presets: Preset[];
  issues: DraftIssue[]; attempted: boolean; notes: { origin: Origin; lines: string[] } | null; matches: Match[]; handle: HandleCheck; llm: LLMChoices;
}) {
  const manual = Object.values(draft.provenance).every(origin => origin === "default" || origin === "manual") && !notes;
  const [ai, setAi] = useState<{ status: "idle" | "loading" | "done" | "failed"; message?: string }>({ status: "idle" });
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  async function enrich() {
    abort.current?.abort();
    const controller = abort.current = new AbortController();
    setAi({ status: "loading" });
    try {
      const text = [draft.description, draft.name, draft.about].filter(Boolean).join(". ").slice(0, 4000);
      const result = await request<AiResponse>("/api/xiagents/proposals", "POST", { description: text, mode: "ai" }, controller.signal);
      if (!result.ok) { setAi({ status: "failed", message: `${result.unavailable ? "Moteur IA indisponible" : "Proposition impossible"} : ${result.reason} La configuration actuelle reste utilisable.` }); return; }
      const kept = conflicts(draft, result.patch);
      setDraft(current => applySuggestion(current, result.patch, "ai", result.proposal.model));
      setAi({ status: "done", message: `Proposition du modèle local ${result.proposal.model} appliquée aux champs que vous n’avez pas modifiés.${kept.length ? ` Vos choix conservés : ${kept.map(field => FIELD_LABELS[field]).join(", ")}.` : ""} Les sources suggérées sont à vérifier.` });
    } catch (reason) {
      if (controller.signal.aborted) { setAi({ status: "idle" }); return; }
      setAi({ status: "failed", message: reason instanceof Error ? reason.message : "Proposition impossible." });
    }
  }

  const aiPanel = <div className="space-y-1 rounded-md bg-muted p-2 text-sm" aria-live="polite">
    {notes && <><p className="font-medium">{ORIGIN_LABELS[notes.origin]} : vérifiez la proposition, tout reste modifiable.</p><ul className="list-inside list-disc text-xs">{notes.lines.map((line, index) => <li key={index}>{line}</li>)}</ul></>}
    {manual && <p>Saisie manuelle.</p>}
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" size="sm" variant="outline" disabled={ai.status === "loading" || !(draft.description || draft.name)} onClick={() => void enrich()}>{ai.status === "loading" ? "Enrichissement en cours…" : "Enrichir avec l’IA locale"}</Button>
      {ai.status === "loading" && <Button type="button" size="sm" variant="ghost" onClick={() => abort.current?.abort()}>Annuler</Button>}
      <span className="text-xs text-muted-foreground">Facultatif ; jusqu’à une minute ; rien n’est envoyé à un service externe ; vos modifications ne sont jamais écrasées.</span>
    </div>
    {ai.message && <p className={ai.status === "failed" ? "text-destructive" : ""}>{ai.message}</p>}
    {matches.length > 0 && <p className="text-xs text-muted-foreground">Topics existants proches : {matches.map(match => match.name).join(", ")}.</p>}
  </div>;

  return <div className="space-y-3">
    {aiPanel}
    <DraftSections draft={draft} edit={edit} topics={topics} presets={presets} issues={issues} attempted={attempted} handle={handle} llm={llm} expand={manual} />
  </div>;
}

export function CreateXiAgent({ topics, presets, duplicateId }: { topics: Topic[]; presets: Preset[]; duplicateId?: string }) {
  const [open, setOpen] = useState(!!duplicateId);
  return <Dialog open={open} onOpenChange={setOpen}>
    <DialogTrigger asChild><Button>Créer un ΞAgent ou un topic</Button></DialogTrigger>
    <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-3xl" onInteractOutside={event => event.preventDefault()}>
      <Wizard topics={topics} presets={presets} duplicateId={duplicateId} onClose={() => setOpen(false)} />
    </DialogContent>
  </Dialog>;
}

function Wizard({ topics, presets, duplicateId, onClose }: { topics: Topic[]; presets: Preset[]; duplicateId?: string; onClose: () => void }) {
  const router = useRouter();
  const fresh = () => newDraft({ presets, timeZone: browserTimeZone(), bloub: bloubFromSeed(randomSeed()) });
  const [draft, setDraft] = useState<AgentDraft>(fresh);
  const [mode, setMode] = useState<Mode>(duplicateId ? "yaml" : "smart");
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [attempted, setAttempted] = useState(false);
  const [notes, setNotes] = useState<{ origin: Origin; lines: string[] } | null>(null);
  const [yamlIssues, setYamlIssues] = useState<YamlIssue[]>([]);
  const [matches, setMatches] = useState<Match[]>([]);
  const [handle, setHandle] = useState<HandleCheck>(null);
  const [deploymentId] = useState(() => crypto.randomUUID());
  const heading = useRef<HTMLHeadingElement>(null);
  // The owner's LLM instances: model pickers, and portable instance keys of imported YAML.
  const [llm, setLlm] = useState<LLMChoices>({ instances: null, defaultInstanceId: null });
  const instancesLoad = useRef<Promise<InstanceChoice[]> | null>(null);
  useEffect(() => {
    instancesLoad.current = request<InstancesResponse>("/api/llm/instances")
      .then(result => { const instances = result.instances.map(toChoice); setLlm({ instances, defaultInstanceId: result.settings.defaultInstanceId }); return instances; })
      // Unavailable list: imported instance keys stay unresolved and ask for an explicit choice.
      .catch(() => { setLlm({ instances: [], defaultInstanceId: null }); return []; });
  }, []);
  const steps = STEPS[draft.target];
  const edit = (patch: DraftPatch) => setDraft(current => editDraft(current, patch));
  useEffect(() => { heading.current?.focus(); }, [step]);

  const issues = useMemo(() => draftIssues(draft, topics, presets, llm.instances ?? undefined), [draft, topics, presets, llm.instances]);
  const handleTaken = draft.target === "agent" && handle?.handle === draft.handle && !handle.available;

  // Live availability of the handle while reviewing (the server checks it again at deployment).
  useEffect(() => {
    if (step !== 1 || draft.target !== "agent" || !draft.handle || issues.some(issue => issue.field === "handle")) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      request<{ available: boolean; alternative?: string | null }>(`/api/xiagents/handles?handle=${encodeURIComponent(draft.handle)}&suggest=1`, "GET", undefined, controller.signal)
        .then(result => setHandle({ handle: draft.handle, ...result })).catch(() => {});
    }, 350);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [step, draft.target, draft.handle, issues]);

  function begin(next: AgentDraft, origin: Origin, lines: string[]) {
    setDraft(next); setNotes(lines.length ? { origin, lines } : null); setAttempted(false); setError(""); setStep(1);
  }
  async function suggest() {
    setBusy(true); setError("");
    try {
      const { suggestion } = await request<RulesResponse>("/api/xiagents/proposals", "POST", { description: draft.description, mode: "rules" });
      setMatches(suggestion.matches);
      const base = { ...fresh(), target: draft.target, description: draft.description };
      begin(applySuggestion(base, suggestion.patch, "rules"), "rules", suggestion.notes);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Analyse impossible."); }
    finally { setBusy(false); }
  }
  async function importYaml(text: string) {
    setError("");
    const instances = await (instancesLoad.current ?? Promise.resolve([]));
    const result = parseAgentYaml(text, { catalog: topics, presets, instances: instances.map(({ id, key, name }) => ({ id, key, name })) });
    setYamlIssues(result.issues);
    if (!result.ok) { setError("Le YAML n’a pas pu être importé : corrigez les erreurs signalées."); return; }
    // Fields absent from the file are completed by the local rules, then the file's values win.
    const words = [result.patch.name, result.patch.about, ...(result.patch.topics ?? []).map(pick => pick.type === "new" ? pick.draft.name : topics.find(topic => topic.id === pick.id)?.name)].filter(Boolean).join(", ");
    let next: AgentDraft = { ...fresh(), target: result.target, description: words };
    let lines: string[] = [];
    if (words.trim().length >= 2) {
      const completion = suggestDraft({ text: words, catalog: topics, presets });
      const missing = Object.fromEntries(Object.entries(completion.patch).filter(([key]) => !(key in result.patch))) as DraftPatch;
      next = applySuggestion(next, missing, "rules");
      if (Object.keys(missing).length) lines = [`Champs absents du fichier complétés par les règles locales : ${Object.keys(missing).map(key => FIELD_LABELS[key as DraftField]).join(", ")}.`];
    }
    const excluded = exclusions(result.patch.sources ?? []);
    if (excluded.length) lines.push(`Sources exclues par le fichier, conservées exclues (jamais collectées) : ${excluded.join(", ")}. Vous pouvez les réautoriser dans la section Sources.`);
    begin(applySuggestion(next, result.patch, "yaml"), "yaml", [...lines, ...result.issues.map(issue => `${issue.level === "error" ? "Champ ignoré — " : ""}${issue.path || "document"} : ${issue.message}`)]);
  }
  function manual() {
    const base = { ...fresh(), target: draft.target, description: draft.description };
    const first: TopicPick = draft.target === "agent" && topics[0] ? { type: "existing", id: topics[0].id } : { type: "new", key: "new-1", draft: emptyTopicDraft() };
    begin({ ...base, topics: [first] }, "manual", []);
  }

  // Duplication: the existing agent's configuration (never its history) imported as a new draft.
  const duplicated = useRef(false);
  useEffect(() => {
    if (!duplicateId || duplicated.current) return;
    duplicated.current = true;
    fetch(`/api/xiagents/${encodeURIComponent(duplicateId)}/export`, { cache: "no-store" })
      .then(async response => { if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error); await importYaml(await response.text()); })
      .catch(reason => setError(reason instanceof Error && reason.message ? reason.message : "Configuration du ΞAgent à dupliquer indisponible."));
  });

  async function next() {
    setError(""); setAttempted(true);
    if (step === 1) {
      const blocking = issues.filter(issue => issue.section !== "schedule");
      if (blocking.length) { setError(blocking.map(issue => issue.message).join(" ")); return; }
      if (draft.target === "agent") {
        setBusy(true);
        try {
          const result = await request<{ available: boolean; alternative?: string | null }>(`/api/xiagents/handles?handle=${encodeURIComponent(draft.handle)}&suggest=1`);
          setHandle({ handle: draft.handle, ...result });
          if (!result.available) { setError(`Le handle @${draft.handle} est déjà réservé : choisissez-en un autre.`); return; }
        } catch (reason) { setError(reason instanceof Error ? reason.message : "Vérification du handle impossible."); return; }
        finally { setBusy(false); }
      }
    } else if (issues.length) { setError(issues.map(issue => issue.message).join(" ")); return; }
    setAttempted(false);
    setStep(step + 1);
  }
  async function deploy() {
    setBusy(true); setError("");
    try {
      if (issues.length) throw new Error(issues.map(issue => issue.message).join(" "));
      await request("/api/xiagents/deployments", "POST", { id: deploymentId, spec: draftToSpec(draft) });
      onClose();
      router.push(`/dashboard/xiagents/deployments/${deploymentId}`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Déploiement impossible."); }
    finally { setBusy(false); }
  }
  const exportYaml = () => {
    try { download(`${draft.handle || (draft.target === "topic" ? "topic" : "xiagent")}.xiagent.yaml`, draftToYaml(draft, topics, llm.instances ?? [])); setError(""); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Export impossible."); }
  };

  const last = step === steps.length - 1;
  return <div className="space-y-4">
    <DialogHeader>
      <DialogTitle>{draft.target === "agent" ? "Nouveau ΞAgent" : "Nouveau topic"}</DialogTitle>
      <DialogDescription>Étape {step + 1} sur {steps.length} : {steps[step]}. Rien n’est enregistré avant le déploiement.</DialogDescription>
    </DialogHeader>
    <ol className="flex flex-wrap gap-1 text-xs" aria-label="Étapes">
      {steps.map((name, index) => <li key={name} aria-current={index === step ? "step" : undefined}
        className={`rounded-full border px-2 py-0.5 ${index === step ? "border-foreground font-semibold" : index < step ? "bg-muted" : "text-muted-foreground"}`}>{index + 1}. {name}{index < step ? " ✓" : ""}</li>)}
    </ol>
    <h3 ref={heading} tabIndex={-1} className="text-lg font-semibold outline-none">{steps[step]}</h3>

    {step === 0 && <DescribeStep draft={draft} setDraft={setDraft} mode={mode} setMode={setMode} busy={busy} yamlIssues={yamlIssues}
      onSuggest={() => void suggest()} onImport={text => void importYaml(text)} onManual={manual} onError={setError} />}
    {step === 1 && <ReviewStep draft={draft} setDraft={setDraft} edit={edit} topics={topics} presets={presets} issues={issues} attempted={attempted}
      notes={notes} matches={matches} handle={handleTaken ? handle : null} llm={llm} />}
    {draft.target === "agent" && step === 2 && <ScheduleForm value={draft.schedule} onChange={schedule => edit({ schedule })} />}
    {draft.target === "agent" && step === 3 && <section className="space-y-3">
      <p className="text-sm text-muted-foreground">Bloub attribué par défaut à ce ΞAgent (facultatif). Vous pouvez le garder tel quel ou le personnaliser ; il reste modifiable depuis la page du ΞAgent.</p>
      <BloubEditor value={draft.bloub} onChange={bloub => edit({ bloub })} name={draft.name || "ce ΞAgent"} />
      <Button type="button" variant="outline" size="sm" onClick={() => edit({ bloub: bloubFromSeed(randomSeed()) })}>Tirer un autre Bloub</Button>
    </section>}
    {last && <Summary draft={draft} topics={topics} instances={llm.instances} />}

    <p role="alert" className="text-sm text-destructive">{error}</p>
    <div className="flex flex-wrap justify-between gap-2 border-t pt-3">
      <Button type="button" variant="ghost" disabled={busy || step === 0} onClick={() => { setError(""); setAttempted(false); setStep(step - 1); }}>Précédent</Button>
      <div className="flex flex-wrap gap-2">
        {step > 0 && <Button type="button" variant="outline" onClick={exportYaml}>Exporter le YAML</Button>}
        {step > 0 && (last
          ? <Button type="button" disabled={busy} onClick={() => void deploy()}>{busy ? "Création du déploiement…" : "Déployer"}</Button>
          : <Button type="button" disabled={busy} onClick={() => void next()}>Suivant</Button>)}
      </div>
    </div>
  </div>;
}

function DescribeStep({ draft, setDraft, mode, setMode, busy, yamlIssues, onSuggest, onImport, onManual, onError }: {
  draft: AgentDraft; setDraft: (draft: AgentDraft) => void; mode: Mode; setMode: (mode: Mode) => void; busy: boolean; yamlIssues: YamlIssue[];
  onSuggest: () => void; onImport: (text: string) => void; onManual: () => void; onError: (message: string) => void;
}) {
  const id = useId();
  const [yaml, setYaml] = useState("");
  async function read(file: File | undefined) {
    if (!file) return;
    if (!/\.ya?ml$/i.test(file.name)) { onError("Fichier .yaml ou .yml attendu."); return; }
    if (file.size > MAX_YAML_BYTES) { onError(`Fichier trop volumineux (${Math.round(MAX_YAML_BYTES / 1000)} ko au plus).`); return; }
    const text = await file.text();
    setYaml(text); onImport(text);
  }
  const modes: [Mode, string, string][] = [
    ["smart", "Création intelligente", "Quelques mots suffisent ; Ξ propose une configuration modifiable."],
    ["yaml", "Importer un YAML", "Fichier ou texte collé ; tout reste modifiable."],
    ["manual", "Saisie manuelle", "Tous les champs, à remplir vous-même."],
  ];
  return <div className="space-y-4">
    <fieldset className="flex flex-wrap gap-4 text-sm" disabled={busy}><legend className="mb-1 font-medium">Que voulez-vous créer ?</legend>
      <label className="flex items-center gap-1"><input type="radio" name={`${id}-target`} checked={draft.target === "agent"} onChange={() => setDraft({ ...draft, target: "agent" })} /> Un ΞAgent (veille et publication)</label>
      <label className="flex items-center gap-1"><input type="radio" name={`${id}-target`} checked={draft.target === "topic"} onChange={() => setDraft({ ...draft, target: "topic", topics: [] })} /> Un topic seul</label>
    </fieldset>
    <fieldset className="grid gap-2 sm:grid-cols-3" disabled={busy}><legend className="mb-1 text-sm font-medium">Comment ?</legend>
      {modes.map(([value, label, hint]) => <label key={value} className={`flex cursor-pointer gap-2 rounded-md border p-3 text-sm ${mode === value ? "border-foreground" : ""}`}>
        <input type="radio" name={`${id}-mode`} className="mt-1" checked={mode === value} onChange={() => setMode(value)} />
        <span><span className="block font-medium">{label}</span><span className="block text-xs text-muted-foreground">{hint}</span></span>
      </label>)}
    </fieldset>

    {mode === "smart" && <form className="space-y-2" onSubmit={event => { event.preventDefault(); onSuggest(); }}>
      <label className="grid gap-1 text-sm">Sujet en quelques mots
        <Textarea rows={3} maxLength={4000} value={draft.description} disabled={busy} onChange={event => setDraft({ ...draft, description: event.target.value })}
          placeholder="Exemple : Astronomie, NASA, JWST, exoplanètes" aria-describedby={`${id}-smart`} />
        <span id={`${id}-smart`} className="text-xs text-muted-foreground">Un mot, quelques mots-clés ou une description. L’analyse est locale et ne nécessite pas d’IA ; l’IA locale pourra ensuite enrichir la proposition.</span>
      </label>
      <Button type="submit" disabled={busy || draft.description.trim().length < 2}>{busy ? "Analyse…" : "Proposer une configuration"}</Button>
    </form>}

    {mode === "yaml" && <div className="space-y-2">
      <label className="grid gap-1 text-sm">Fichier de configuration (.yaml, .yml)
        <input type="file" accept=".yaml,.yml,application/yaml,text/yaml" disabled={busy} className="text-sm" onChange={event => { void read(event.target.files?.[0]); event.target.value = ""; }} />
      </label>
      <label className="grid gap-1 text-sm">Ou collez le YAML
        <Textarea rows={8} className="font-mono text-xs" value={yaml} maxLength={MAX_YAML_BYTES} onChange={event => setYaml(event.target.value)} placeholder={"xiagent: 1\nidentity:\n  name: Veille astronomie"} />
      </label>
      <Button type="button" disabled={busy || !yaml.trim()} onClick={() => onImport(yaml)}>Importer</Button>
      <p className="text-xs text-muted-foreground">L’import préremplit le formulaire : rien n’est enregistré ni déployé, les sources importées restent à approuver. Format : docs/xiagent-yaml.md.</p>
      {yamlIssues.some(issue => issue.level === "error") && <ul aria-label="Erreurs d’import" className="list-inside list-disc rounded-md border border-destructive/50 p-3 text-sm text-destructive">
        {yamlIssues.filter(issue => issue.level === "error").map((issue, index) => <li key={index}><code>{issue.path || "document"}</code> : {issue.message}</li>)}
      </ul>}
    </div>}

    {mode === "manual" && <div className="space-y-2">
      <p className="text-sm text-muted-foreground">Le formulaire complet s’ouvre vide (valeurs par défaut pour le style et les calendriers).</p>
      <Button type="button" variant="outline" disabled={busy} onClick={onManual}>Saisir manuellement</Button>
    </div>}
  </div>;
}

/** Collapsible review section: a one-line summary, the provenance, and its errors even when closed. */
