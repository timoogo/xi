import { z } from "zod";
import type { Draft } from "../topics/types";
import type { DraftPatch } from "../xiagents/draft";

/**
 * Konstruktor conversations, client-safe types. A session belongs to one user and one target: an
 * existing Topic or ΞAgent the user may read, or a ΞAgent / Topic to create. Proposals are data:
 * the owner reviews them in a preview and applies what they accept through a deployment, whose
 * state gives each accepted proposal its status.
 */
export const TARGET_TYPES = ["topic", "agent", "new-topic", "new-agent"] as const;
export type TargetType = (typeof TARGET_TYPES)[number];
export const targetSchema = z.discriminatedUnion("type", [
  z.object({ type: z.enum(["topic", "agent"]), id: z.uuid() }).strict(),
  z.object({ type: z.enum(["new-topic", "new-agent"]), id: z.null().default(null) }).strict(),
]);
export type KonstruktorTarget = z.infer<typeof targetSchema>;

/** Editable fields of an existing topic (tag, hierarchy and relations stay with the topic tools). */
export type TopicPatch = Partial<Pick<Draft, "name" | "scope" | "description">>;
/**
 * A change proposed by the model, kept in the creation flow's own vocabulary: `DraftPatch` for a
 * ΞAgent (or a topic to create), to be merged with `applySuggestion(…, "ai", model)` so the owner's
 * manual fields are never overwritten.
 */
export type ProposedChange =
  | { type: "agent-draft"; agentId: string | null; patch: DraftPatch }
  | { type: "topic-draft"; patch: DraftPatch }
  | { type: "topic-edit"; topicId: string; patch: TopicPatch };
/** `accepted`: part of an application still running (or interrupted: it can be resumed). */
export type ProposalStatus = "proposed" | "refused" | "accepted" | "applied" | "failed";
export type Proposal = {
  id: string; summary: string; origin: "ai"; model: string; status: ProposalStatus; change: ProposedChange;
  /** What the normalisation left out (unknown topic, unavailable model, invalid range…), said to the owner. */
  notes: string[];
  /** The deployment that applies (or applied) it. */
  deploymentId?: string | null;
};
export const PROPOSAL_LABELS: Record<ProposalStatus, string> = {
  proposed: "Proposition non appliquée : rien n’est modifié tant que vous ne l’avez pas validée.", refused: "Proposition refusée.",
  accepted: "Validée : application en cours ou à reprendre.", applied: "Appliquée après votre validation.", failed: "Application interrompue : revoyez-la et relancez-la.",
};

export type KonstruktorMessage = {
  id: string; role: "user" | "assistant"; text: string; createdAt: number;
  /** User turns: the client's idempotency key. Assistant turns: the user message answered. */
  requestId: string | null; replyTo: string | null;
  questions: string[]; proposals: Proposal[];
  /** Requests the model said Ξ cannot configure (never presented as configured). */
  unsupported: string[];
};
/** State of the last turn: queued, model thinking, model unreachable (retry planned), failed, or answered. */
export type TurnState = "pending" | "thinking" | "unavailable" | "error" | "done";
export type TurnStatus = { requestId: string; state: TurnState; message: string | null; retryAt: number | null };
export type SessionSummary = { id: string; target: KonstruktorTarget; title: string; createdAt: number; updatedAt: number; messages: number };
/** `previewSaved`: the owner left a preview in progress (the panel reopens it). */
export type KonstruktorSession = SessionSummary & { history: KonstruktorMessage[]; turn: TurnStatus | null; previewSaved: boolean };

export const TURN_LABELS: Record<TurnState, string> = {
  pending: "En attente du modèle local…", thinking: "Konstruktor réfléchit…", unavailable: "Modèle local indisponible : nouvel essai automatique",
  error: "La réponse n’a pas pu être produite", done: "Réponse disponible",
};
export const MAX_MESSAGE = 4_000;
