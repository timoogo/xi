import { z } from "zod";
import type { AccountStore } from "../accounts/store";
import { getAccountStore } from "../accounts/server";
import { getAuth } from "../auth";
import { privateJson } from "../publications/http";
import { getViewer } from "../publications/server";
import { TopicError } from "../topics/types";
import { InferenceConfigError } from "../watch/inference";
import { getLLMRuntime, type LLMRuntime } from "./server";
export { deleteInstance, instanceDependencies } from "./server";
import { LLMStoreError } from "./store";
export { body } from "../topics/http";

type Context = { runtime: LLMRuntime; accounts: () => Promise<AccountStore>; owner: string };

/** Owner-only LLM routes: session required, same-origin writes, another owner's data is "introuvable". */
export async function llmResponse(request: Request, task: (context: Context) => Promise<unknown>) {
  const viewer = await getViewer();
  if (!viewer) return privateJson({ error: "Session requise." }, 401);
  if (request.method !== "GET" && request.headers.get("origin") !== new URL(getAuth().options.baseURL!).origin) return privateJson({ error: "Origine refusée." }, 403);
  try { return privateJson(await task({ runtime: getLLMRuntime(), accounts: getAccountStore, owner: viewer.id })); }
  catch (error) {
    if (error instanceof LLMStoreError) return privateJson({ error: error.message, ...error.data }, error.status);
    if (error instanceof TopicError) return privateJson({ error: error.message }, error.status);
    if (error instanceof InferenceConfigError) return privateJson({ error: error.message, code: error.code }, 400);
    if (error instanceof z.ZodError || error instanceof SyntaxError) return privateJson({ error: "Données invalides. Vérifiez les champs." }, 400);
    console.error("LLM request failed", error instanceof Error ? error.name : "unknown");
    return privateJson({ error: "Configuration IA indisponible. Réessayez." }, 503);
  }
}

/** JSON body when one is sent, else `{}` (optional parameters). */
export async function optionalBody(request: Request, maxBytes = 4_000) {
  const text = await request.text();
  if (text.length > maxBytes) throw new TopicError("Requête trop volumineuse.", 413);
  return text.trim() ? JSON.parse(text) : {};
}

