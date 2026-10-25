import { accountDraftSchema, profileSchema, type Preset, type Settings } from "../accounts/types";
import { DEFAULT_BLOUB_CONFIG } from "../bloub/config";
import type { BloubConfig } from "../bloub/types";
import { inferenceOptionsSchema, INHERIT_LLM_DRAFT, modelNameSchema, type AgentLLMDraft } from "../llm/types";
import { draftSchema, type Draft, type Topic } from "../topics/types";
import { defaultSchedule, scheduleSchema, type Schedule } from "./schedule";

/**
 * The single configuration draft of the creation flow. Every entry point — rule-based suggestion
 * from a few words, local-model proposal, YAML import, manual entry — produces or edits this same
 * value, validated by `draftIssues` and turned into the deployment input by `draftToSpec`; the
 * server validates that input again (`deploymentSpecSchema`) before anything is written. Pure and
 * client-safe: nothing here is persisted, a draft lives in the dialog until it is deployed.
 *
 * Provenance is kept per field: a suggestion (`applySuggestion`) never overwrites a field the
 * owner edited (`editDraft` marks it `manual`), so a late AI enrichment cannot undo manual choices.
 */
export type Origin = "manual" | "rules" | "ai" | "yaml" | "default";
export const DRAFT_FIELDS = ["name", "handle", "about", "topics", "perimeter", "charter", "presetKey", "settings", "llm", "autoPublish", "sources", "schedule", "bloub"] as const;
export type DraftField = (typeof DRAFT_FIELDS)[number];

/**
 * `unresolved`: a reference kept as given (tag from a YAML file, or id of a topic missing from the
 * catalog) so that nothing is silently dropped or promoted; it blocks the deployment until the
 * owner replaces, creates or removes it.
 */
export type TopicPick = { type: "existing"; id: string; reason?: string } | { type: "new"; key: string; draft: Draft } | { type: "unresolved"; tag: string | null; id: string | null };
/** `undecided` sources are never deployed; imported or suggested sources always start undecided. */
export type SourceRow = { url: string; domain: string; type: string; rationale: string; origin: "ai" | "user" | "yaml"; status: "approved" | "excluded" | "undecided" };
export type Target = "agent" | "topic";

export type AgentDraft = {
  target: Target;
  /** Free words or description typed by the owner (input of the suggestions). */
  description: string;
  name: string; handle: string; about: string;
  /** First item: primary topic; others: secondary topics. */
  topics: TopicPick[];
  perimeter: string; charter: string;
  /** `<presetId>:<version>`. */
  presetKey: string; settings: Settings | null; autoPublish: boolean;
  /** Model selection (docs/llm.md): inherit by default; an unresolved YAML instance key blocks the deployment. */
  llm: AgentLLMDraft;
  sources: SourceRow[]; schedule: Schedule; bloub: BloubConfig;
  provenance: Partial<Record<DraftField, Origin>>;
  /** Model of the last applied AI proposal (deployment log). */
  model: string | null;
};
export type DraftPatch = Partial<Pick<AgentDraft, DraftField>>;

export const presetKey = (preset: Pick<Preset, "id" | "version">) => `${preset.id}:${preset.version}`;
export const emptyTopicDraft = (): Draft => ({ tag: "", name: "", description: "", scope: "", parentId: null, relatedIds: [] });
/** Keys accepted by the deployment schema (`/^[a-z0-9-]{1,40}$/`), unique within a draft. */
export const newTopicKey = (taken: readonly TopicPick[]) => {
  const keys = new Set(taken.map(pick => pick.type === "new" ? pick.key : ""));
  let index = 1;
  while (keys.has(`new-${index}`)) index++;
  return `new-${index}`;
};

export function newDraft({ presets, timeZone, bloub = DEFAULT_BLOUB_CONFIG, target = "agent" }: { presets: Preset[]; timeZone: string; bloub?: BloubConfig; target?: Target }): AgentDraft {
  const preset = presets[0];
  return {
    target, description: "", name: "", handle: "", about: "", topics: [], perimeter: "", charter: "",
    presetKey: preset ? presetKey(preset) : "", settings: preset?.settings ?? null, llm: INHERIT_LLM_DRAFT, autoPublish: false,
    sources: [], schedule: defaultSchedule(timeZone), bloub,
    provenance: { presetKey: "default", settings: "default", schedule: "default", bloub: "default" }, model: null,
  };
}

/** Owner edit: applied as is and marked manual (protected from later suggestions). */
export function editDraft(draft: AgentDraft, patch: DraftPatch): AgentDraft {
  const provenance = { ...draft.provenance };
  for (const key of Object.keys(patch) as DraftField[]) provenance[key] = "manual";
  return { ...draft, ...patch, provenance };
}

/**
 * Suggestion (rules, AI or import): fills every field the owner has not edited. Sources are merged
 * by domain: existing rows (and their decisions) are kept, new ones are appended undecided.
 */
export function applySuggestion(draft: AgentDraft, patch: DraftPatch, origin: Exclude<Origin, "manual">, model: string | null = null): AgentDraft {
  const next: AgentDraft = { ...draft, provenance: { ...draft.provenance }, model: origin === "ai" ? model : draft.model };
  const skipped: DraftField[] = [];
  for (const key of Object.keys(patch) as DraftField[]) {
    if (patch[key] === undefined) continue;
    if (key === "sources") {
      const known = new Set(next.sources.map(source => source.domain));
      const added = patch.sources!.filter(source => !known.has(source.domain)).map(source => ({ ...source, status: source.status === "excluded" ? "excluded" as const : "undecided" as const }));
      if (added.length) { next.sources = [...next.sources, ...added]; if (next.provenance.sources !== "manual") next.provenance.sources = origin; }
      continue;
    }
    if (draft.provenance[key] === "manual") { skipped.push(key); continue; }
    (next as Record<DraftField, unknown>)[key] = patch[key];
    next.provenance[key] = origin;
  }
  return next;
}
/** Fields a suggestion would change but leaves alone because the owner edited them. */
export const conflicts = (draft: AgentDraft, patch: DraftPatch): DraftField[] =>
  (Object.keys(patch) as DraftField[]).filter(key => key !== "sources" && patch[key] !== undefined && draft.provenance[key] === "manual" && JSON.stringify(patch[key]) !== JSON.stringify(draft[key]));

/** Same rule as the topic store: a new topic's tag directly specialises its parent's tag (or has no dot without parent). */
export function parentTagProblem(draft: Draft, catalog: Topic[]): string | null {
  const parent = draft.parentId ? catalog.find(topic => topic.id === draft.parentId) : undefined;
  if (draft.parentId && !parent) return null;
  const prefix = parent ? `${parent.tag}.` : "";
  if (draft.tag.startsWith(prefix) && !draft.tag.slice(prefix.length).includes(".")) return null;
  return parent ? `L’étiquette ${draft.tag} doit spécialiser directement celle du parent (${parent.tag}.…).` : `L’étiquette ${draft.tag} contient un point : choisissez le topic parent ${draft.tag.split(".").slice(0, -1).join(".")} ou retirez le point.`;
}

export type DraftSection = "identity" | "topics" | "editorial" | "sources" | "advanced" | "schedule";
export type DraftIssue = { section: DraftSection; field?: DraftField; message: string };
const fails = (result: { success: boolean }) => !result.success;

/** Every problem that would block the deployment, located by section (shown next to the fields). */
/** `instances`: the owner's LLM instances, when known (a chosen one must still exist). */
export function draftIssues(draft: AgentDraft, catalog: Topic[], presets?: Preset[], instances?: readonly { id: string }[]): DraftIssue[] {
  const issues: DraftIssue[] = [];
  const add = (section: DraftSection, message: string, field?: DraftField) => issues.push({ section, message, field });
  const news = draft.topics.filter((pick): pick is Extract<TopicPick, { type: "new" }> => pick.type === "new");
  for (const pick of news) {
    if (fails(draftSchema.safeParse(pick.draft))) add("topics", `Topic « ${pick.draft.name || "sans nom"} » : nom, étiquette (minuscules, points pour la hiérarchie) et périmètre sont requis.`, "topics");
    else if (catalog.some(topic => topic.tag === pick.draft.tag || topic.aliases.includes(pick.draft.tag))) add("topics", `L’étiquette ${pick.draft.tag} existe déjà : sélectionnez le topic existant.`, "topics");
    if (pick.draft.parentId && !catalog.some(topic => topic.id === pick.draft.parentId)) add("topics", `Parent introuvable pour le topic « ${pick.draft.name} ».`, "topics");
    else if (pick.draft.tag) { const problem = parentTagProblem(pick.draft, catalog); if (problem) add("topics", problem, "topics"); }
  }
  if (new Set(news.map(pick => pick.draft.tag)).size !== news.length) add("topics", "Deux nouveaux topics ont la même étiquette.", "topics");
  const existing = draft.topics.flatMap(pick => pick.type === "existing" ? [pick.id] : []);
  if (new Set(existing).size !== existing.length) add("topics", "Un topic est sélectionné deux fois.", "topics");
  draft.topics.forEach((pick, index) => {
    const label = index === 0 ? "Topic principal" : `Topic secondaire ${index}`;
    if (pick.type === "unresolved") add("topics", `${label} non résolu${pick.tag ? ` (${pick.tag})` : ""} : remplacez-le par un topic existant, créez-le ou retirez-le.`, "topics");
    else if (pick.type === "existing" && !catalog.some(topic => topic.id === pick.id)) add("topics", `${label} introuvable dans le catalogue : remplacez-le ou retirez-le.`, "topics");
  });
  if (!draft.topics.length) add("topics", "Choisissez un topic principal.", "topics");
  if (draft.target === "topic") { if (draft.topics[0]?.type !== "new") add("topics", "Aucun topic à créer."); return issues; }
  if (draft.topics.length > 31) add("topics", "Trop de topics secondaires.", "topics");
  const shape = accountDraftSchema.shape;
  if (fails(shape.name.safeParse(draft.name))) add("identity", "Nom requis.", "name");
  if (fails(shape.handle.safeParse(draft.handle))) add("identity", "Handle invalide : minuscules, chiffres, tirets et points.", "handle");
  if (fails(shape.description.safeParse(draft.about))) add("identity", "Description trop longue.", "about");
  if (fails(profileSchema.safeParse({ perimeter: draft.perimeter, charter: draft.charter }))) add("editorial", "Périmètre ou charte trop longs (4 000 caractères au plus).", "perimeter");
  if (!draft.settings || !draft.presetKey) add("advanced", "Choisissez un preset.", "presetKey");
  else {
    if (presets && !presets.some(preset => presetKey(preset) === draft.presetKey)) add("advanced", "Preset inconnu : choisissez-en un dans la liste.", "presetKey");
    if (fails(shape.settings.safeParse(draft.settings))) add("advanced", "Ton, structure et public sont requis.", "settings");
  }
  if (draft.llm.unresolvedKey) add("advanced", `Instance « ${draft.llm.unresolvedKey} » introuvable : choisissez une instance ou la configuration globale.`, "llm");
  else if (draft.llm.instanceId && instances && !instances.some(instance => instance.id === draft.llm.instanceId)) add("advanced", "Instance d’intelligence artificielle introuvable : choisissez-en une autre ou la configuration globale.", "llm");
  if (draft.llm.model.trim() && fails(modelNameSchema.safeParse(draft.llm.model))) add("advanced", "Nom de modèle trop long (200 caractères au plus).", "llm");
  if (fails(inferenceOptionsSchema.safeParse(draft.llm.options))) add("advanced", "Paramètres d’inférence invalides (température 0–2, limite 16–32 768 jetons, contexte 512–262 144, délai 5–600 s).", "llm");
  if (draft.sources.length > 50) add("sources", "50 sources au plus.", "sources");
  if (fails(scheduleSchema.safeParse(draft.schedule))) add("schedule", "Calendriers invalides.", "schedule");
  return issues;
}

/** Deployment input (validated again by the server). `undecided` sources are dropped. */
export function draftToSpec(draft: AgentDraft) {
  const ref = (pick: TopicPick) => {
    if (pick.type === "unresolved") throw new Error("Topic non résolu : déploiement impossible.");
    return pick.type === "existing" ? { type: "existing" as const, id: pick.id } : { type: "new" as const, key: pick.key };
  };
  const newTopics = draft.topics.filter((pick): pick is Extract<TopicPick, { type: "new" }> => pick.type === "new").map(pick => ({ key: pick.key, draft: pick.draft }));
  const origins = Object.values(draft.provenance);
  const proposal = { generatedBy: origins.includes("ai") ? "ai" as const : origins.includes("yaml") ? "yaml" as const : origins.includes("rules") ? "rules" as const : "manual" as const, model: origins.includes("ai") ? draft.model : null };
  if (draft.target === "topic") return { target: "topic" as const, newTopics: newTopics.slice(0, 1), agent: null, proposal };
  if (draft.llm.unresolvedKey) throw new Error("Instance d’intelligence artificielle non résolue : déploiement impossible.");
  const [presetId, version] = draft.presetKey.split(":");
  return {
    target: "agent" as const, newTopics, proposal,
    agent: {
      handle: draft.handle, name: draft.name.trim(), description: draft.about.trim(),
      primary: ref(draft.topics[0]), secondary: draft.topics.slice(1).map(ref),
      presetId, presetVersion: Number(version), settings: draft.settings,
      llm: { instanceId: draft.llm.instanceId, model: draft.llm.model.trim() || null, options: draft.llm.options },
      profile: { perimeter: draft.perimeter.trim(), charter: draft.charter.trim() },
      sources: draft.sources.filter(source => source.status !== "undecided").map(source => ({ url: source.url, status: source.status, origin: source.origin === "ai" ? "ai" as const : "user" as const, type: source.type.slice(0, 80), rationale: source.rationale.slice(0, 500) })),
      schedule: draft.schedule, bloub: draft.bloub, autoPublish: draft.autoPublish,
    },
  };
}
