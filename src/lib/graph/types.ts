// Shared contracts of the knowledge graph: server modules, API routes and the browser all import from here.
// Dependency-free so it can be bundled client-side. See docs/graph.md for the vault format and the rules.

import type { Visibility } from "../publications/types";
import type { XiAgentBloub } from "../xiagents/avatar";

export const SEMANTIC_TYPES = ["supports", "contradicts", "expands", "related_to", "updates"] as const;
export type SemanticType = (typeof SEMANTIC_TYPES)[number];
/** Structural relations are derived from the vault (slugs, `generator:`, thread order), never stored as relation files. */
export const STRUCTURAL_TYPES = ["parent", "reply_to", "belongs_to"] as const;
export type StructuralType = (typeof STRUCTURAL_TYPES)[number];

export const RELATION_STATUSES = ["proposed", "validated", "rejected"] as const;
export type RelationStatus = (typeof RELATION_STATUSES)[number];
export type RelationOrigin = "human" | "ai";

/** `<publicationUuid>/<n>`, n being the number of the message file `{n}_{slug}.md` (never reused in a publication). */
export type MessageRef = string;
export const MESSAGE_REF = /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/([1-9]\d{0,5})$/;
export const GENERATOR_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)*$/;

/** Graph node ids: `g:<generatorUuid>` | `g:unassigned` | `p:<publicationUuid>` | `m:<MessageRef>`. */
export type NodeId = string;
export type NodeLevel = "generator" | "publication" | "message";
export const UNASSIGNED = "g:unassigned";
export const generatorNode = (id: string): NodeId => `g:${id}`;
export const publicationNode = (id: string): NodeId => `p:${id}`;
export const messageNode = (ref: MessageRef): NodeId => `m:${ref}`;
export function nodeLevel(id: NodeId): NodeLevel | null {
  return id.startsWith("g:") ? "generator" : id.startsWith("p:") ? "publication" : id.startsWith("m:") ? "message" : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Repository contract (server only). Everything returned is already filtered for the viewer and holds no content
// beyond short index excerpts. Implemented by src/lib/graph/repository.ts, consumed by src/lib/graph/engine.ts.
// ---------------------------------------------------------------------------------------------------------------

export type GeneratorData = {
  id: string;
  slug: string;
  title: string;
  /** Nearest existing generator whose slug is a dotted prefix; always visible when the child is visible. */
  parentId: string | null;
};

export type PublicationData = {
  id: string;
  /** null = shown under the virtual `g:unassigned` root (no generator, or one the viewer/author may not read). */
  generatorId: string | null;
  title: string;
  authorId: string;
  type: "post" | "thread";
  /** published_at, or updated_at for the author's own drafts: ISO string, the sort key (newest first). */
  date: string;
  messageCount: number;
};

export type MessageData = {
  ref: MessageRef;
  publicationId: string;
  /** 1-based position in the thread order of index.md. */
  position: number;
  excerpt: string;
  /** Structural reply_to: the previous message of the thread, null for the first one. */
  replyTo: MessageRef | null;
};

/** A validated relation whose two endpoints exist and are readable by the viewer. */
export type RelationData = {
  id: string;
  type: SemanticType;
  source: MessageRef;
  target: MessageRef;
  sourcePublication: string;
  targetPublication: string;
  needsReview: boolean;
  createdAt: string;
};

export type AuthorizedGraph = {
  generators: GeneratorData[];
  publications: PublicationData[];
  relations: RelationData[];
};

export type Viewer = { id: string };

export type ReadOptions = { reconciled?: boolean };

export interface GraphRepository {
  /** Reconciles the index with the vault (mtime-gated), then returns everything the viewer may see. */
  authorizedGraph(viewer: Viewer): Promise<AuthorizedGraph>;
  /**
   * Messages of a publication in thread order; null when it does not exist or is unreadable.
   * `reconciled: true` reuses the index reconciled by an `authorizedGraph` call of the same request (permissions are
   * still checked against it): one vault scan per request instead of one per read.
   */
  messages(viewer: Viewer, publicationId: string, options?: ReadOptions): Promise<MessageData[] | null>;
  /** Index data of readable messages only; unreadable or unknown refs are simply absent from the map. */
  describeMessages(viewer: Viewer, refs: MessageRef[], options?: ReadOptions): Promise<Map<MessageRef, MessageData>>;
}

// ---------------------------------------------------------------------------------------------------------------
// HTTP API (JSON). All routes: 401 without session, 400 on invalid input, 404 for unreadable = nonexistent,
// `Cache-Control: private, no-store`.
//   POST /api/graph/view          ViewRequest        → ViewResponse
//   POST /api/graph/connections   ConnectionsRequest → ConnectionsResponse
//   GET  /api/graph/message?ref=  —                  → MessagePreview
// ---------------------------------------------------------------------------------------------------------------

export const GRAPH_LIMITS = {
  maxExpanded: 60,
  defaultChildLimit: 40,
  maxChildLimit: 200,
  /** Hard cap on nodes in one view response: protects the browser against huge renders. */
  maxNodes: 600,
  connectionsPageSize: 30,
  maxConnectionsPageSize: 100,
} as const;

export type ExpandRequest = { id: NodeId; limit?: number };
export type ViewRequest = { expanded: ExpandRequest[] };

/** Relations touching a node's subtree. Each relation counts at most once per node. */
export type NodeCounts = {
  /** Both endpoints inside the subtree (e.g. between two sub-generators of the same parent). */
  internal: number;
  /** Exactly one endpoint inside the subtree. */
  external: number;
  /** Among internal + external, relations flagged needs_review. */
  needsReview: number;
};

export type GraphNode = {
  id: NodeId;
  level: NodeLevel;
  label: string;
  /** Structural parent: parent generator, belongs_to generator, or the message's publication. null for roots. */
  parent: NodeId | null;
  /** Structural reply_to between messages (previous message of the thread). */
  replyTo: NodeId | null;
  expanded: boolean;
  /** Authorized children in total, and how many of them this response contains. */
  childCount: number;
  shownChildren: number;
  counts: NodeCounts;
  /** Generators: slug. Publications: type + date. Messages: position. */
  slug?: string;
  publicationType?: "post" | "thread";
  date?: string;
  position?: number;
};

/**
 * Aggregated semantic relations between two displayed nodes (a < b lexicographically). Every relation endpoint is
 * projected on its deepest displayed ancestor-or-self; a relation whose endpoints project on the same node adds no
 * edge (it is in that node's internal counter), so there is never a visual loop.
 */
export type GraphEdge = {
  id: string;
  a: NodeId;
  b: NodeId;
  total: number;
  aToB: number;
  bToA: number;
  byType: Partial<Record<SemanticType, number>>;
  needsReview: number;
};

export type ViewResponse = { nodes: GraphNode[]; edges: GraphEdge[]; truncated: boolean };

export type ConnectionsScope =
  | { kind: "between"; a: NodeId; b: NodeId }
  | { kind: "internal"; node: NodeId }
  | { kind: "external"; node: NodeId }
  | { kind: "all"; node: NodeId };

export type ConnectionsFilters = {
  types?: SemanticType[];
  /** Generator uuid: at least one endpoint inside its subtree. */
  generator?: string;
  /** Inclusive ISO dates (YYYY-MM-DD or full ISO) on the relation's created_at. */
  from?: string;
  to?: string;
  needsReview?: boolean;
};

export type ConnectionsRequest = { scope: ConnectionsScope; filters?: ConnectionsFilters; cursor?: string | null; limit?: number };

export type MessageSummary = {
  ref: MessageRef;
  nodeId: NodeId;
  publicationId: string;
  generatorId: string | null;
  excerpt: string;
  position: number;
};

export type ConnectionItem = {
  id: string;
  type: SemanticType;
  needsReview: boolean;
  createdAt: string;
  source: MessageSummary;
  target: MessageSummary;
};

/** Newest relations first; `total` counts the filtered authorized relations of the scope. */
export type ConnectionsResponse = { items: ConnectionItem[]; total: number; nextCursor: string | null };

export type AuthorSummary = { id: string; name: string; handle: string; bloubSeed?: string | null; bloub?: XiAgentBloub; image: string | null };

export type MessagePreview = {
  ref: MessageRef;
  nodeId: NodeId;
  /** Raw Markdown re-read from the vault after a permission check (render with MarkdownView). */
  body: string;
  author: AuthorSummary | null;
  publication: { id: string; type: "post" | "thread"; title: string; date: string; visibility: Visibility; status: "draft" | "published" };
  position: number;
  total: number;
  parent: MessageSummary | null;
  replies: MessageSummary[];
  connections: { id: string; type: SemanticType; needsReview: boolean; direction: "outgoing" | "incoming"; other: MessageSummary }[];
  /** `/dashboard/publications/<id>#m-<n>`: the message inside its thread. */
  href: string;
};
