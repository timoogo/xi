import { z } from "zod";
import { getAuth } from "../auth";
import { privateJson } from "../publications/http";
import { getViewer } from "../publications/server";
import { TopicError } from "../topics/types";
import { getSystemAgentStore } from "./server";
import type { SystemAgentStore } from "./store";
export { body } from "../topics/http";

/** Session and Origin checks of the other ΞAgent routes; errors mapped the same way. */
export async function systemAgentResponse(request: Request, task: (store: SystemAgentStore, userId: string) => Promise<unknown>) {
  const viewer = await getViewer();
  if (!viewer) return privateJson({ error: "Session requise." }, 401);
  if (request.method !== "GET" && request.headers.get("origin") !== new URL(getAuth().options.baseURL!).origin) return privateJson({ error: "Origine refusée." }, 403);
  try { return privateJson(await task(await getSystemAgentStore(), viewer.id)); }
  catch (error) {
    if (error instanceof TopicError) return privateJson({ error: error.message }, error.status);
    if (error instanceof z.ZodError || error instanceof SyntaxError) return privateJson({ error: "Données invalides. Vérifiez les champs." }, 400);
    console.error("System agent request failed", error instanceof Error ? error.name : "unknown");
    return privateJson({ error: "Agents systèmes indisponibles. Réessayez." }, 503);
  }
}
