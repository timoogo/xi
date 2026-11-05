import { z } from "zod";
import type { Topic } from "../topics/types";
import { applySuggestion, DRAFT_FIELDS, editDraft, type AgentDraft, type DraftField, type DraftPatch } from "../xiagents/draft";
import type { Proposal, TopicPatch } from "./types";

/**
 * Konstruktor's interactive preview, client-safe and pure. The draft shown is rebuilt from the
 * configuration read (`base`), the proposal fields the owner accepts (in conversation order, through
 * `applySuggestion`), then the owner's own edits (`editDraft`: marked manual). A manual edit is
 * therefore never overwritten by a proposal; where they disagree, the conflict is listed so the
 * owner can keep their value or take the proposal back (by dropping their edit).
 */
/** Accepted fields of each proposal (absent: none). */
export type Selection = Record<string, string[]>;

/**
 * The owner's unfinished preview, saved per conversation so a reload finds it again: accepted
 * fields, manual edits (whose provenance is "manual" by construction; accepted fields are "ai",
 * the rest "existing") and, for a ΞAgent to create, what its new draft was built from. It is
 * only a draft of choices: saving it never writes a configuration.
 */
export const previewStateSchema = z.object({
  selection: z.record(z.uuid(), z.array(z.string().max(40)).max(20)),
  manual: z.partialRecord(z.enum(DRAFT_FIELDS), z.unknown()),
  topicManual: z.object({ name: z.string().max(160), scope: z.string().max(4_000), description: z.string().max(4_000) }).partial().strict(),
  seed: z.string().regex(/^[0-9a-f]{32}$/).nullable(),
  timeZone: z.string().max(100).nullable(),
}).strict();
export type PreviewState = z.infer<typeof previewStateSchema>;
export type Conflict = { field: string; proposalId: string; proposed: unknown };

/** Proposals the preview may still take: not refused and not already applied. */
export const pending = (proposals: Proposal[]) => proposals.filter(proposal => proposal.status === "proposed" || proposal.status === "failed" || proposal.status === "accepted");
export const proposalFields = (proposal: Proposal) => Object.keys(proposal.change.patch);
/** Every field of every pending proposal, accepted by default. */
export const selectAll = (proposals: Proposal[]): Selection => Object.fromEntries(pending(proposals).map(proposal => [proposal.id, proposalFields(proposal)]));

const pick = <T extends object>(patch: T, fields: string[] | undefined) => Object.fromEntries(Object.entries(patch).filter(([key]) => fields?.includes(key))) as T;
const differs = (a: unknown, b: unknown) => JSON.stringify(a) !== JSON.stringify(b);

export function previewDraft(base: AgentDraft, proposals: Proposal[], selection: Selection, manual: DraftPatch) {
  let draft = base;
  const conflicts: Conflict[] = [];
  for (const proposal of pending(proposals)) {
    if (proposal.change.type === "topic-edit") continue;
    const patch = pick(proposal.change.patch, selection[proposal.id]);
    for (const [field, value] of Object.entries(patch)) if (field in manual && differs(manual[field as DraftField], value)) conflicts.push({ field, proposalId: proposal.id, proposed: value });
    draft = applySuggestion(draft, patch, "ai", proposal.model);
  }
  return { draft: Object.keys(manual).length ? editDraft(draft, manual) : draft, conflicts };
}

export type TopicField = keyof TopicPatch;
export const TOPIC_FIELDS: TopicField[] = ["name", "scope", "description"];
/** Same rule for an existing topic: current values, accepted proposal fields, then the owner's edits. */
export function previewTopic(topic: Topic, proposals: Proposal[], selection: Selection, manual: TopicPatch) {
  const values: Required<TopicPatch> = { name: topic.name, scope: topic.scope, description: topic.description };
  const origins: Record<TopicField, "existing" | "ai" | "manual"> = { name: "existing", scope: "existing", description: "existing" };
  const conflicts: Conflict[] = [];
  let model: string | null = null;
  for (const proposal of pending(proposals)) {
    if (proposal.change.type !== "topic-edit") continue;
    for (const [field, value] of Object.entries(pick(proposal.change.patch, selection[proposal.id])) as [TopicField, string][]) {
      if (field in manual && manual[field] !== value) conflicts.push({ field, proposalId: proposal.id, proposed: value });
      values[field] = value; origins[field] = "ai"; model = proposal.model;
    }
  }
  for (const [field, value] of Object.entries(manual) as [TopicField, string][]) { values[field] = value; origins[field] = "manual"; }
  const patch = Object.fromEntries(TOPIC_FIELDS.filter(field => values[field] !== topic[field]).map(field => [field, values[field]])) as TopicPatch;
  return { values, origins, patch, conflicts, model };
}

/** Proposals with at least one accepted field: validated by the application. */
export const acceptedIds = (proposals: Proposal[], selection: Selection) => pending(proposals).filter(proposal => selection[proposal.id]?.length).map(proposal => proposal.id);
