// Layout of the topic network, on the force simulation of the tree's free mode. Positions are deterministic (hash of
// the id) and settle synchronously; topics already placed barely move when neighbours are added, so exploring never
// reshuffles the drawing. Pure helpers for keyboard navigation live here too.

import { createSimulation, hash, tick, type Point, type Simulation } from "./layout";

export { createSimulation, type Point, type Simulation };

const LINK_LENGTH = 150;

/** Adds new topics next to an already placed neighbour, forgets removed ones, rebuilds the springs and settles. */
export function syncTopicLayout(sim: Simulation, ids: readonly string[], edges: readonly { source: string; target: string }[]) {
  const present = new Set(ids);
  for (const [id, node] of sim.nodes) {
    if (present.has(id)) continue;
    sim.memory.set(id, { x: node.x, y: node.y });
    sim.nodes.delete(id);
  }
  const neighbours = new Map<string, string[]>();
  for (const { source, target } of edges) {
    neighbours.set(source, [...(neighbours.get(source) ?? []), target]);
    neighbours.set(target, [...(neighbours.get(target) ?? []), source]);
  }
  let added = 0;
  for (const id of ids) {
    const existing = sim.nodes.get(id);
    if (existing) { existing.mobility = 0.12; continue; }
    const anchor = (neighbours.get(id) ?? []).map(other => sim.nodes.get(other)).find(Boolean);
    const angle = hash(id) * Math.PI * 2;
    const distance = anchor ? LINK_LENGTH * (0.7 + hash(`${id}#`) * 0.5) : 320 * Math.sqrt(hash(`${id}r`));
    const origin = anchor ?? { x: 0, y: 0 };
    const point = sim.memory.get(id) ?? { x: origin.x + Math.cos(angle) * distance, y: origin.y + Math.sin(angle) * distance };
    sim.nodes.set(id, { ...point, vx: 0, vy: 0, level: "publication", mobility: 1, pinned: false });
    added++;
  }
  sim.links = edges.filter(e => sim.nodes.has(e.source) && sim.nodes.has(e.target)).map(e => ({ from: e.source, to: e.target, length: LINK_LENGTH, strength: 0.3 }));
  if (added) sim.alpha = Math.max(sim.alpha, sim.nodes.size === added ? 1 : 0.5);
  while (tick(sim)) { /* settle synchronously: stable positions, no animation */ }
  return added;
}

export type Direction = "left" | "right" | "up" | "down";

/** Nearest topic in a direction (within a 45° cone on each side), for arrow-key navigation between nodes. */
export function nearestIn(from: Point, direction: Direction, candidates: Iterable<[string, Point]>): string | null {
  let best: string | null = null;
  let bestScore = Infinity;
  for (const [id, point] of candidates) {
    const dx = point.x - from.x, dy = point.y - from.y;
    const along = direction === "right" ? dx : direction === "left" ? -dx : direction === "down" ? dy : -dy;
    const across = direction === "left" || direction === "right" ? Math.abs(dy) : Math.abs(dx);
    if (along <= 0 || across > along) continue;
    const score = along + across * 2;
    if (score < bestScore) { bestScore = score; best = id; }
  }
  return best;
}
