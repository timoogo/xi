import type { Profile } from "../accounts/types";
import type { Draft, Topic } from "../topics/types";
import { draftToSpec, type AgentDraft, type DraftField } from "./draft";

/**
 * Changes to an existing ΞAgent (or topic), as a deployment of target `edit` (deployments.ts):
 * client-safe. The preview starts from the configuration read with its revisions (`EditBase`,
 * export.ts); only the sections that differ are sent, each written by its own store setter, and
 * only if it has not changed since that read (otherwise 409: the owner reviews the differences).
 */
export type EditRevisions = { editorial: string | null; schedule: string | null; watch: string | null; avatar: string | null; llm: string | null };
export type EditBase = { agentId: string; revisions: EditRevisions; profile: Profile };

export const EDIT_SECTIONS = {
  identity: { label: "Identité et topics", fields: ["name", "handle", "about", "topics", "presetKey", "settings"] },
  profile: { label: "Périmètre et charte", fields: ["perimeter", "charter"] },
  sources: { label: "Sources", fields: ["sources"] },
  schedule: { label: "Calendriers", fields: ["schedule"] },
  llm: { label: "Modèle local", fields: ["llm"] },
  bloub: { label: "Avatar Bloub", fields: ["bloub"] },
  publication: { label: "Publication", fields: ["autoPublish", "limits"] },
} as const satisfies Record<string, { label: string; fields: readonly DraftField[] }>;
export type EditSection = keyof typeof EDIT_SECTIONS;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const newRows = (before: AgentDraft, after: AgentDraft) => after.sources.filter(row => row.status !== "undecided" && !before.sources.some(old => old.domain === row.domain));

/** Sections of `after` that differ from `before` (sources: decided rows for new domains only). */
export function changedSections(before: AgentDraft, after: AgentDraft): EditSection[] {
  return (Object.keys(EDIT_SECTIONS) as EditSection[]).filter(section => section === "sources"
    ? newRows(before, after).length > 0
    : EDIT_SECTIONS[section].fields.some(field => !same(before[field], after[field])));
}

/** Edit deployment input for an existing ΞAgent (validated again, and checked against `base`, by the server). */
export function draftToEditSpec(before: AgentDraft, after: AgentDraft, base: EditBase) {
  const full = draftToSpec({ ...after, sources: newRows(before, after) });
  if (full.target !== "agent") throw new Error("Configuration de ΞAgent attendue.");
  const agent = full.agent;
  const sections = new Set(changedSections(before, after));
  return {
    target: "edit" as const, agentId: base.agentId, topic: null, base: { revisions: base.revisions, profile: base.profile },
    newTopics: sections.has("identity") ? full.newTopics : [],
    changes: {
      ...(sections.has("identity") ? { identity: { handle: agent.handle, name: agent.name, description: agent.description, primary: agent.primary, secondary: agent.secondary, presetId: agent.presetId, presetVersion: agent.presetVersion, settings: agent.settings } } : {}),
      ...(sections.has("profile") ? { profile: agent.profile } : {}),
      ...(sections.has("sources") ? { sources: agent.sources } : {}),
      ...(sections.has("schedule") ? { schedule: agent.schedule } : {}),
      ...(sections.has("llm") ? { llm: agent.llm } : {}),
      ...(sections.has("bloub") ? { bloub: agent.bloub } : {}),
      ...(sections.has("publication") ? { publication: { autoPublish: agent.autoPublish, ...agent.limits } } : {}),
    },
    proposal: full.proposal,
  };
}

/** Edit deployment input for an existing topic: its full draft, written at `topic.revision`. */
export function topicEditSpec(topic: Topic, patch: Partial<Pick<Draft, "name" | "scope" | "description">>, model: string | null) {
  const draft: Draft = { tag: topic.tag, name: topic.name, description: topic.description, scope: topic.scope, parentId: topic.parentId, relatedIds: topic.relatedIds, ...patch };
  return { target: "edit" as const, agentId: null, topic: { id: topic.id, revision: topic.revision, draft }, base: null, newTopics: [], changes: {}, proposal: { generatedBy: model ? "ai" as const : "manual" as const, model } };
}
