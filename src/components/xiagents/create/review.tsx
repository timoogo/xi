"use client";

import { useId, useState, type ReactNode } from "react";
import type { InstanceChoice } from "@/components/llm/format";
import { LLMDraftPicker, llmDraftSummary } from "@/components/llm/llm-draft-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { CHARTER, type Preset, type Settings } from "@/lib/accounts/types";
import type { Topic } from "@/lib/topics/types";
import { describeRanges, WEEKDAYS } from "@/lib/xiagents/calendar";
import { emptyTopicDraft, newTopicKey, presetKey, type AgentDraft, type DraftField, type DraftIssue, type DraftPatch, type DraftSection, type Origin, type SourceRow, type TopicPick } from "@/lib/xiagents/draft";

/**
 * Review of a configuration draft, extracted from the creation flow so that Konstruktor's preview
 * shows and edits the same sections, with the same provenance labels and validation messages.
 */
export const selectClass = "w-full rounded-md border bg-background px-3 py-2 text-sm";
export type LLMChoices = { instances: InstanceChoice[] | null; defaultInstanceId: string | null };
export type HandleCheck = { handle: string; available: boolean; alternative?: string | null } | null;
export const FIELD_LABELS: Record<DraftField, string> = { name: "nom", handle: "handle", about: "description", topics: "topics", perimeter: "périmètre", charter: "charte", presetKey: "preset", settings: "style", llm: "intelligence artificielle", autoPublish: "publication autonome", limits: "limites de publication", sources: "sources", schedule: "calendriers", bloub: "Bloub" };
export const SECTION_FIELDS: Record<Exclude<DraftSection, "schedule">, DraftField[]> = {
  identity: ["name", "handle", "about"], topics: ["topics"], editorial: ["perimeter", "charter"], sources: ["sources"], advanced: ["presetKey", "settings", "llm", "autoPublish", "limits"],
};
export const SOURCE_ORIGINS: Record<SourceRow["origin"], string> = { ai: "suggérée par l’IA", yaml: "importée (YAML)", user: "ajoutée par vous" };
/** Excluded sources, with their provenance: listed wherever sources are summarised. */
export const exclusions = (sources: SourceRow[]) => sources.filter(source => source.status === "excluded").map(source => `${source.domain} (${SOURCE_ORIGINS[source.origin]})`);
export const ORIGIN_LABELS: Record<Origin, string> = { manual: "Modifié par vous", rules: "Suggéré (mots-clés, sans IA)", ai: "Suggéré par l’IA locale", yaml: "Importé (YAML)", default: "Valeurs par défaut", existing: "Valeur actuelle" };

/** One line per topic reference, missing ones said as such (never hidden). */
export function topicLabel(pick: TopicPick, topics: Topic[]) {
  if (pick.type === "new") return `${pick.draft.name || "sans nom"}${pick.draft.tag ? ` · ${pick.draft.tag}` : ""} (nouveau)`;
  const found = pick.id ? topics.find(topic => topic.id === pick.id) : undefined;
  if (pick.type === "existing" && found) return `${found.name} (existant)`;
  return `${pick.type === "unresolved" && pick.tag ? pick.tag : "topic inconnu"} (introuvable)`;
}
export const isMissing = (pick: TopicPick, topics: Topic[]) => pick.type === "unresolved" || (pick.type === "existing" && !topics.some(topic => topic.id === pick.id));
/** New topic prefilled from a missing reference's tag (parent linked when its prefix exists). */
export function topicFromTag(tag: string, picks: TopicPick[], topics: Topic[]): TopicPick {
  const last = tag.split(".").at(-1)!.replace(/-/g, " ");
  const name = last.charAt(0).toUpperCase() + last.slice(1);
  const parent = tag.includes(".") ? topics.find(topic => topic.tag === tag.split(".").slice(0, -1).join(".")) : undefined;
  return { type: "new", key: newTopicKey(picks), draft: { ...emptyTopicDraft(), tag, name, scope: `Actualités, travaux et analyses relevant de « ${name} ».`, parentId: parent?.id ?? null } };
}

export function Section({ title, summary, origin, issues, open, onToggle, children }: {
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

export function TopicEditor({ pick, picks, topics, onChange, onRemove, label }: { pick: TopicPick; picks: TopicPick[]; topics: Topic[]; onChange: (pick: TopicPick) => void; onRemove?: () => void; label: string }) {
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

/**
 * The editable sections of a draft (identity, topics, editorial, sources, advanced), shared by the
 * creation flow and Konstruktor's preview. Each section says where its values come from
 * (`Origin`); every edit goes through `edit` (`editDraft`: marked manual, never overwritten).
 */
export function DraftSections({ draft, edit, topics, presets, issues, attempted, handle, llm, expand }: {
  draft: AgentDraft; edit: (patch: DraftPatch) => void; topics: Topic[]; presets: Preset[];
  issues: DraftIssue[]; attempted: boolean; handle: HandleCheck; llm: LLMChoices; expand: boolean;
}) {
  const [url, setUrl] = useState("");
  const [opened, setOpened] = useState<Record<string, boolean>>(() => expand ? { identity: true, topics: true, editorial: true, sources: true } : {} as Record<string, boolean>);
  const sectionIssues = (section: DraftSection) => issues.filter(issue => issue.section === section);
  // Sections with errors open once the owner tries to go on; otherwise the review stays compact.
  const isOpen = (section: Exclude<DraftSection, "schedule">) => opened[section] ?? ((attempted && sectionIssues(section).length > 0) || (section === "identity" && !!handle) || (section === "topics" && draft.topics.some(pick => isMissing(pick, topics))) || (section === "sources" && draft.sources.some(source => source.status === "excluded" && source.origin === "yaml")) || (section === "advanced" && !!draft.llm.unresolvedKey));
  const toggle = (section: string) => (value: boolean) => setOpened(current => current[section] === value ? current : { ...current, [section]: value });
  const originOf = (section: Exclude<DraftSection, "schedule">): Origin | null => {
    const origins = SECTION_FIELDS[section].map(field => draft.provenance[field]).filter((origin): origin is Origin => !!origin);
    return origins.includes("manual") ? "manual" : origins[0] ?? null;
  };
  const topicName = (pick: TopicPick) => topicLabel(pick, topics);
  const setTopic = (index: number, pick: TopicPick) => edit({ topics: draft.topics.map((item, i) => i === index ? pick : item) });

  if (draft.target === "topic") {
    const pick = draft.topics[0];
    return <div className="space-y-3">
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
    <Section title="Paramètres avancés" summary={`${preset?.name ?? "Preset ?"} · ${draft.settings?.depth ?? "?"} · ${llmDraftSummary(draft.llm, llm.instances)} · publication autonome ${draft.autoPublish ? "oui" : "non"} · ${draft.limits.maxPerDay}/jour au plus`} origin={originOf("advanced")} issues={sectionIssues("advanced")} open={isOpen("advanced")} onToggle={toggle("advanced")}>
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
      <LLMDraftPicker value={draft.llm} onChange={value => edit({ llm: value })} instances={llm.instances} defaultInstanceId={llm.defaultInstanceId} error={fieldError("llm")} />
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={draft.autoPublish} onChange={event => edit({ autoPublish: event.target.checked })} />
        <span>Publication autonome des brouillons validés (privée)<span className="block text-xs text-muted-foreground">Uniquement dans le calendrier de publication, si l’opérateur l’autorise. Sinon, les brouillons attendent votre relecture.</span></span></label>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="grid gap-1 text-xs">Publications par jour (au plus)<Input type="number" min={1} max={24} value={draft.limits.maxPerDay} onChange={event => edit({ limits: { ...draft.limits, maxPerDay: Number(event.target.value) } })} /></label>
        <label className="grid gap-1 text-xs">Intervalle minimal entre deux publications (minutes)<Input type="number" min={15} max={10_080} value={draft.limits.minIntervalMinutes} onChange={event => edit({ limits: { ...draft.limits, minIntervalMinutes: Number(event.target.value) } })} /></label>
      </div>
      <p className="text-xs text-muted-foreground">Fuseau, tolérance, rattrapage et événements majeurs se règlent à l’étape Calendriers.</p>
    </Section>
  </div>;
}

/** Labelled control; its hint and error stay outside the label (accessible name) and are announced as its description. */
export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: (props: { id: string; "aria-invalid"?: boolean; "aria-describedby"?: string }) => ReactNode }) {
  const id = useId();
  const described = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(" ") || undefined;
  return <div className="grid gap-1 text-sm">
    <label htmlFor={id}>{label}</label>
    {children({ id, "aria-invalid": error ? true : undefined, "aria-describedby": described })}
    {hint && <span id={`${id}-hint`} className="text-xs text-muted-foreground">{hint}</span>}
    {error && <span id={`${id}-error`} className="text-xs text-destructive">{error}</span>}
  </div>;
}

export function Summary({ draft, topics, instances }: { draft: AgentDraft; topics: Topic[]; instances: InstanceChoice[] | null }) {
  const name = (pick: TopicPick) => topicLabel(pick, topics);
  const days = (kind: "watch" | "publish") => draft.schedule[kind].week.map((ranges, index) => `${WEEKDAYS[index].slice(0, 3)} ${describeRanges(ranges)}`).join(" · ");
  const origins = [...new Set(Object.values(draft.provenance).filter(origin => origin !== "default"))];
  return <section aria-label="Récapitulatif" className="space-y-2 rounded-md border p-3 text-sm">
    {draft.target === "topic" ? <p>Topic : {draft.topics[0] ? name(draft.topics[0]) : "aucun"}</p> : <>
      <p><span className="font-medium">{draft.name}</span> @{draft.handle}</p>
      <p>Topics : {draft.topics.map(name).join(" ; ")}</p>
      <p>Sources : {draft.sources.filter(source => source.status === "approved").length} approuvée(s), {draft.sources.filter(source => source.status === "excluded").length} exclue(s), {draft.sources.filter(source => source.status === "undecided").length} non décidée(s) (ignorées).</p>
      {exclusions(draft.sources).length > 0 && <p className="text-xs">Exclusions : {exclusions(draft.sources).join(", ")}.</p>}
      <p>Intelligence artificielle : {llmDraftSummary(draft.llm, instances)}</p>
      <p>Fuseau : {draft.schedule.timeZone}</p>
      <p className="text-xs">Veille : {days("watch")}</p>
      <p className="text-xs">Publication : {days("publish")}</p>
      <p>Publication autonome : {draft.autoPublish ? "oui (privée, selon les règles)" : "non"} · au plus {draft.limits.maxPerDay} par jour, {draft.limits.minIntervalMinutes} min d’intervalle · Événements majeurs : {draft.schedule.majorEvents.enabled ? "autorisés" : "non"}</p>
      <p className="text-xs text-muted-foreground">Après un déploiement réussi, le mode automatique est activé : la veille suit les calendriers.</p>
    </>}
    <p className="text-xs text-muted-foreground">Origine : {origins.length ? origins.map(origin => ORIGIN_LABELS[origin]).join(", ") : "valeurs par défaut"}{draft.model ? ` (modèle ${draft.model})` : ""}.</p>
  </section>;
}
