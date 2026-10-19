// Pure view-model of the explorer: projection of the API view onto the displayed detail level, labels, scales.

import type { ConnectionsScope, GraphEdge, GraphNode, NodeId, NodeLevel, SemanticType, ViewResponse } from "@/lib/graph/types";

export const TYPE_LABELS: Record<SemanticType, string> = {
  supports: "Soutient",
  contradicts: "Contredit",
  expands: "Développe",
  related_to: "Lié à",
  updates: "Met à jour",
};

export const LEVEL_LABELS: Record<NodeLevel, string> = { generator: "Générateurs", publication: "Publications", message: "Messages" };
export const LEVEL_DEPTH: Record<NodeLevel, number> = { generator: 0, publication: 1, message: 2 };

export const plural = (count: number, one: string, many = `${one}s`) => `${count.toLocaleString("fr-FR")} ${count > 1 ? many : one}`;

export type DisplayEdge = GraphEdge & {
  /** Relations of the selected types (= total without type filter): the number drawn on the edge. */
  shown: number;
};
export type StructuralLink = { id: string; from: NodeId; to: NodeId; kind: "parent" | "reply" };
export type DisplayGraph = {
  nodes: GraphNode[];
  byId: Map<NodeId, GraphNode>;
  edges: DisplayEdge[];
  links: StructuralLink[];
  /** Nodes of the response hidden by the detail level, mapped to their displayed ancestor. */
  hiddenCount: number;
};

export const EMPTY_GRAPH: DisplayGraph = { nodes: [], byId: new Map(), edges: [], links: [], hiddenCount: 0 };

/**
 * Keeps the nodes down to `level` and re-projects the aggregated edges of hidden nodes onto their deepest displayed
 * ancestor. Sums stay exact: every relation belongs to exactly one edge of the response; edges collapsing on a single
 * node disappear (those relations are already in that node's internal counter).
 */
export function projectView(view: ViewResponse | null, level: NodeLevel, types: readonly SemanticType[]): DisplayGraph {
  if (!view) return EMPTY_GRAPH;
  const all = new Map(view.nodes.map((node) => [node.id, node]));
  const depth = LEVEL_DEPTH[level];
  const nodes = view.nodes.filter((node) => LEVEL_DEPTH[node.level] <= depth);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const project = (id: NodeId): NodeId | null => {
    let current = all.get(id);
    for (let guard = 0; current && guard < 64; guard++) {
      if (byId.has(current.id)) return current.id;
      current = current.parent ? all.get(current.parent) : undefined;
    }
    return null;
  };

  const merged = new Map<string, DisplayEdge>();
  for (const edge of view.edges) {
    const pa = project(edge.a);
    const pb = project(edge.b);
    if (!pa || !pb || pa === pb) continue;
    const swap = pa > pb;
    const [a, b] = swap ? [pb, pa] : [pa, pb];
    const key = `${a}|${b}`;
    const target = merged.get(key) ?? { id: key, a, b, total: 0, aToB: 0, bToA: 0, byType: {}, needsReview: 0, shown: 0 };
    target.total += edge.total;
    target.aToB += swap ? edge.bToA : edge.aToB;
    target.bToA += swap ? edge.aToB : edge.bToA;
    target.needsReview += edge.needsReview;
    for (const [type, count] of Object.entries(edge.byType) as [SemanticType, number][]) target.byType[type] = (target.byType[type] ?? 0) + count;
    merged.set(key, target);
  }
  const edges: DisplayEdge[] = [];
  for (const edge of merged.values()) {
    edge.shown = types.length ? types.reduce((sum, type) => sum + (edge.byType[type] ?? 0), 0) : edge.total;
    if (edge.shown > 0) edges.push(edge);
  }

  const links: StructuralLink[] = [];
  for (const node of nodes) {
    if (node.parent && byId.has(node.parent)) links.push({ id: `s:${node.id}`, from: node.parent, to: node.id, kind: "parent" });
    if (node.replyTo && byId.has(node.replyTo)) links.push({ id: `r:${node.id}`, from: node.replyTo, to: node.id, kind: "reply" });
  }
  return { nodes, byId, edges, links, hiddenCount: view.nodes.length - nodes.length };
}

/** Every node of the view below `id` (to collapse a branch and its expanded descendants at once). */
export function descendantsOf(id: NodeId, nodes: readonly GraphNode[]): Set<NodeId> {
  const children = new Map<NodeId, NodeId[]>();
  for (const node of nodes) if (node.parent) children.set(node.parent, [...(children.get(node.parent) ?? []), node.id]);
  const result = new Set<NodeId>();
  const stack = [...(children.get(id) ?? [])];
  while (stack.length) {
    const next = stack.pop()!;
    if (result.has(next)) continue;
    result.add(next);
    stack.push(...(children.get(next) ?? []));
  }
  return result;
}

/** Automatic detail level from the zoom, with hysteresis so it does not flicker around a threshold. */
export function autoLevel(k: number, previous: NodeLevel): NodeLevel {
  const toGenerator = previous === "generator" ? 0.5 : 0.42;
  const toPublication = previous === "message" ? 0.72 : 0.8;
  if (k < toGenerator) return "generator";
  if (k < toPublication) return "publication";
  return "message";
}

export const AUTO_EXPAND_ZOOM = 1.8;

/** Stroke width in px from a log scale of the relation count, clamped. */
export const edgeWidth = (count: number) => Math.min(9, Math.max(1.25, 1.25 + 1.6 * Math.log2(1 + Math.max(0, count))));

export const truncate = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

export const messageRefOf = (id: NodeId) => (id.startsWith("m:") ? id.slice(2) : null);
export const generatorUuidOf = (id: NodeId) => (id.startsWith("g:") && id !== "g:unassigned" ? id.slice(2) : null);

export function nodeAriaLabel(node: GraphNode, expanded: boolean) {
  const kind = node.level === "generator" ? "Générateur" : node.level === "publication" ? (node.publicationType === "thread" ? "Fil" : "Publication") : `Message ${node.position ?? ""}`.trim();
  const parts = [`${kind} « ${node.label} »`];
  if (node.level !== "message") {
    parts.push(node.childCount ? `${plural(node.childCount, "élément")}${expanded ? `, ${node.shownChildren} affichés` : ""}` : "aucun élément");
    if (node.childCount) parts.push(expanded ? "déplié" : "replié");
  }
  parts.push(`${plural(node.counts.internal, "connexion interne", "connexions internes")}, ${plural(node.counts.external, "connexion externe", "connexions externes")}`);
  if (node.counts.needsReview) parts.push(`${node.counts.needsReview} à réexaminer`);
  return parts.join(", ");
}

export function edgeAriaLabel(edge: DisplayEdge, label: (id: NodeId) => string) {
  const parts = [`${plural(edge.shown, "connexion")} entre « ${label(edge.a)} » et « ${label(edge.b)} »`];
  if (edge.aToB) parts.push(`${edge.aToB} de « ${label(edge.a)} » vers « ${label(edge.b)} »`);
  if (edge.bToA) parts.push(`${edge.bToA} dans l’autre sens`);
  if (edge.needsReview) parts.push(`${edge.needsReview} à réexaminer`);
  return `${parts.join(", ")}. Afficher la liste`;
}

export function scopeTitle(scope: ConnectionsScope, label: (id: NodeId) => string) {
  switch (scope.kind) {
    case "between": return `Entre « ${label(scope.a)} » et « ${label(scope.b)} »`;
    case "internal": return `À l’intérieur de « ${label(scope.node)} »`;
    case "external": return `Entre « ${label(scope.node)} » et l’extérieur`;
    case "all": return `Autour de « ${label(scope.node)} »`;
  }
}

/** Display order (tab order, list fallback): depth-first along the structural tree, roots and siblings as received. */
export function treeOrder(nodes: readonly GraphNode[]): GraphNode[] {
  const ids = new Set(nodes.map((node) => node.id));
  const children = new Map<NodeId | null, GraphNode[]>();
  for (const node of nodes) {
    const parent = node.parent && ids.has(node.parent) ? node.parent : null;
    children.set(parent, [...(children.get(parent) ?? []), node]);
  }
  const ordered: GraphNode[] = [];
  const visit = (parent: NodeId | null, guard: number) => {
    if (guard > 64) return;
    for (const node of children.get(parent) ?? []) {
      ordered.push(node);
      visit(node.id, guard + 1);
    }
  };
  visit(null, 0);
  return ordered;
}
