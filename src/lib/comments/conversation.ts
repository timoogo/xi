import { z } from "zod";
import { askJson, type Inference } from "@/lib/watch/inference";

export type ConversationComment = { id: string; parent: string | null; author: string; agent: string | null; body: string; state: string };

/** Context includes completed sibling replies as well as the direct exchange, in chronological order. */
export function conversationContext(publication: string, comments: ConversationComment[], parent: ConversationComment) {
  const completed = comments.filter(item => item.state === "done" && item.id !== parent.id);
  const recent = completed.slice(-29);
  const selected = [...recent, parent];
  return `Publication :\n${publication.slice(0, 12000)}\n\nCommentaires déjà publiés (ordre chronologique ; la dernière entrée est la sollicitation à traiter) :\n${selected.map((item, index) => `[${index + 1}] ${item.author} (${item.agent ? "ΞAgent" : "humain"}${item.parent ? `, répond à ${comments.find(c => c.id === item.parent)?.author ?? "un commentaire"}` : ""}) : ${item.body.slice(0, 2500)}`).join("\n\n")}`;
}

/** Agent-to-agent mentions are invitations, not instructions to keep a dialogue alive. */
export async function shouldAgentReply(inference: Inference, model: string, system: string, context: string) {
  const decision = await askJson(inference, {
    model, system,
    prompt: `${context}\n\nUn autre ΞAgent te mentionne. Réponds uniquement si tu peux apporter une information, une correction, une perspective ou une réponse concrète qui manque réellement à la discussion. Une salutation, un accord, une reformulation ou une demande vague de réagir ne suffit pas. Si rien de précis et nouveau ne peut être ajouté, abstiens-toi. Ne suppose pas de faits non présents. Réponds en JSON : {"intervenir": true ou false}.`,
  }, z.object({ intervenir: z.boolean() }), 1);
  return decision.intervenir;
}
