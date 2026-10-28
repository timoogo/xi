// Topic network ("Réseau Topics" mode of the graph page): a viewer-scoped, progressively explored sub-graph whose
// nodes are topics and whose edges are relations only. Built on the server from what the viewer may already read
// (topics.visible, relationsOf rules through networkEdges, readable publications, visible ΞAgents): the browser only
// ever receives the displayed nodes and their edges, without justification, evidence nor excerpt.

import { z } from "zod";
import type { NetworkEdge, TopicRelationType } from "./relations";

export const NETWORK_LAYERS = ["knowledge", "interests", "experts"] as const;
export type NetworkLayer = (typeof NETWORK_LAYERS)[number];
export const LAYER_LABELS: Record<NetworkLayer, string> = { knowledge: "Mes connaissances", interests: "Mes centres d’intérêt", experts: "ΞAgents experts" };

/** Labels of the relation types, read from either end (shared by the topic page and the network). */
export const RELATION_TYPE_LABELS: Record<TopicRelationType, { label: string; outgoing: string; incoming: string }> = {
  related_to: { label: "Lié à", outgoing: "Lié à", incoming: "Lié à" },
  similar_to: { label: "Proche de", outgoing: "Proche de", incoming: "Proche de" },
  part_of: { label: "Fait partie de", outgoing: "Fait partie de", incoming: "Comprend" },
  influences: { label: "Influence", outgoing: "Influence", incoming: "Est influencé par" },
  opposes: { label: "S’oppose à", outgoing: "S’oppose à", incoming: "S’oppose à" },
};

/** Initial size and growth steps: the full catalogue is never sent, neighbours come on explicit request. */
export const NETWORK_LIMITS = { seeds: 40, neighbours: 16, open: 12, nodes: 150 } as const;

export type NetworkRequest = { layers: NetworkLayer[]; focus: string | null; open: string[]; proposed: boolean };

const uuid = z.uuid();
const list = (value: string | string[] | undefined) => (Array.isArray(value) ? value.join(",") : value ?? "").split(",").map(item => item.trim()).filter(Boolean);

/** Search params → request. Unknown values are dropped; no `layers` param means every layer. */
export function parseNetworkRequest(params: Record<string, string | string[] | undefined>): NetworkRequest {
  const layers = params.layers === undefined ? [...NETWORK_LAYERS] : NETWORK_LAYERS.filter(layer => list(params.layers).includes(layer));
  const focus = list(params.focus).find(id => uuid.safeParse(id).success) ?? null;
  const open = [...new Set(list(params.open).filter(id => uuid.safeParse(id).success))].slice(0, NETWORK_LIMITS.open);
  return { layers, focus, open, proposed: params.proposed === "1" };
}

/** Request → query string of the graph page, in a stable order (the default layers are omitted). */
export function networkHref(request: NetworkRequest) {
  const params = new URLSearchParams({ view: "topics" });
  if (request.layers.length !== NETWORK_LAYERS.length) params.set("layers", NETWORK_LAYERS.filter(layer => request.layers.includes(layer)).join(","));
  if (request.focus) params.set("focus", request.focus);
  if (request.open.length) params.set("open", request.open.join(","));
  if (request.proposed) params.set("proposed", "1");
  return `/dashboard/graph?${params.toString().replaceAll("%2C", ",")}`;
}

/** A ΞAgent seen from a topic: declared specialization and/or actual contributions (readable, real publications). */
export type NetworkExpert = { id: string; handle: string; name: string; role: "principal" | "secondaire" | null; contributions: number };
export type NetworkNode = {
  id: string; tag: string; name: string; personal: boolean;
  known: boolean; interest: boolean; experts: NetworkExpert[];
  /** Why it is displayed: a layer or the focus, or as the neighbour of an explored topic. */
  origin: "seed" | "focus" | "neighbour";
  /** Neighbours through edges of the current view that are not displayed yet. */
  hiddenNeighbours: number;
};
export type TopicNetwork = {
  request: NetworkRequest;
  nodes: NetworkNode[];
  edges: NetworkEdge[];
  /** Proposals the viewer could display among the displayed topics (shown only on request). */
  proposals: number;
  /** Some layer topics or neighbours were left out by the limits. */
  truncated: boolean;
  counts: Record<NetworkLayer, number>;
};
