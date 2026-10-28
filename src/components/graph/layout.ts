// Layouts in world coordinates (origin at the centre). Free mode: a small force simulation whose existing nodes keep
// their positions across refetches. Hierarchical mode: a tidy tree in columns generators → publications → messages.

import type { GraphNode, NodeId, NodeLevel } from "@/lib/graph/types";
import type { DisplayGraph } from "./model";
import { treeOrder } from "./model";

export type Point = { x: number; y: number };
type SimNode = { x: number; y: number; vx: number; vy: number; level: NodeLevel; mobility: number; pinned: boolean };

export type Simulation = {
  nodes: Map<NodeId, SimNode>;
  /** Last known positions of nodes that left the view: a re-expanded branch reappears where it was. */
  memory: Map<NodeId, Point>;
  alpha: number;
  links: { from: NodeId; to: NodeId; length: number; strength: number }[];
};

export const MAX_TICKS = 320;
const ALPHA_MIN = 0.004;
const ALPHA_DECAY = 1 - Math.pow(ALPHA_MIN, 1 / MAX_TICKS);
const CHARGE: Record<NodeLevel, number> = { generator: 5200, publication: 1700, message: 520 };
const RADIUS: Record<NodeLevel, number> = { generator: 34, publication: 26, message: 14 };
const LINK_LENGTH: Record<NodeLevel, number> = { generator: 150, publication: 95, message: 48 };

export const createSimulation = (): Simulation => ({ nodes: new Map(), memory: new Map(), alpha: 0, links: [] });

/** Deterministic jitter from the id, so the same expansion always lands the same way. */
export function hash(id: string) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

/** Adds new nodes next to their parent, forgets removed ones and rebuilds the springs. Returns true when nodes were added. */
export function syncSimulation(sim: Simulation, graph: DisplayGraph): boolean {
  const ids = new Set(graph.nodes.map((node) => node.id));
  for (const [id, node] of sim.nodes) {
    if (ids.has(id)) continue;
    sim.memory.set(id, { x: node.x, y: node.y });
    sim.nodes.delete(id);
  }
  if (sim.memory.size > 4000) sim.memory.clear();
  let added = 0;
  for (const node of treeOrder(graph.nodes)) {
    if (sim.nodes.has(node.id)) {
      sim.nodes.get(node.id)!.mobility = 0.12;
      continue;
    }
    const remembered = sim.memory.get(node.id);
    const parent = node.parent ? sim.nodes.get(node.parent) : undefined;
    const angle = hash(node.id) * Math.PI * 2;
    const distance = parent ? LINK_LENGTH[node.level] * (0.6 + hash(`${node.id}#`) * 0.5) : 260 * Math.sqrt(hash(`${node.id}r`));
    const origin = parent ?? { x: 0, y: 0 };
    const point = remembered ?? { x: origin.x + Math.cos(angle) * distance, y: origin.y + Math.sin(angle) * distance };
    sim.nodes.set(node.id, { ...point, vx: 0, vy: 0, level: node.level, mobility: 1, pinned: false });
    added++;
  }
  sim.links = [];
  for (const link of graph.links) {
    const level = graph.byId.get(link.to)?.level ?? "message";
    sim.links.push(link.kind === "parent" ? { from: link.from, to: link.to, length: LINK_LENGTH[level], strength: 0.5 } : { from: link.from, to: link.to, length: 36, strength: 0.25 });
  }
  for (const edge of graph.edges) sim.links.push({ from: edge.a, to: edge.b, length: 220, strength: Math.min(0.12, 0.02 + 0.015 * Math.log2(1 + edge.shown)) });
  if (added) sim.alpha = Math.max(sim.alpha, sim.nodes.size === added ? 1 : 0.6);
  return added > 0;
}

export function tick(sim: Simulation) {
  const alpha = sim.alpha;
  if (alpha < ALPHA_MIN) return false;
  const list = [...sim.nodes.values()];
  // Repulsion (all pairs: the view is capped at GRAPH_LIMITS.maxNodes) with a soft collision radius.
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    for (let j = i + 1; j < list.length; j++) {
      const b = list[j];
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 0.01) { dx = (i - j) * 0.1 + 0.05; dy = 0.1; d2 = dx * dx + dy * dy; }
      if (d2 > 640000) continue;
      const d = Math.sqrt(d2);
      const minimum = RADIUS[a.level] + RADIUS[b.level];
      let force = ((CHARGE[a.level] + CHARGE[b.level]) / 2) * alpha / d2;
      if (d < minimum) force += (minimum - d) * 0.5 / d;
      const fx = dx * force;
      const fy = dy * force;
      a.vx -= fx * a.mobility; a.vy -= fy * a.mobility;
      b.vx += fx * b.mobility; b.vy += fy * b.mobility;
    }
  }
  for (const link of sim.links) {
    const a = sim.nodes.get(link.from);
    const b = sim.nodes.get(link.to);
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const k = ((d - link.length) / d) * link.strength * alpha;
    a.vx += dx * k * a.mobility; a.vy += dy * k * a.mobility;
    b.vx -= dx * k * b.mobility; b.vy -= dy * k * b.mobility;
  }
  for (const node of list) {
    if (node.pinned) { node.vx = 0; node.vy = 0; continue; }
    // Centering keeps disconnected roots on screen.
    node.vx -= node.x * 0.004 * alpha * node.mobility;
    node.vy -= node.y * 0.004 * alpha * node.mobility;
    node.vx *= 0.6; node.vy *= 0.6;
    const speed = Math.hypot(node.vx, node.vy);
    if (speed > 40) { node.vx *= 40 / speed; node.vy *= 40 / speed; }
    node.x += node.vx; node.y += node.vy;
  }
  sim.alpha *= 1 - ALPHA_DECAY;
  return true;
}

export function freePositions(sim: Simulation): Map<NodeId, Point> {
  const positions = new Map<NodeId, Point>();
  for (const [id, node] of sim.nodes) positions.set(id, { x: node.x, y: node.y });
  return positions;
}

export function moveNode(sim: Simulation, id: NodeId, point: Point, pinned: boolean) {
  const node = sim.nodes.get(id);
  if (!node) return;
  node.x = point.x; node.y = point.y; node.vx = 0; node.vy = 0; node.pinned = pinned;
}

const COLUMN = 250;
const ROW: Record<NodeLevel, number> = { generator: 58, publication: 44, message: 32 };

/** Tidy tree, roots on the left: every leaf gets a row, every parent is centred on its children. */
export function hierarchicalLayout(nodes: readonly GraphNode[]): Map<NodeId, Point> {
  const ordered = treeOrder(nodes);
  const ids = new Set(nodes.map((node) => node.id));
  const children = new Map<NodeId, GraphNode[]>();
  const roots: GraphNode[] = [];
  for (const node of ordered) {
    if (node.parent && ids.has(node.parent)) children.set(node.parent, [...(children.get(node.parent) ?? []), node]);
    else roots.push(node);
  }
  const positions = new Map<NodeId, Point>();
  let cursor = 0;
  const place = (node: GraphNode, depth: number): number => {
    const kids = children.get(node.id) ?? [];
    let y: number;
    if (!kids.length || depth > 64) {
      y = cursor + ROW[node.level] / 2;
      cursor += ROW[node.level];
    } else {
      const ys = kids.map((child) => place(child, depth + 1));
      y = (ys[0] + ys[ys.length - 1]) / 2;
    }
    positions.set(node.id, { x: depth * COLUMN, y });
    return y;
  };
  for (const root of roots) {
    place(root, 0);
    cursor += 24;
  }
  // Centre the drawing on the origin like the free layout.
  let maxX = 0;
  for (const point of positions.values()) maxX = Math.max(maxX, point.x);
  const dx = maxX / 2;
  const dy = cursor / 2;
  for (const point of positions.values()) { point.x -= dx; point.y -= dy; }
  return positions;
}
