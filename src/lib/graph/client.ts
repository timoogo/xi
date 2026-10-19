// Browser-side access to the graph API (see src/lib/graph/types.ts for the contract).
// Errors carry a French message ready for the UI; a 401 sends the browser to the login page.

import { GRAPH_LIMITS, type ConnectionsRequest, type ConnectionsResponse, type ExpandRequest, type MessagePreview, type MessageRef, type ViewRequest, type ViewResponse } from "./types";

export class GraphApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "GraphApiError";
  }
}

export const isAbortError = (error: unknown) => error instanceof DOMException && error.name === "AbortError";

const MESSAGES: Record<number, string> = {
  400: "La requête du graphe est invalide. Rechargez la page.",
  401: "Votre session a expiré. Veuillez vous reconnecter.",
  404: "Cet élément n’existe pas ou ne vous est pas accessible.",
};

async function request<T>(url: string, init: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, credentials: "same-origin", cache: "no-store" });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new GraphApiError("Connexion au serveur impossible. Vérifiez votre réseau puis réessayez.", 0);
  }
  if (response.status === 401 && typeof window !== "undefined") window.location.assign("/auth/login");
  if (!response.ok) throw new GraphApiError(MESSAGES[response.status] ?? "Le graphe est momentanément indisponible. Veuillez réessayer.", response.status);
  try {
    return await response.json() as T;
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new GraphApiError("Réponse du serveur illisible. Veuillez réessayer.", response.status);
  }
}

const postJson = <T>(url: string, body: unknown, signal?: AbortSignal) =>
  request<T>(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });

/** Sorted, deduplicated, clamped, at most GRAPH_LIMITS.maxExpanded entries: the cache key and the body sent. */
export function normalizeViewRequest(view: ViewRequest): ViewRequest {
  const byId = new Map<string, ExpandRequest>();
  for (const { id, limit } of view.expanded) {
    if (typeof id !== "string" || !id || byId.has(id)) continue;
    const clamped = typeof limit === "number" && Number.isFinite(limit) ? Math.min(GRAPH_LIMITS.maxChildLimit, Math.max(1, Math.floor(limit))) : undefined;
    byId.set(id, clamped === undefined || clamped === GRAPH_LIMITS.defaultChildLimit ? { id } : { id, limit: clamped });
  }
  const expanded = [...byId.values()].slice(0, GRAPH_LIMITS.maxExpanded).sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  return { expanded };
}

const VIEW_CACHE_SIZE = 24;
const viewCache = new Map<string, ViewResponse>();

/** Drops every cached view (call after anything that may change the graph). */
export function invalidateViewCache() {
  viewCache.clear();
}

export async function fetchView(view: ViewRequest, options: { signal?: AbortSignal; force?: boolean } = {}): Promise<ViewResponse> {
  const body = normalizeViewRequest(view);
  const key = JSON.stringify(body);
  const cached = options.force ? undefined : viewCache.get(key);
  if (cached) {
    // Re-insert: Map order is the recency order of this small LRU.
    viewCache.delete(key);
    viewCache.set(key, cached);
    return cached;
  }
  const response = await postJson<ViewResponse>("/api/graph/view", body, options.signal);
  viewCache.set(key, response);
  while (viewCache.size > VIEW_CACHE_SIZE) viewCache.delete(viewCache.keys().next().value as string);
  return response;
}

export function fetchConnections(body: ConnectionsRequest, signal?: AbortSignal): Promise<ConnectionsResponse> {
  return postJson<ConnectionsResponse>("/api/graph/connections", body, signal);
}

export function fetchMessage(ref: MessageRef, signal?: AbortSignal): Promise<MessagePreview> {
  return request<MessagePreview>(`/api/graph/message?ref=${encodeURIComponent(ref)}`, { method: "GET", signal });
}
