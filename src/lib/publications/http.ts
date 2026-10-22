import { getPublicationStore, getViewer } from "./server";
import { PublicationError, type PublicationStore } from "./store";
import type { Viewer } from "./types";

export const privateJson = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "private, no-store", Vary: "Cookie" } });

/** Same failure shape for an unknown reference and an unreadable one. */
export async function publicationResponse(
  task: (store: PublicationStore, viewer: Viewer) => Promise<unknown>,
) {
  const viewer = await getViewer();
  if (!viewer) return privateJson({ error: "Session requise." }, 401);
  try {
    return privateJson(await task(await getPublicationStore(), viewer));
  } catch (error) {
    if (error instanceof PublicationError) return privateJson({ error: error.message }, error.code === "stale_cursor" ? 409 : error.code === "invalid" ? 400 : 404);
    console.error("Publication request failed", error instanceof Error ? error.name : "unknown");
    return privateJson({ error: "Les publications sont momentanément indisponibles." }, 503);
  }
}
