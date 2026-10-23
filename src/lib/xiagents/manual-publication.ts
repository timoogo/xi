import { testPublicationSummary } from "../publications/test-content";
import { z } from "zod";
import type { AccountStore } from "../accounts/store";
import type { PublicationStore } from "../publications/store";
import type { TopicStore } from "../topics/store";
import { TopicError } from "../topics/types";
import { generateFixture, manualChoiceSchema } from "./generator";

export const manualRequestSchema = z.discriminatedUnion("action", [
  manualChoiceSchema.extend({ action: z.literal("generate") }).strict(),
  manualChoiceSchema.extend({
    action: z.literal("publish"), confirmed: z.literal(true),
    visibility: z.enum(["private", "public"]).default("private"),
    publicConfirmed: z.boolean().default(false),
    messages: z.array(z.string().max(10_000).refine(body => body.trim().length > 0, "Message vide.")).min(1).max(10).optional(),
  }).strict(),
]);

export async function manualPublication(accounts: AccountStore, topics: TopicStore, publications: PublicationStore, owner: string, agentId: string, input: unknown) {
  const request = manualRequestSchema.parse(input);
  const account = await accounts.getOwned(owner, agentId);
  if (!account.editorial?.active) throw new TopicError("Complétez et activez le ΞAgent avant de générer.", 409);
  if (account.editorial.revision !== request.accountRevision) throw new TopicError("Le ΞAgent a changé. Rechargez la page et générez un nouvel aperçu.", 409);
  const topicIds = [account.editorial.primaryTopicId, ...account.editorial.secondaryTopicIds];
  const catalog = await topics.list();
  if (topicIds.some(id => !catalog.some(topic => topic.id === id))) throw new TopicError("Un topic associé n’existe plus. Vérifiez le ΞAgent.", 409);
  const content = generateFixture(request);
  if (request.action === "generate") return { preview: content };
  if (request.visibility === "public" && !request.publicConfirmed) throw new TopicError("Confirmez explicitement la publication publique.");
  if (request.messages && request.messages.length !== request.count) throw new TopicError("Le nombre de messages ne correspond pas à l’aperçu.");
  const publication = await publications.publishGenerated({ id: owner }, agentId, { id: request.seed, summary: testPublicationSummary(request.count), messages: request.messages ?? content.messages, visibility: request.visibility, publicConfirmed: request.publicConfirmed, topicIds });
  return { publication };
}
