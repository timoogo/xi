import { z } from "zod";
import { getAuth } from "../auth";
import { PublicationError } from "../publications/store";
import { privateJson } from "../publications/http";
import { getViewer } from "../publications/server";
import { TopicError } from "../topics/types";
import { getAccountStore } from "./server";
import type { AccountStore } from "./store";
export { body } from "../topics/http";
export async function accountResponse(request: Request, task: (store: AccountStore, owner: string) => Promise<unknown>) {
  const viewer = await getViewer();
  if (!viewer) return privateJson({ error: "Session requise." }, 401);
  if (request.method !== "GET" && request.headers.get("origin") !== new URL(getAuth().options.baseURL!).origin) return privateJson({ error: "Origine refusée." }, 403);
  try { return privateJson(await task(await getAccountStore(), viewer.id)); }
  catch (error) {
    if (error instanceof PublicationError) return privateJson({ error: error.message }, error.code === "not_found" ? 404 : error.code === "rate_limited" ? 429 : 400);
    if (error instanceof TopicError) return privateJson({ error: error.message }, error.status);
    if (error instanceof z.ZodError || error instanceof SyntaxError) return privateJson({ error: "Données invalides. Vérifiez les champs." }, 400);
    console.error("Account request failed", error instanceof Error ? error.name : "unknown");
    return privateJson({ error: "Comptes indisponibles. Réessayez." }, 503);
  }
}
