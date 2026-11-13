// Knowledge graph of one or several ΞAgents ("Connaissances" mode of the graph page): the concepts Konstruktor
// extracted from each agent's own publications (topics, reused rather than duplicated) and the relations it proposed
// between them, as they stand after human decisions. Several agents give a combined view, never a merge of what is
// stored: a concept (a topic) is drawn once with the agents that know it, a relation keeps each agent's evidence apart.
// Built on the server for the agents' owner only; the browser receives the displayed sub-graph, and a concept's
// publications and web sources are fetched on selection, agent by agent.

import { z } from "zod";
import type { TopicRelationType } from "../topics/relations";

/** Initial size and growth steps, like the topic network: the whole graph is never sent at once. */
export const KNOWLEDGE_LIMITS = { seeds: 40, neighbours: 16, open: 12, nodes: 150, evidence: 5, publications: 20, agents: 50, labels: 3 } as const;

/** `agents`: the selected ΞAgents (none: the first one); `all`: every agent of the owner, whatever `agents` says. */
export type KnowledgeRequest = { agents: string[]; all: boolean; focus: string | null; open: string[]; excluded: boolean };

const uuid = z.uuid();
const list = (value: string | string[] | undefined) => (Array.isArray(value) ? value.join(",") : value ?? "").split(",").map(item => item.trim()).filter(Boolean);
const one = (value: string | string[] | undefined) => list(value).find(id => uuid.safeParse(id).success) ?? null;

export function parseKnowledgeRequest(params: Record<string, string | string[] | undefined>): KnowledgeRequest {
  const all = list(params.agents).includes("all");
  // `agent` is the single-agent form of earlier links.
  const agents = all ? [] : [...new Set([...list(params.agents), ...list(params.agent)].filter(id => uuid.safeParse(id).success))].slice(0, KNOWLEDGE_LIMITS.agents);
  return {
    agents, all, focus: one(params.focus),
    open: [...new Set(list(params.open).filter(id => uuid.safeParse(id).success))].slice(0, KNOWLEDGE_LIMITS.open),
    excluded: params.excluded === "1",
  };
}
export function knowledgeHref(request: KnowledgeRequest) {
  const params = new URLSearchParams({ view: "knowledge" });
  if (request.all) params.set("agents", "all");
  else if (request.agents.length) params.set("agents", request.agents.join(","));
  if (request.focus) params.set("focus", request.focus);
  if (request.open.length) params.set("open", request.open.join(","));
  if (request.excluded) params.set("excluded", "1");
  return `/dashboard/graph?${params.toString().replaceAll("%2C", ",")}`;
}

export type KnowledgeAgent = { id: string; name: string; handle: string };
/** A concept: the topic it was resolved to, and how many publications of the selected agents it was extracted from. */
export type KnowledgeNode = {
  id: string; tag: string; name: string; description: string | null;
  /** Personal topic created for the owner, or a shared catalogue topic reused. */
  personal: boolean;
  publications: number;
  /** The selected agents that know it, in the selector's order, with their own publication counts. */
  agents: { id: string; publications: number }[];
  origin: "seed" | "focus" | "neighbour";
  hiddenNeighbours: number;
};
/**
 * One quoted sentence, with the words the text uses to link the two concepts (« développe », « est un ») and the
 * concept it names as subject: what the sentence says, whatever the relation's type and stored order.
 */
export type KnowledgeEvidence = { publication: string; excerpt: string | null; label: string | null; subject: string | null };
/** What one agent's publications bring to a relation. */
export type KnowledgeProvenance = { agent: string; evidence: KnowledgeEvidence[]; count: number };
/** A recorded relation as stored: status, the owner's own mask, and the last human correction or decision. */
export type KnowledgeEdge = {
  id: string; type: TopicRelationType; source: string; target: string;
  /** Oriented types read source → target; the others are symmetric. */
  directed: boolean;
  status: "proposed" | "accepted" | "excluded";
  /** Masked by the owner for themself (personal exclusion), whatever the status. */
  hidden: boolean;
  origin: "human" | "agent" | "inference";
  createdBy: string;
  confidence: number | null;
  justification: string;
  createdAt: string;
  correction: { from: string; to: string; at: string; reason: string | null } | null;
  decision: { action: "accepted" | "excluded" | "restored"; at: string; reason: string | null } | null;
  /** Evidence per selected agent, from its own publications only: one agent's knowledge is never shown as another's. */
  provenance: KnowledgeProvenance[];
  evidenceCount: number;
  /** The text's own linking words across the selected agents' evidence, distinct (at most KNOWLEDGE_LIMITS.labels). */
  labels: { text: string; subject: string | null }[];
};
export type KnowledgeGraph = {
  request: KnowledgeRequest;
  agents: KnowledgeAgent[];
  /** The agents shown, in the selector's order. Empty when the owner has none, or none of the requested ones is theirs. */
  selected: KnowledgeAgent[];
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
  counts: { concepts: number; publications: number; accepted: number; proposed: number; excluded: number };
  truncated: boolean;
};

/** One publication a concept was extracted from: the quoted sentences and the web sources it cites. */
export type ConceptProvenance = {
  concept: { id: string; tag: string; name: string };
  total: number;
  publications: { id: string; title: string; publishedAt: string | null; visibility: string; quotes: string[]; sources: { title: string; url: string | null; publisher: string | null }[] }[];
};
