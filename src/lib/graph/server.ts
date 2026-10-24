import { getAppDatabase } from "../auth";
import { getFeedAuthors, getPublicationStore, getViewer } from "../publications/server";
import type { PublicationStore } from "../publications/store";
import { openVault, vaultPathFromEnv } from "../publications/vault";
import { createGraphRepository } from "./repository";
import { createGraphService, GraphNotFoundError, type GraphService } from "./service";
import type { Viewer } from "./types";

// One service per server process, sharing the publication store (and its locks) with the rest of the app.
const graphGlobal = globalThis as typeof globalThis & { xiGraph?: Promise<GraphService>; xiGraphStore?: Promise<PublicationStore> };

export function getGraphService() {
  // Built on the current publication store: rebuilt when that store is replaced (dev reloads).
  const store = getPublicationStore();
  if (graphGlobal.xiGraphStore !== store) {
    graphGlobal.xiGraph = undefined;
    graphGlobal.xiGraphStore = store;
  }
  graphGlobal.xiGraph ??= Promise.all([store, openVault(vaultPathFromEnv())])
    .then(([publications, vault]) => createGraphService({
      repository: createGraphRepository({ vault, db: getAppDatabase(), publications }), publications,
      authors: (ids, viewer) => viewer ? getFeedAuthors(viewer, ids) : new Map(),
    }))
    .catch((error) => {
      graphGlobal.xiGraph = undefined;
      throw error;
    });
  return graphGlobal.xiGraph;
}

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });

/**
 * Shared shell of the graph routes: identity from the Better Auth session only (401 first), then 400 for invalid
 * input, 404 for anything unreadable, and a generic 500 that logs only the error name (no paths, no content).
 */
export async function graphResponse<T>(
  input: T | null, task: (service: GraphService, viewer: Viewer, input: T) => Promise<unknown>,
  // Injectable for tests only; routes always use the Better Auth session.
  resolveViewer: () => Promise<Viewer | null> = getViewer,
) {
  const viewer = await resolveViewer();
  if (!viewer) return json({ error: "Session requise." }, 401);
  if (input === null) return json({ error: "Requête invalide." }, 400);
  try {
    return json(await task(await getGraphService(), viewer, input));
  } catch (error) {
    if (error instanceof GraphNotFoundError) return json({ error: error.message }, 404);
    console.error("Graph storage error", error instanceof Error ? error.name : "unknown");
    return json({ error: "Le graphe est momentanément indisponible. Veuillez réessayer." }, 500);
  }
}

/** Far above any valid body (60 expanded ids, one connections request), far below a memory problem. */
export const MAX_BODY_BYTES = 64 * 1024;

/**
 * Request bodies are small; anything unparsable or larger than MAX_BODY_BYTES is simply invalid. The body is read
 * incrementally and abandoned past the cap, so neither a lying Content-Length nor a chunked upload is buffered whole.
 */
export async function readJson(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return undefined;
  if (!request.body) return undefined;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}
