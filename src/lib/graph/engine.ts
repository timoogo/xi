// Pure graph computations over what the repository already authorized: views, projections, counters, connections.
// Nothing here reads files or checks permissions; anything absent from the AuthorizedGraph simply does not exist.

import { z } from "zod";
import {
  GRAPH_LIMITS, MESSAGE_REF, SEMANTIC_TYPES, UNASSIGNED, generatorNode, messageNode, nodeLevel, publicationNode,
  type AuthorizedGraph, type ConnectionsRequest, type ConnectionsScope, type GeneratorData, type GraphEdge,
  type GraphNode, type MessageData, type MessageRef, type NodeId, type PublicationData, type RelationData,
  type ViewRequest, type ViewResponse,
} from "./types";

// ---------------------------------------------------------------------------------------------------------------
// Request validation: malformed input is a 400; well-formed but unknown or unauthorized ids are silently ignored.
// ---------------------------------------------------------------------------------------------------------------

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID_V4 = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const GENERATOR_ID = new RegExp(`^${UUID}$`);
// Generator ids are any frontmatter UUID; publication ids (and so message refs) are v4, as in MESSAGE_REF.
export const NODE_ID = new RegExp(`^(?:g:(?:unassigned|${UUID})|p:${UUID_V4}|m:${UUID_V4}/[1-9]\\d{0,5})$`);
const DATE = /^\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:\d{2}))?$/;

export const clampLimit = (value: number | undefined, fallback: number, max: number) =>
  value === undefined ? fallback : Math.min(Math.max(Math.trunc(value), 1), max);

const nodeId = z.string().max(120).regex(NODE_ID);
const limit = z.number().finite().optional();
const date = z.string().max(40).regex(DATE).refine((value) => !Number.isNaN(Date.parse(value)));

const viewSchema = z.object({
  expanded: z.array(z.object({ id: nodeId, limit })).max(GRAPH_LIMITS.maxExpanded),
});

const connectionsSchema = z.object({
  scope: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("between"), a: nodeId, b: nodeId }),
    z.object({ kind: z.literal("internal"), node: nodeId }),
    z.object({ kind: z.literal("external"), node: nodeId }),
    z.object({ kind: z.literal("all"), node: nodeId }),
  ]),
  filters: z.object({
    types: z.array(z.enum(SEMANTIC_TYPES)).max(SEMANTIC_TYPES.length).optional(),
    generator: z.string().regex(GENERATOR_ID).optional(),
    from: date.optional(),
    to: date.optional(),
    needsReview: z.boolean().optional(),
  }).optional(),
  cursor: z.string().max(200).nullable().optional(),
  limit,
});

/** Normalized: duplicates dropped (first wins), limits clamped. null = invalid request. */
export function parseViewRequest(input: unknown): ViewRequest | null {
  const parsed = viewSchema.safeParse(input);
  if (!parsed.success) return null;
  const seen = new Set<string>();
  return {
    expanded: parsed.data.expanded.filter(({ id }) => !seen.has(id) && !!seen.add(id)).map(({ id, limit }) => ({
      id, limit: clampLimit(limit, GRAPH_LIMITS.defaultChildLimit, GRAPH_LIMITS.maxChildLimit),
    })),
  };
}

export function parseConnectionsRequest(input: unknown): ConnectionsRequest | null {
  const parsed = connectionsSchema.safeParse(input);
  if (!parsed.success) return null;
  const { scope, filters, cursor, limit } = parsed.data;
  return {
    scope, filters: filters && { ...filters, types: filters.types && [...new Set(filters.types)] }, cursor: cursor ?? null,
    limit: clampLimit(limit, GRAPH_LIMITS.connectionsPageSize, GRAPH_LIMITS.maxConnectionsPageSize),
  };
}

export function parseMessageRef(input: unknown): { ref: MessageRef; publicationId: string; n: number } | null {
  if (typeof input !== "string" || input.length > 64) return null;
  const match = MESSAGE_REF.exec(input);
  return match ? { ref: input, publicationId: match[1], n: Number(match[2]) } : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Index: built once per AuthorizedGraph (WeakMap), shared by views and connections of the same request.
// ---------------------------------------------------------------------------------------------------------------

type SortedRelation = { relation: RelationData; time: number };

type GraphIndex = {
  generators: Map<string, GeneratorData>;
  publications: Map<string, PublicationData>;
  /** Effective structural parent; a parent missing from the graph makes the generator a root. */
  parentOf: Map<string, string | null>;
  /** Keyed by parent generator id, "" for roots. Sorted by slug. */
  childGenerators: Map<string, GeneratorData[]>;
  /** Keyed by generator id, UNASSIGNED for the virtual root. Date desc, id desc. */
  publicationsOf: Map<string, PublicationData[]>;
  /** Effective generator: null when absent or not in the graph (shown under g:unassigned). */
  generatorOf: (publicationId: string) => string | null;
  /** Generator ids root → self. */
  ancestors: (generatorId: string) => string[];
  sorted: () => SortedRelation[];
};

const indexes = new WeakMap<AuthorizedGraph, GraphIndex>();
const bySlug = (a: GeneratorData, b: GeneratorData) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);
const newestFirst = (a: PublicationData, b: PublicationData) =>
  a.date < b.date ? 1 : a.date > b.date ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
const time = (iso: string) => {
  const value = Date.parse(iso);
  return Number.isNaN(value) ? -Infinity : value;
};

function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function indexGraph(graph: AuthorizedGraph): GraphIndex {
  const cached = indexes.get(graph);
  if (cached) return cached;
  const generators = new Map(graph.generators.map((generator) => [generator.id, generator]));
  const publications = new Map(graph.publications.map((publication) => [publication.id, publication]));
  const parentOf = new Map<string, string | null>();
  const childGenerators = new Map<string, GeneratorData[]>();
  for (const generator of generators.values()) {
    const parent = generator.parentId !== null && generator.parentId !== generator.id && generators.has(generator.parentId) ? generator.parentId : null;
    parentOf.set(generator.id, parent);
    push(childGenerators, parent ?? "", generator);
  }
  for (const list of childGenerators.values()) list.sort(bySlug);
  const generatorOf = (id: string) => {
    const generatorId = publications.get(id)?.generatorId ?? null;
    return generatorId !== null && generators.has(generatorId) ? generatorId : null;
  };
  const publicationsOf = new Map<string, PublicationData[]>();
  for (const publication of publications.values()) push(publicationsOf, generatorOf(publication.id) ?? UNASSIGNED, publication);
  for (const list of publicationsOf.values()) list.sort(newestFirst);

  const chains = new Map<string, string[]>();
  const ancestors = (id: string): string[] => {
    let chain = chains.get(id);
    if (chain) return chain;
    chains.set(id, [id]); // Cycle guard: a corrupt parent loop ends here instead of recursing forever.
    const parent = parentOf.get(id) ?? null;
    chain = parent === null ? [id] : [...ancestors(parent), id];
    chains.set(id, chain);
    return chain;
  };
  let sortedCache: SortedRelation[] | null = null;
  const sorted = () => sortedCache ??= graph.relations
    .map((relation) => ({ relation, time: time(relation.createdAt) }))
    .sort((a, b) => b.time - a.time || (a.relation.id < b.relation.id ? 1 : a.relation.id > b.relation.id ? -1 : 0));

  const index = { generators, publications, parentOf, childGenerators, publicationsOf, generatorOf, ancestors, sorted };
  indexes.set(graph, index);
  return index;
}

/** Effective generator of a publication as the graph shows it (null = g:unassigned). */
export const generatorResolver = (graph: AuthorizedGraph) => indexGraph(graph).generatorOf;

/** Expanded publications whose messages the caller must load before building the view. */
export function publicationsToLoad(graph: AuthorizedGraph, request: ViewRequest): string[] {
  const { publications } = indexGraph(graph);
  return request.expanded.map(({ id }) => id).filter((id) => id.startsWith("p:") && publications.has(id.slice(2))).map((id) => id.slice(2));
}

// ---------------------------------------------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------------------------------------------

const UNASSIGNED_LABEL = "Sans générateur";
const emptyCounts = () => ({ internal: 0, external: 0, needsReview: 0 });

export function buildView(graph: AuthorizedGraph, request: ViewRequest, messagesByPublication: Map<string, MessageData[]>): ViewResponse {
  const index = indexGraph(graph);
  const { childGenerators, publicationsOf } = index;
  const expanded = new Map<NodeId, number>();
  for (const { id, limit } of request.expanded.slice(0, GRAPH_LIMITS.maxExpanded)) {
    if (!expanded.has(id)) expanded.set(id, clampLimit(limit, GRAPH_LIMITS.defaultChildLimit, GRAPH_LIMITS.maxChildLimit));
  }
  const messagesOf = (id: string) => messagesByPublication.get(id)?.filter((message) => message.publicationId === id);

  const nodes: GraphNode[] = [];
  const position = new Map<NodeId, number>();
  const withMessages = new Set<string>();
  let truncated = false;
  const add = (node: Omit<GraphNode, "expanded" | "shownChildren" | "counts">) => {
    if (nodes.length >= GRAPH_LIMITS.maxNodes) return !(truncated = true);
    position.set(node.id, nodes.length);
    nodes.push({ ...node, expanded: false, shownChildren: 0, counts: emptyCounts() });
    return true;
  };
  const generatorChildren = (key: string) => (childGenerators.get(key)?.length ?? 0) + (publicationsOf.get(key)?.length ?? 0);
  const addGenerator = (generator: GeneratorData) => add({
    id: generatorNode(generator.id), level: "generator", label: generator.title, slug: generator.slug, replyTo: null,
    parent: index.parentOf.get(generator.id) ? generatorNode(index.parentOf.get(generator.id)!) : null,
    childCount: generatorChildren(generator.id),
  });
  const addPublication = (publication: PublicationData, parent: NodeId) => add({
    id: publicationNode(publication.id), level: "publication", label: publication.title, replyTo: null, parent,
    childCount: messagesOf(publication.id)?.length ?? publication.messageCount,
    publicationType: publication.type, date: publication.date,
  });

  for (const generator of childGenerators.get("") ?? []) addGenerator(generator);
  if (publicationsOf.get(UNASSIGNED)?.length) {
    add({ id: UNASSIGNED, level: "generator", label: UNASSIGNED_LABEL, parent: null, replyTo: null, childCount: generatorChildren(UNASSIGNED) });
  }

  // Breadth-first over displayed nodes: an expanded child of an expanded parent is reached after its parent.
  for (let i = 0; i < nodes.length && !truncated; i++) {
    const node = nodes[i];
    const limit = expanded.get(node.id);
    if (limit === undefined || node.level === "message") continue;
    node.expanded = true;
    let shown = 0;
    const take = (adder: () => boolean) => shown < limit && !truncated && adder() && ++shown;
    if (node.level === "generator") {
      const key = node.id === UNASSIGNED ? UNASSIGNED : node.id.slice(2);
      for (const generator of childGenerators.get(key) ?? []) if (!take(() => addGenerator(generator))) break;
      for (const publication of publicationsOf.get(key) ?? []) if (!take(() => addPublication(publication, node.id))) break;
    } else {
      withMessages.add(node.id.slice(2));
      for (const message of messagesOf(node.id.slice(2)) ?? []) {
        if (!take(() => add({
          id: messageNode(message.ref), level: "message", label: message.excerpt || `Message ${message.position}`,
          parent: node.id, replyTo: message.replyTo ? messageNode(message.replyTo) : null, childCount: 0, position: message.position,
        }))) break;
      }
    }
    node.shownChildren = shown;
  }

  // Displayed nodes are ancestor-closed, so each endpoint's displayed ancestors form a root path (indices into nodes).
  const generatorChains = new Map<string, number[]>();
  const generatorChain = (id: string | null): number[] => {
    if (id === null) return position.has(UNASSIGNED) ? [position.get(UNASSIGNED)!] : [];
    let chain = generatorChains.get(id);
    if (chain) return chain;
    chain = [];
    for (const ancestor of index.ancestors(id)) {
      const at = position.get(generatorNode(ancestor));
      if (at === undefined) break;
      chain.push(at);
    }
    generatorChains.set(id, chain);
    return chain;
  };
  const publicationChains = new Map<string, number[]>();
  const publicationChain = (id: string): number[] => {
    let chain = publicationChains.get(id);
    if (chain) return chain;
    const base = generatorChain(index.generatorOf(id));
    const at = position.get(publicationNode(id));
    chain = at === undefined || base.length === 0 ? base : [...base, at];
    publicationChains.set(id, chain);
    return chain;
  };

  const internal = new Int32Array(nodes.length);
  const external = new Int32Array(nodes.length);
  const review = new Int32Array(nodes.length);
  const edges = new Map<string, GraphEdge>();
  for (const relation of graph.relations) {
    if (!index.publications.has(relation.sourcePublication) || !index.publications.has(relation.targetPublication)) continue;
    const s = publicationChain(relation.sourcePublication);
    const t = publicationChain(relation.targetPublication);
    // A message node only exists below its own (displayed) publication, so it simply extends that chain.
    const sm = withMessages.has(relation.sourcePublication) ? position.get(messageNode(relation.source)) : undefined;
    const tm = withMessages.has(relation.targetPublication) ? position.get(messageNode(relation.target)) : undefined;
    const sLength = s.length + (sm === undefined ? 0 : 1);
    const tLength = t.length + (tm === undefined ? 0 : 1);
    const sAt = (i: number) => (i < s.length ? s[i] : sm!);
    const tAt = (i: number) => (i < t.length ? t[i] : tm!);
    let common = 0;
    while (common < sLength && common < tLength && sAt(common) === tAt(common)) common++;
    const flag = relation.needsReview ? 1 : 0;
    for (let i = 0; i < common; i++) { internal[sAt(i)]++; review[sAt(i)] += flag; }
    for (let i = common; i < sLength; i++) { external[sAt(i)]++; review[sAt(i)] += flag; }
    for (let i = common; i < tLength; i++) { external[tAt(i)]++; review[tAt(i)] += flag; }
    if (!sLength || !tLength) continue;
    const from = nodes[sAt(sLength - 1)].id;
    const to = nodes[tAt(tLength - 1)].id;
    if (from === to) continue;
    const [a, b] = from < to ? [from, to] : [to, from];
    const key = `${a}|${b}`;
    let edge = edges.get(key);
    if (!edge) edges.set(key, edge = { id: key, a, b, total: 0, aToB: 0, bToA: 0, byType: {}, needsReview: 0 });
    edge.total++;
    if (from === a) edge.aToB++;
    else edge.bToA++;
    edge.byType[relation.type] = (edge.byType[relation.type] ?? 0) + 1;
    edge.needsReview += flag;
  }
  nodes.forEach((node, i) => { node.counts = { internal: internal[i], external: external[i], needsReview: review[i] }; });
  return { nodes, edges: [...edges.values()].sort((x, y) => (x.id < y.id ? -1 : 1)), truncated };
}

// ---------------------------------------------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------------------------------------------

type Membership = (ref: MessageRef, publicationId: string) => boolean;

/** null when the node is unknown or unauthorized: the scope is then empty, exactly like a nonexistent node. */
function membership(index: GraphIndex, node: NodeId): Membership | null {
  const level = nodeLevel(node);
  const id = node.slice(2);
  if (node === UNASSIGNED) return (_, publication) => index.publications.has(publication) && index.generatorOf(publication) === null;
  if (level === "generator") {
    if (!index.generators.has(id)) return null;
    return (_, publication) => {
      const generator = index.generatorOf(publication);
      return generator !== null && index.ancestors(generator).includes(id);
    };
  }
  if (level === "publication") return index.publications.has(id) ? (_, publication) => publication === id : null;
  if (level === "message") {
    const parsed = parseMessageRef(id);
    return parsed && index.publications.has(parsed.publicationId) ? (ref) => ref === id : null;
  }
  return null;
}

function scopeTest(index: GraphIndex, scope: ConnectionsScope): ((relation: RelationData) => boolean) | null {
  const inside = (test: Membership, relation: RelationData) =>
    [test(relation.source, relation.sourcePublication), test(relation.target, relation.targetPublication)] as const;
  if (scope.kind === "between") {
    const a = membership(index, scope.a);
    const b = membership(index, scope.b);
    if (!a || !b) return null;
    return (relation) => {
      const [as, at] = inside(a, relation);
      const [bs, bt] = inside(b, relation);
      return (as && bt) || (bs && at);
    };
  }
  const test = membership(index, scope.node);
  if (!test) return null;
  return (relation) => {
    const [s, t] = inside(test, relation);
    return scope.kind === "internal" ? s && t : scope.kind === "external" ? s !== t : s || t;
  };
}

const encodeCursor = (value: [number, string]) => Buffer.from(JSON.stringify(value)).toString("base64url");
function decodeCursor(cursor?: string | null): [number, string] | null {
  if (!cursor) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    // JSON turns an unparsable created_at (-Infinity) into null.
    if (Array.isArray(value) && value.length === 2 && (typeof value[0] === "number" || value[0] === null) && typeof value[1] === "string") {
      return [value[0] ?? -Infinity, value[1]];
    }
  } catch { /* An invalid cursor starts from the newest relations. */ }
  return null;
}

const DAY = 86_400_000;
const dateBound = (value: string | undefined, end: boolean) => {
  if (value === undefined) return end ? Infinity : -Infinity;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return end ? Infinity : -Infinity;
  // A date-only upper bound includes its whole (UTC) day.
  return end && /^\d{4}-\d{2}-\d{2}$/.test(value) ? parsed + DAY - 1 : parsed;
};

export type ConnectionsPage = { relations: RelationData[]; total: number; nextCursor: string | null };

export function listConnections(graph: AuthorizedGraph, request: ConnectionsRequest): ConnectionsPage {
  const index = indexGraph(graph);
  const empty = { relations: [], total: 0, nextCursor: null };
  const inScope = scopeTest(index, request.scope);
  if (!inScope) return empty;
  const filters = request.filters ?? {};
  const types = filters.types?.length ? new Set(filters.types) : null;
  let inGenerator: Membership | null = null;
  if (filters.generator !== undefined) {
    inGenerator = membership(index, generatorNode(filters.generator));
    if (!inGenerator) return empty; // A filter on an unknown generator matches nothing, like an empty one.
  }
  const from = dateBound(filters.from, false);
  const to = dateBound(filters.to, true);
  const limit = clampLimit(request.limit, GRAPH_LIMITS.connectionsPageSize, GRAPH_LIMITS.maxConnectionsPageSize);
  const after = decodeCursor(request.cursor);

  const relations: RelationData[] = [];
  let total = 0;
  let more = false;
  for (const { relation, time: at } of index.sorted()) {
    if (types && !types.has(relation.type)) continue;
    if (filters.needsReview !== undefined && relation.needsReview !== filters.needsReview) continue;
    if (at < from || at > to) continue;
    if (inGenerator && !inGenerator(relation.source, relation.sourcePublication) && !inGenerator(relation.target, relation.targetPublication)) continue;
    if (!inScope(relation)) continue;
    total++;
    // Keyset: strictly older than the cursor (time desc, id desc), so pages never overlap nor skip.
    if (after && !(at < after[0] || (at === after[0] && relation.id < after[1]))) continue;
    if (relations.length < limit) relations.push(relation);
    else more = true;
  }
  const last = relations.at(-1);
  return { relations, total, nextCursor: more && last ? encodeCursor([time(last.createdAt), last.id]) : null };
}
