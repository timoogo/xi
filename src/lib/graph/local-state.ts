// Per-user navigation state of the graph explorer, kept in IndexedDB (database "xi-graph", store "state", key
// `v1:<userId>`). Only ids and navigation parameters are stored: never message bodies nor excerpts.
// The pure parts (validation, history) are exported for unit tests; storage degrades to a no-op when IndexedDB
// is unavailable (private browsing, blocked storage).

import {
  GRAPH_LIMITS, MESSAGE_REF, SEMANTIC_TYPES, nodeLevel,
  type ConnectionsFilters, type ConnectionsScope, type ExpandRequest, type MessageRef, type NodeId, type NodeLevel, type SemanticType,
} from "./types";

export const LOCAL_STATE_VERSION = 1;
export const HISTORY_LIMIT = 50;

export type LayoutMode = "free" | "hierarchical";
export type Viewport = { x: number; y: number; k: number };
export type MessageHistory = { entries: MessageRef[]; index: number };
export type PanelView = "connections" | "message";
export type PanelState = {
  open: boolean;
  view: PanelView;
  /** Last connections list shown: kept while a message is previewed so the list can be reopened. */
  connections: { scope: ConnectionsScope; filters: ConnectionsFilters } | null;
};
export type GraphFilters = { types: SemanticType[] };

export type GraphLocalState = {
  version: typeof LOCAL_STATE_VERSION;
  mode: LayoutMode;
  viewport: Viewport | null;
  expanded: ExpandRequest[];
  /** Detail lock: deepest level displayed whatever the zoom; null = automatic from the zoom level. */
  lockedLevel: NodeLevel | null;
  filters: GraphFilters;
  selected: NodeId | null;
  panel: PanelState;
  history: MessageHistory;
};

export const MIN_ZOOM = 0.15;
export const MAX_ZOOM = 6;

export function defaultLocalState(): GraphLocalState {
  return {
    version: LOCAL_STATE_VERSION,
    mode: "free",
    viewport: null,
    expanded: [],
    lockedLevel: null,
    filters: { types: [] },
    selected: null,
    panel: { open: false, view: "connections", connections: null },
    history: { entries: [], index: -1 },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Message history: an independent browser-like history inside the side panel.
// ---------------------------------------------------------------------------------------------------------------

export const currentEntry = (history: MessageHistory): MessageRef | null => history.entries[history.index] ?? null;
export const canGoBack = (history: MessageHistory) => history.index > 0;
export const canGoForward = (history: MessageHistory) => history.index >= 0 && history.index < history.entries.length - 1;

/** Opens `ref` after the current entry: the forward branch is discarded, re-opening the current entry is a no-op. */
export function pushHistory(history: MessageHistory, ref: MessageRef, limit = HISTORY_LIMIT): MessageHistory {
  if (currentEntry(history) === ref) return history;
  const entries = [...history.entries.slice(0, history.index + 1), ref].slice(-Math.max(1, limit));
  return { entries, index: entries.length - 1 };
}

export const goBack = (history: MessageHistory): MessageHistory => canGoBack(history) ? { ...history, index: history.index - 1 } : history;
export const goForward = (history: MessageHistory): MessageHistory => canGoForward(history) ? { ...history, index: history.index + 1 } : history;

// ---------------------------------------------------------------------------------------------------------------
// Validation: anything malformed, from another version or another user is discarded (never partially trusted).
// ---------------------------------------------------------------------------------------------------------------

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const NODE_ID = /^(?:g:(?:unassigned|[0-9a-f-]{36})|p:[0-9a-f-]{36}|m:[0-9a-f-]{36}\/[1-9]\d{0,5})$/;
export const isNodeId = (value: unknown): value is NodeId => typeof value === "string" && NODE_ID.test(value) && nodeLevel(value) !== null;
const isMessageRef = (value: unknown): value is MessageRef => typeof value === "string" && MESSAGE_REF.test(value);
const isType = (value: unknown): value is SemanticType => typeof value === "string" && (SEMANTIC_TYPES as readonly string[]).includes(value);
const isLevel = (value: unknown): value is NodeLevel => value === "generator" || value === "publication" || value === "message";
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:\d{2})?)?$/;

function validScope(value: unknown): ConnectionsScope | null {
  if (!isObject(value)) return null;
  if (value.kind === "between") return isNodeId(value.a) && isNodeId(value.b) ? { kind: "between", a: value.a, b: value.b } : null;
  if (value.kind === "internal" || value.kind === "external" || value.kind === "all") return isNodeId(value.node) ? { kind: value.kind, node: value.node } : null;
  return null;
}

function validFilters(value: unknown): ConnectionsFilters | null {
  if (!isObject(value)) return null;
  const filters: ConnectionsFilters = {};
  if (value.types !== undefined) {
    if (!Array.isArray(value.types) || !value.types.every(isType)) return null;
    filters.types = [...new Set(value.types)];
  }
  if (value.generator !== undefined) {
    if (typeof value.generator !== "string" || !/^[0-9a-f-]{36}$/.test(value.generator)) return null;
    filters.generator = value.generator;
  }
  for (const key of ["from", "to"] as const) {
    if (value[key] === undefined) continue;
    const date = value[key];
    if (typeof date !== "string" || !ISO_DATE.test(date)) return null;
    filters[key] = date;
  }
  if (value.needsReview !== undefined) {
    if (typeof value.needsReview !== "boolean") return null;
    filters.needsReview = value.needsReview;
  }
  return filters;
}

/** Returns a clean copy of a stored state, or null when it must be discarded. */
export function validateLocalState(raw: unknown): GraphLocalState | null {
  if (!isObject(raw) || raw.version !== LOCAL_STATE_VERSION) return null;
  const { mode, viewport, expanded, lockedLevel, filters, selected, panel, history } = raw;
  if (mode !== "free" && mode !== "hierarchical") return null;

  let cleanViewport: Viewport | null = null;
  if (viewport !== null) {
    if (!isObject(viewport) || !finite(viewport.x) || !finite(viewport.y) || !finite(viewport.k)) return null;
    if (viewport.k < MIN_ZOOM || viewport.k > MAX_ZOOM || Math.abs(viewport.x) > 1e6 || Math.abs(viewport.y) > 1e6) return null;
    cleanViewport = { x: viewport.x, y: viewport.y, k: viewport.k };
  }

  if (!Array.isArray(expanded) || expanded.length > GRAPH_LIMITS.maxExpanded) return null;
  const cleanExpanded: ExpandRequest[] = [];
  const seen = new Set<string>();
  for (const entry of expanded) {
    if (!isObject(entry) || !isNodeId(entry.id) || nodeLevel(entry.id) === "message" || seen.has(entry.id)) return null;
    if (entry.limit !== undefined && (!Number.isInteger(entry.limit) || (entry.limit as number) < 1 || (entry.limit as number) > GRAPH_LIMITS.maxChildLimit)) return null;
    seen.add(entry.id);
    cleanExpanded.push(entry.limit === undefined ? { id: entry.id } : { id: entry.id, limit: entry.limit as number });
  }

  if (lockedLevel !== null && !isLevel(lockedLevel)) return null;
  if (!isObject(filters) || !Array.isArray(filters.types) || !filters.types.every(isType)) return null;
  if (selected !== null && !isNodeId(selected)) return null;

  if (!isObject(panel) || typeof panel.open !== "boolean" || (panel.view !== "connections" && panel.view !== "message")) return null;
  let connections: PanelState["connections"] = null;
  if (panel.connections !== null) {
    if (!isObject(panel.connections)) return null;
    const scope = validScope(panel.connections.scope);
    const connectionFilters = validFilters(panel.connections.filters);
    if (!scope || !connectionFilters) return null;
    connections = { scope, filters: connectionFilters };
  }

  if (!isObject(history) || !Array.isArray(history.entries) || history.entries.length > HISTORY_LIMIT || !history.entries.every(isMessageRef)) return null;
  if (!Number.isInteger(history.index)) return null;
  const index = history.index as number;
  if (history.entries.length ? index < 0 || index >= history.entries.length : index !== -1) return null;

  return {
    version: LOCAL_STATE_VERSION,
    mode,
    viewport: cleanViewport,
    expanded: cleanExpanded,
    lockedLevel: lockedLevel as NodeLevel | null,
    filters: { types: [...new Set(filters.types as SemanticType[])] },
    selected: selected as NodeId | null,
    panel: { open: panel.open, view: panel.view, connections },
    history: { entries: [...(history.entries as MessageRef[])], index },
  };
}

export const localStateKey = (userId: string) => `v${LOCAL_STATE_VERSION}:${userId}`;

// ---------------------------------------------------------------------------------------------------------------
// IndexedDB storage
// ---------------------------------------------------------------------------------------------------------------

const DB_NAME = "xi-graph";
const STORE = "state";
let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDatabase(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const open = indexedDB.open(DB_NAME, 1);
      open.onupgradeneeded = () => {
        if (!open.result.objectStoreNames.contains(STORE)) open.result.createObjectStore(STORE);
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => resolve(null);
      open.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function run<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return openDatabase().then((db) => new Promise<T | null>((resolve) => {
    if (!db) return resolve(null);
    try {
      const request = action(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  }));
}

/** The stored state of this user, or null (nothing stored, invalid, other version, storage unavailable). */
export async function loadLocalState(userId: string): Promise<GraphLocalState | null> {
  const raw = await run<unknown>("readonly", (store) => store.get(localStateKey(userId)));
  const state = validateLocalState(raw);
  if (raw != null && !state) void run("readwrite", (store) => store.delete(localStateKey(userId)));
  return state;
}

/** Debounced writer: `save` coalesces bursts (zoom, drag), `flush` writes the pending state now. */
export function createLocalStateSaver(userId: string, delay = 400) {
  let pending: GraphLocalState | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const write = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!pending) return;
    const state = pending;
    pending = null;
    void run("readwrite", (store) => store.put(state, localStateKey(userId)));
  };
  return {
    save(state: GraphLocalState) {
      pending = state;
      if (timer) clearTimeout(timer);
      timer = setTimeout(write, delay);
    },
    flush: write,
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
      pending = null;
    },
  };
}
