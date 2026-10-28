import { z } from "zod";

export const tagSchema = z.string().min(1).max(180).regex(/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/);
export const draftSchema = z.object({
  tag: tagSchema, name: z.string().trim().min(1).max(160), description: z.string().trim().max(4000),
  scope: z.string().trim().min(1).max(4000), parentId: z.uuid().nullable(), relatedIds: z.array(z.uuid()).max(30),
});
export const topicSchema = draftSchema.extend({
  id: z.uuid(), aliases: z.array(tagSchema), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
  createdBy: z.string().min(1), updatedBy: z.string().min(1), revision: z.uuid(),
});
/**
 * Personal topic: same shape plus its owner, stored privately per user (never in `topics/` nor its SQLite index).
 * It reserves no tag in the shared catalogue; its immutable UUID is kept if it is later promoted.
 */
export const personalTopicSchema = topicSchema.extend({ owner: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) });
export type Draft = z.infer<typeof draftSchema>;
export type Topic = z.infer<typeof topicSchema>;
export type PersonalTopic = z.infer<typeof personalTopicSchema>;
export const isPersonal = (topic: Topic): topic is PersonalTopic => "owner" in topic && typeof topic.owner === "string";
export const STEP_NAMES = ["Analyse de l’intention", "Recherche des topics existants", "Identification du parent", "Proposition du tag", "Définition du scope", "Relations transversales", "Confirmation humaine", "Écriture Markdown", "Indexation SQLite", "Actualisation du routage parent", "Vérification de l’intégrité"];
export type Step = { name: string; status: "pending" | "running" | "waiting" | "completed" | "failed"; startedAt?: number; finishedAt?: number; result?: unknown; error?: string };
export type RunEvent = { id: number; step: number; status: Step["status"]; at: number; result?: unknown; error?: string };
export type Run = { subject?: string; missingParents?: { tag: string; name: string; scope: string }[]; existingTopicId?: string; parentRunId?: string; returnRunId?: string; id: string; owner: string; intent: string; state: "waiting" | "running" | "failed" | "completed" | "cancelled"; draft: Draft; matches: string[]; topicId: string; steps: Step[]; events: RunEvent[]; confirmed: boolean };
export class TopicError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
