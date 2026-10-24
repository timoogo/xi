"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { BloubEditor } from "@/components/bloub/bloub-editor";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { CHARTER, type Preset, type Settings } from "@/lib/accounts/types";
import { bloubFromSeed } from "@/lib/bloub/presets";
import type { Topic } from "@/lib/topics/types";
import { describeRanges, WEEKDAYS } from "@/lib/xiagents/calendar";
import {
  applySuggestion, conflicts, draftIssues, draftToSpec, editDraft, emptyTopicDraft, newDraft, newTopicKey, presetKey,
  type AgentDraft, type DraftField, type DraftIssue, type DraftPatch, type DraftSection, type Origin, type SourceRow, type TopicPick,
} from "@/lib/xiagents/draft";
import { suggestDraft, type Suggestion } from "@/lib/xiagents/suggest";
import { draftToYaml, MAX_YAML_BYTES, parseAgentYaml, type YamlIssue } from "@/lib/xiagents/yaml";
import { browserTimeZone, ScheduleForm } from "../schedule/schedule-form";

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
type HandleCheck = { handle: string; available: boolean; alternative?: string | null } | null;

async function request<T>(url: string, method = "GET", data?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { method, cache: "no-store", signal, ...(data ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) } : {}) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error ?? "Requête impossible.");
  return result as T;
}
const randomSeed = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
const selectClass = "w-full rounded-md border bg-background px-3 py-2 text-sm";
const STEPS = { agent: ["Décrire", "Vérifier", "Calendriers", "Personnaliser", "Déployer"], topic: ["Décrire", "Vérifier", "Déployer"] } as const;
const FIELD_LABELS: Record<DraftField, string> = { name: "nom", handle: "handle", about: "description", topics: "topics", perimeter: "périmètre", charter: "charte", presetKey: "preset", settings: "style", modelRef: "modèle", autoPublish: "publication autonome", sources: "sources", schedule: "calendriers", bloub: "Bloub" };
const SECTION_FIELDS: Record<Exclude<DraftSection, "schedule">, DraftField[]> = {
  identity: ["name", "handle", "about"], topics: ["topics"], editorial: ["perimeter", "charter"], sources: ["sources"], advanced: ["presetKey", "settings", "modelRef", "autoPublish"],
};
const SOURCE_ORIGINS: Record<SourceRow["origin"], string> = { ai: "suggérée par l’IA", yaml: "importée (YAML)", user: "ajoutée par vous" };
/** Excluded sources, with their provenance: listed wherever sources are summarised. */
const exclusions = (sources: SourceRow[]) => sources.filter(source => source.status === "excluded").map(source => `${source.domain} (${SOURCE_ORIGINS[source.origin]})`);
const ORIGIN_LABELS: Record<Origin, string> = { manual: "Modifié par vous", rules: "Suggéré (mots-clés, sans IA)", ai: "Suggéré par l’IA locale", yaml: "Importé (YAML)", default: "Valeurs par défaut" };

/** One line per topic reference, missing ones said as such (never hidden). */
function topicLabel(pick: TopicPick, topics: Topic[]) {
  if (pick.type === "new") return `${pick.draft.name || "sans nom"}${pick.draft.tag ? ` · ${pick.draft.tag}` : ""} (nouveau)`;
  const found = pick.id ? topics.find(topic => topic.id === pick.id) : undefined;
  if (pick.type === "existing" && found) return `${found.name} (existant)`;
  return `${pick.type === "unresolved" && pick.tag ? pick.tag : "topic inconnu"} (introuvable)`;
}
const isMissing = (pick: TopicPick, topics: Topic[]) => pick.type === "unresolved" || (pick.type === "existing" && !topics.some(topic => topic.id === pick.id));
/** New topic prefilled from a missing reference's tag (parent linked when its prefix exists). */
function topicFromTag(tag: string, picks: TopicPick[], topics: Topic[]): TopicPick {
  const last = tag.split(".").at(-1)!.replace(/-/g, " ");
  const name = last.charAt(0).toUpperCase() + last.slice(1);
  const parent = tag.includes(".") ? topics.find(topic => topic.tag === tag.split(".").slice(0, -1).join(".")) : undefined;
  return { type: "new", key: newTopicKey(picks), draft: { ...emptyTopicDraft(), tag, name, scope: `Actualités, travaux et analyses relevant de « ${name} ».`, parentId: parent?.id ?? null } };
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/yaml;charset=utf-8" }));
  const link = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
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
  const steps = STEPS[draft.target];
  const edit = (patch: DraftPatch) => setDraft(current => editDraft(current, patch));
  useEffect(() => { heading.current?.focus(); }, [step]);

  const issues = useMemo(() => draftIssues(draft, topics, presets), [draft, topics, presets]);
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
  function importYaml(text: string) {
    setError("");
    const result = parseAgentYaml(text, { catalog: topics, presets });
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
      .then(async response => { if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error); importYaml(await response.text()); })
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
    try { download(`${draft.handle || (draft.target === "topic" ? "topic" : "xiagent")}.xiagent.yaml`, draftToYaml(draft, topics)); setError(""); }
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
      onSuggest={() => void suggest()} onImport={importYaml} onManual={manual} onError={setError} />}
    {step === 1 && <ReviewStep draft={draft} setDraft={setDraft} edit={edit} topics={topics} presets={presets} issues={issues} attempted={attempted}
      notes={notes} matches={matches} handle={handleTaken ? handle : null} />}
    {draft.target === "agent" && step === 2 && <ScheduleForm value={draft.schedule} onChange={schedule => edit({ schedule })} />}
    {draft.target === "agent" && step === 3 && <section className="space-y-3">
      <p className="text-sm text-muted-foreground">Bloub attribué par défaut à ce ΞAgent (facultatif). Vous pouvez le garder tel quel ou le personnaliser ; il reste modifiable depuis la page du ΞAgent.</p>
      <BloubEditor value={draft.bloub} onChange={bloub => edit({ bloub })} name={draft.name || "ce ΞAgent"} />
      <Button type="button" variant="outline" size="sm" onClick={() => edit({ bloub: bloubFromSeed(randomSeed()) })}>Tirer un autre Bloub</Button>
    </section>}
    {last && <Summary draft={draft} topics={topics} />}

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
function Section({ title, summary, origin, issues, open, onToggle, children }: {
  title: string; summary: string; origin: Origin | null; issues: DraftIssue[]; open: boolean; onToggle: (open: boolean) => void; children: ReactNode;
}) {
  return <details open={open} onToggle={event => onToggle(event.currentTarget.open)} className={`rounded-md border p-3 ${issues.length ? "border-destructive/60" : ""}`}>
    <summary className="cursor-pointer">
      <span className="font-medium">{title}</span>
      {issues.length > 0 && <span className="ml-2 text-xs font-medium text-destructive">{issues.length} erreur(s)</span>}
      <span className="block break-words text-xs text-muted-foreground">{summary}{origin ? ` · ${ORIGIN_LABELS[origin]}` : ""}</span>
    </summary>
    <div className="mt-3 space-y-3">
      {issues.length > 0 && <ul className="list-inside list-disc text-xs text-destructive">{issues.map((issue, index) => <li key={index}>{issue.message}</li>)}</ul>}
      {children}
    </div>
  </details>;
}

function TopicEditor({ pick, picks, topics, onChange, onRemove, label }: { pick: TopicPick; picks: TopicPick[]; topics: Topic[]; onChange: (pick: TopicPick) => void; onRemove?: () => void; label: string }) {
  const id = useId();
  const missing = isMissing(pick, topics);
  const value = missing ? "" : pick.type === "existing" ? pick.id : "new";
  const missingTag = pick.type === "unresolved" ? pick.tag : null;
  return <div className={`space-y-2 rounded-md border p-2 ${missing ? "border-destructive/60" : ""}`}>
    {missing && <div role="alert" className="space-y-1 text-xs text-destructive">
      <p className="font-medium">Topic introuvable{missingTag ? ` : ${missingTag}` : ""}. La référence est conservée telle quelle, mais elle ne peut pas être déployée.</p>
      <p>Remplacez-la par un topic existant{missingTag ? ", créez-la comme nouveau topic" : ""}{onRemove ? " ou retirez-la" : ""}. Aucun autre topic ne prend sa place automatiquement.</p>
      {missingTag && <Button type="button" size="sm" variant="outline" onClick={() => onChange(topicFromTag(missingTag, picks, topics))}>Créer « {missingTag} » comme nouveau topic</Button>}
    </div>}
    <div className="flex items-end gap-2">
      <label className="grid flex-1 gap-1 text-sm">{label}
        <select className={selectClass} value={value} onChange={event => onChange(event.target.value === "new" ? { type: "new", key: pick.type === "new" ? pick.key : newTopicKey(picks), draft: pick.type === "new" ? pick.draft : emptyTopicDraft() } : { type: "existing", id: event.target.value })}>
          {missing && <option value="" disabled>À remplacer…</option>}
          <option value="new">Nouveau topic…</option>
          {topics.map(topic => <option key={topic.id} value={topic.id}>{topic.name} · {topic.tag}</option>)}
        </select>
      </label>
      {onRemove && <Button type="button" size="sm" variant="ghost" onClick={onRemove}>Retirer</Button>}
    </div>
    {pick.type === "existing" && !missing && <p className="text-xs text-muted-foreground">Topic existant réutilisé (aucun doublon). {pick.reason ?? ""} Périmètre : {topics.find(topic => topic.id === pick.id)?.scope.slice(0, 240) ?? "topic introuvable"}</p>}
    {pick.type === "new" && <div className="grid gap-2 sm:grid-cols-2">
      <label className="grid gap-1 text-xs">Nom du topic<Input value={pick.draft.name} maxLength={160} onChange={event => onChange({ ...pick, draft: { ...pick.draft, name: event.target.value } })} /></label>
      <label className="grid gap-1 text-xs">Étiquette du topic (minuscules, points pour la hiérarchie)<Input value={pick.draft.tag} maxLength={180} onChange={event => onChange({ ...pick, draft: { ...pick.draft, tag: event.target.value.toLowerCase() } })} aria-describedby={`${id}-tag`} /><span id={`${id}-tag`} className="text-muted-foreground">Exemple : science.longevite</span></label>
      <label className="grid gap-1 text-xs sm:col-span-2">Périmètre du topic<Textarea rows={2} maxLength={4000} value={pick.draft.scope} onChange={event => onChange({ ...pick, draft: { ...pick.draft, scope: event.target.value } })} /></label>
      <label className="grid gap-1 text-xs sm:col-span-2">Topic parent (facultatif)
        <select className={selectClass} value={pick.draft.parentId ?? ""} onChange={event => onChange({ ...pick, draft: { ...pick.draft, parentId: event.target.value || null } })}>
          <option value="">Aucun</option>{topics.map(topic => <option key={topic.id} value={topic.id}>{topic.name} · {topic.tag}</option>)}
        </select>
      </label>
      {topics.some(topic => topic.tag === pick.draft.tag || topic.aliases.includes(pick.draft.tag)) && <p role="alert" className="text-xs text-destructive sm:col-span-2">Cette étiquette existe déjà : sélectionnez le topic existant.</p>}
    </div>}
  </div>;
}

function ReviewStep({ draft, setDraft, edit, topics, presets, issues, attempted, notes, matches, handle }: {
  draft: AgentDraft; setDraft: (update: (draft: AgentDraft) => AgentDraft) => void; edit: (patch: DraftPatch) => void; topics: Topic[]; presets: Preset[];
  issues: DraftIssue[]; attempted: boolean; notes: { origin: Origin; lines: string[] } | null; matches: Match[]; handle: HandleCheck;
}) {
  const [url, setUrl] = useState("");
  const manual = Object.values(draft.provenance).every(origin => origin === "default" || origin === "manual") && !notes;
  const [opened, setOpened] = useState<Record<string, boolean>>(() => manual ? { identity: true, topics: true, editorial: true, sources: true } : {} as Record<string, boolean>);
  const sectionIssues = (section: DraftSection) => issues.filter(issue => issue.section === section);
  // Sections with errors open once the owner tries to go on; otherwise the review stays compact.
  const isOpen = (section: Exclude<DraftSection, "schedule">) => opened[section] ?? ((attempted && sectionIssues(section).length > 0) || (section === "identity" && !!handle) || (section === "topics" && draft.topics.some(pick => isMissing(pick, topics))) || (section === "sources" && draft.sources.some(source => source.status === "excluded" && source.origin === "yaml")));
  const toggle = (section: string) => (value: boolean) => setOpened(current => current[section] === value ? current : { ...current, [section]: value });
  const originOf = (section: Exclude<DraftSection, "schedule">): Origin | null => {
    const origins = SECTION_FIELDS[section].map(field => draft.provenance[field]).filter((origin): origin is Origin => !!origin);
    return origins.includes("manual") ? "manual" : origins[0] ?? null;
  };
  const topicName = (pick: TopicPick) => topicLabel(pick, topics);
  const setTopic = (index: number, pick: TopicPick) => edit({ topics: draft.topics.map((item, i) => i === index ? pick : item) });
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

  if (draft.target === "topic") {
    const pick = draft.topics[0];
    return <div className="space-y-3">
      {aiPanel}
      {sectionIssues("topics").length > 0 && attempted && <ul className="text-xs text-destructive">{sectionIssues("topics").map((issue, index) => <li key={index}>{issue.message}</li>)}</ul>}
      {pick?.type === "new" ? <TopicEditor pick={pick} picks={draft.topics} topics={topics} onChange={next => edit({ topics: [next] })} label="Topic à créer" />
        : <p className="text-sm">{pick ? `Un topic existant correspond (${topicName(pick)}) : il n’y a rien à créer.` : "Aucun topic."} <Button type="button" size="sm" variant="outline" onClick={() => edit({ topics: [{ type: "new", key: "new-1", draft: emptyTopicDraft() }] })}>Créer un nouveau topic</Button></p>}
    </div>;
  }

  const approved = draft.sources.filter(source => source.status === "approved").length;
  const excluded = exclusions(draft.sources);
  const undecided = draft.sources.filter(source => source.status === "undecided").length;
  const preset = presets.find(item => presetKey(item) === draft.presetKey);
  const fieldError = (field: DraftField) => attempted ? issues.find(issue => issue.field === field)?.message : undefined;
  return <div className="space-y-3">
    {aiPanel}
    <Section title="Identité" summary={`${draft.name || "Sans nom"} · @${draft.handle || "?"}`} origin={originOf("identity")} issues={sectionIssues("identity")} open={isOpen("identity")} onToggle={toggle("identity")}>
      <Field label="Nom" error={fieldError("name")}>{props => <Input {...props} value={draft.name} maxLength={160} onChange={event => edit({ name: event.target.value })} />}</Field>
      <Field label="Handle unique" hint="Minuscules, chiffres, tirets et points. Sa disponibilité est vérifiée pendant la saisie." error={fieldError("handle") ?? (handle ? `@${handle.handle} est déjà réservé.` : undefined)}>
        {props => <Input {...props} value={draft.handle} maxLength={180} onChange={event => edit({ handle: event.target.value.toLowerCase().replace(/^@/, "") })} />}
      </Field>
      {handle?.alternative && <Button type="button" size="sm" variant="outline" onClick={() => edit({ handle: handle.alternative! })}>Utiliser @{handle.alternative}</Button>}
      <Field label="Description" error={fieldError("about")}>{props => <Textarea {...props} maxLength={4000} value={draft.about} onChange={event => edit({ about: event.target.value })} />}</Field>
    </Section>
    <Section title="Topics" summary={draft.topics.map(topicName).join(" ; ") || "Aucun topic"} origin={originOf("topics")} issues={sectionIssues("topics")} open={isOpen("topics")} onToggle={toggle("topics")}>
      {draft.topics.map((pick, index) => <TopicEditor key={pick.type === "new" ? pick.key : pick.type === "existing" ? `${pick.id}-${index}` : `unresolved-${pick.id ?? pick.tag}-${index}`} pick={pick} picks={draft.topics} topics={topics} label={index === 0 ? "Topic principal" : `Topic secondaire ${index}`} onChange={next => setTopic(index, next)} onRemove={index > 0 ? () => edit({ topics: draft.topics.filter((_, i) => i !== index) }) : undefined} />)}
      {!draft.topics.length && <Button type="button" size="sm" variant="outline" onClick={() => edit({ topics: [topics[0] ? { type: "existing", id: topics[0].id } : { type: "new", key: "new-1", draft: emptyTopicDraft() }] })}>Choisir le topic principal</Button>}
      {draft.topics.length > 0 && draft.topics.length < 6 && <Button type="button" size="sm" variant="outline" onClick={() => {
        const free = topics.find(topic => !draft.topics.some(pick => pick.type === "existing" && pick.id === topic.id));
        edit({ topics: [...draft.topics, free ? { type: "existing", id: free.id } : { type: "new", key: newTopicKey(draft.topics), draft: emptyTopicDraft() }] });
      }}>Ajouter un topic secondaire</Button>}
    </Section>
    <Section title="Périmètre éditorial" summary={draft.perimeter ? draft.perimeter.slice(0, 120) : "Non précisé"} origin={originOf("editorial")} issues={sectionIssues("editorial")} open={isOpen("editorial")} onToggle={toggle("editorial")}>
      <Field label="Périmètre (ce que le ΞAgent couvre et ne couvre pas)" error={fieldError("perimeter")}>{props => <Textarea {...props} rows={3} maxLength={4000} value={draft.perimeter} onChange={event => edit({ perimeter: event.target.value })} />}</Field>
      <Field label="Charte éditoriale propre">{props => <Textarea {...props} rows={3} maxLength={4000} value={draft.charter} onChange={event => edit({ charter: event.target.value })} />}</Field>
      <p className="text-xs text-muted-foreground">S’ajoute à la charte commune : {CHARTER}</p>
    </Section>
    <Section title="Sources" summary={`${approved} approuvée(s), ${excluded.length} exclue(s)${excluded.length ? ` (${excluded.join(", ")})` : ""}, ${undecided} à décider`} origin={originOf("sources")} issues={sectionIssues("sources")} open={isOpen("sources")} onToggle={toggle("sources")}>
      <p className="text-xs text-muted-foreground">Seules les sources approuvées seront collectées ; une source exclue ne sera jamais reproposée. Les sources suggérées ou importées ne sont jamais approuvées automatiquement ; celles non décidées ne sont pas enregistrées.</p>
      {excluded.length > 0 && <p className="text-sm"><span className="font-medium">Exclusions ({excluded.length}) :</span> {excluded.join(", ")}.</p>}
      <ul className="space-y-2" aria-label="Sources du ΞAgent">
        {draft.sources.map((source, index) => <li key={source.url} className="rounded-md border p-2 text-sm">
          <p className="break-all font-medium">{source.domain}</p>
          <p className="text-xs text-muted-foreground">{source.origin === "ai" ? "Suggérée par l’IA — non vérifiée" : source.origin === "yaml" ? "Importée (YAML) — à vérifier" : "Ajoutée par vous"} · {source.type}{source.rationale ? ` · ${source.rationale}` : ""}</p>
          {source.status === "excluded" && <p className="mt-1 text-xs font-medium text-destructive">Exclue{source.origin === "yaml" ? " par le fichier YAML" : ""} : jamais collectée ni reproposée. Pour la réautoriser, choisissez « Approuver » (ou « Ne pas décider »).</p>}
          <fieldset className="mt-1 flex flex-wrap gap-3 text-xs"><legend className="sr-only">Décision pour {source.domain}</legend>
            {(["approved", "excluded", "undecided"] as const).map(status => <label key={status} className="flex items-center gap-1"><input type="radio" name={`source-${index}`} checked={source.status === status} onChange={() => edit({ sources: draft.sources.map((item, i) => i === index ? { ...item, status } : item) })} />{status === "approved" ? "Approuver" : status === "excluded" ? "Exclure" : "Ne pas décider"}</label>)}
            {source.origin !== "ai" && <button type="button" className="underline" onClick={() => edit({ sources: draft.sources.filter((_, i) => i !== index) })}>Retirer</button>}
          </fieldset>
        </li>)}
      </ul>
      <form className="flex gap-2" onSubmit={event => { event.preventDefault(); try { const parsed = new URL(url); if (!["http:", "https:"].includes(parsed.protocol) || draft.sources.some(source => source.domain === parsed.hostname)) return; edit({ sources: [...draft.sources, { url: parsed.href, domain: parsed.hostname, type: "ajoutée manuellement", rationale: "", origin: "user", status: "approved" }] }); setUrl(""); } catch { /* invalid URL: the input shows it */ } }}>
        <Input type="url" placeholder="https://exemple.org/flux.xml" value={url} onChange={event => setUrl(event.target.value)} aria-label="Adresse d’une source à ajouter" />
        <Button type="submit" variant="outline" size="sm">Ajouter</Button>
      </form>
    </Section>
    <Section title="Paramètres avancés" summary={`${preset?.name ?? "Preset ?"} · ${draft.settings?.depth ?? "?"} · ${draft.modelRef || "modèle du serveur"} · publication autonome ${draft.autoPublish ? "oui" : "non"}`} origin={originOf("advanced")} issues={sectionIssues("advanced")} open={isOpen("advanced")} onToggle={toggle("advanced")}>
      <label className="grid gap-1 text-sm">Preset
        <select className={selectClass} value={draft.presetKey} onChange={event => { const next = presets.find(item => presetKey(item) === event.target.value); edit({ presetKey: event.target.value, settings: next?.settings ?? draft.settings }); }}>
          {!preset && <option value={draft.presetKey}>Preset inconnu ({draft.presetKey || "aucun"})</option>}
          {presets.map(item => <option key={presetKey(item)} value={presetKey(item)}>{item.name} · v{item.version}</option>)}
        </select>
      </label>
      {draft.settings && <div className="grid gap-2 sm:grid-cols-2">
        <label className="grid gap-1 text-xs">Ton<Input maxLength={300} value={draft.settings.tone} onChange={event => edit({ settings: { ...draft.settings!, tone: event.target.value } })} /></label>
        <label className="grid gap-1 text-xs">Public visé<Input maxLength={300} value={draft.settings.audience} onChange={event => edit({ settings: { ...draft.settings!, audience: event.target.value } })} /></label>
        <label className="grid gap-1 text-xs sm:col-span-2">Structure<Textarea maxLength={1000} value={draft.settings.structure} onChange={event => edit({ settings: { ...draft.settings!, structure: event.target.value } })} /></label>
        <label className="grid gap-1 text-xs">Profondeur<select className={selectClass} value={draft.settings.depth} onChange={event => edit({ settings: { ...draft.settings!, depth: event.target.value as Settings["depth"] } })}><option value="court">Court</option><option value="standard">Standard</option><option value="approfondi">Approfondi</option></select></label>
      </div>}
      {preset && draft.settings && JSON.stringify(preset.settings) !== JSON.stringify(draft.settings) && <p className="text-xs text-muted-foreground">Paramètres personnalisés pour ce ΞAgent (le preset n’est pas modifié).</p>}
      <label className="grid gap-1 text-sm">Modèle local (facultatif, sinon celui du serveur)<Input maxLength={200} value={draft.modelRef} onChange={event => edit({ modelRef: event.target.value })} /></label>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={draft.autoPublish} onChange={event => edit({ autoPublish: event.target.checked })} />
        <span>Publication autonome des brouillons validés (privée)<span className="block text-xs text-muted-foreground">Uniquement dans le calendrier de publication, si l’opérateur l’autorise. Sinon, les brouillons attendent votre relecture.</span></span></label>
      <p className="text-xs text-muted-foreground">Fuseau, tolérance, rattrapage et événements majeurs se règlent à l’étape Calendriers.</p>
    </Section>
  </div>;
}

/** Labelled control; its hint and error stay outside the label (accessible name) and are announced as its description. */
function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: (props: { id: string; "aria-invalid"?: boolean; "aria-describedby"?: string }) => ReactNode }) {
  const id = useId();
  const described = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(" ") || undefined;
  return <div className="grid gap-1 text-sm">
    <label htmlFor={id}>{label}</label>
    {children({ id, "aria-invalid": error ? true : undefined, "aria-describedby": described })}
    {hint && <span id={`${id}-hint`} className="text-xs text-muted-foreground">{hint}</span>}
    {error && <span id={`${id}-error`} className="text-xs text-destructive">{error}</span>}
  </div>;
}

function Summary({ draft, topics }: { draft: AgentDraft; topics: Topic[] }) {
  const name = (pick: TopicPick) => topicLabel(pick, topics);
  const days = (kind: "watch" | "publish") => draft.schedule[kind].week.map((ranges, index) => `${WEEKDAYS[index].slice(0, 3)} ${describeRanges(ranges)}`).join(" · ");
  const origins = [...new Set(Object.values(draft.provenance).filter(origin => origin !== "default"))];
  return <section aria-label="Récapitulatif" className="space-y-2 rounded-md border p-3 text-sm">
    {draft.target === "topic" ? <p>Topic : {draft.topics[0] ? name(draft.topics[0]) : "aucun"}</p> : <>
      <p><span className="font-medium">{draft.name}</span> @{draft.handle}</p>
      <p>Topics : {draft.topics.map(name).join(" ; ")}</p>
      <p>Sources : {draft.sources.filter(source => source.status === "approved").length} approuvée(s), {draft.sources.filter(source => source.status === "excluded").length} exclue(s), {draft.sources.filter(source => source.status === "undecided").length} non décidée(s) (ignorées).</p>
      {exclusions(draft.sources).length > 0 && <p className="text-xs">Exclusions : {exclusions(draft.sources).join(", ")}.</p>}
      <p>Fuseau : {draft.schedule.timeZone}</p>
      <p className="text-xs">Veille : {days("watch")}</p>
      <p className="text-xs">Publication : {days("publish")}</p>
      <p>Publication autonome : {draft.autoPublish ? "oui (privée, selon les règles)" : "non"} · Événements majeurs : {draft.schedule.majorEvents.enabled ? "autorisés" : "non"}</p>
      <p className="text-xs text-muted-foreground">Après un déploiement réussi, le mode automatique est activé : la veille suit les calendriers.</p>
    </>}
    <p className="text-xs text-muted-foreground">Origine : {origins.length ? origins.map(origin => ORIGIN_LABELS[origin]).join(", ") : "valeurs par défaut"}{draft.model ? ` (modèle ${draft.model})` : ""}.</p>
  </section>;
}
