import { z } from "zod";
import { getAuth } from "../auth";
import { privateJson } from "../publications/http";
import { getViewer } from "../publications/server";
import { getTopicStore } from "./server";
import { TopicError } from "./types";
import type { TopicStore } from "./store";
export async function topicResponse(request: Request, task: (store: TopicStore, owner: string) => Promise<unknown>) {
  const viewer = await getViewer();
  if (!viewer) return privateJson({ error: "Session requise." }, 401);
  if (request.method !== "GET" && request.headers.get("origin") !== new URL(getAuth().options.baseURL!).origin) return privateJson({ error: "Origine refusée." }, 403);
  try { return privateJson(await task(await getTopicStore(), viewer.id)); }
  catch (error) {
    if (error instanceof TopicError) return privateJson({ error: error.message }, error.status);
    if (error instanceof z.ZodError || error instanceof SyntaxError) return privateJson({ error: "Données invalides. Vérifiez les champs et le tag." }, 400);
    console.error("Topic request failed", error instanceof Error ? error.name : "unknown");
    return privateJson({ error: "Topics indisponibles. Réessayez." }, 503);
  }
}
export async function body(request: Request, maxBytes = 32_000) {
  const reader = request.body?.getReader();
  if (!reader) throw new TopicError("Corps de requête requis.");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) { await reader.cancel(); throw new TopicError("Requête trop volumineuse.", 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
