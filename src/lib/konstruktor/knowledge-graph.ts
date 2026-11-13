// Knowledge graph of one ΞAgent ("Connaissances" mode of the graph page): the concepts Konstruktor extracted from the
// agent's own publications (topics, reused rather than duplicated) and the relations it proposed between them, as
// they stand after human decisions. Built on the server for the agent's owner only; the browser receives the displayed
// sub-graph, and a concept's publications and web sources are fetched on selection.

import { z } from "zod";
import type { TopicRelationType } from "../topics/relations";

/** Initial size and growth steps, like the topic network: the whole graph is never sent at once. */
export const KNOWLEDGE_LIMITS = { seeds: 40, neighbours: 16, open: 12, nodes: 150, evidence: 5, publications: 20 } as const;

export type KnowledgeRequest = { agent: string | null; focus: string | null; open: string[]; excluded: boolean };

const uuid = z.uuid();
const list = (value: string | string[] | undefined) => (Array.isArray(value) ? value.join(",") : value ?? "").split(",").map(item => item.trim()).filter(Boolean);
const one = (value: string | string[] | undefined) => list(value).find(id => uuid.safeParse(id).success) ?? null;

export function parseKnowledgeRequest(params: Record<string, string | string[] | undefined>): KnowledgeRequest {
  return {
    agent: one(params.agent), focus: one(params.focus),
    open: [...new Set(list(params.open).filter(id => uuid.safeParse(id).success))].slice(0, KNOWLEDGE_LIMITS.open),
    excluded: params.excluded === "1",
  };
}
export function knowledgeHref(request: KnowledgeRequest) {
  const params = new URLSearchParams({ view: "knowledge" });
  if (request.agent) params.set("agent", request.agent);
  if (request.focus) params.set("focus", request.focus);
  if (request.open.length) params.set("open", request.open.join(","));
  if (request.excluded) params.set("excluded", "1");
  return `/dashboard/graph?${params.toString().replaceAll("%2C", ",")}`;
}

export type KnowledgeAgent = { id: string; name: string; handle: string };
/** A concept: the topic it was resolved to, and how many of the agent's publications it was extracted from. */
export type KnowledgeNode = {
  id: string; tag: string; name: string; description: string | null;
  /** Personal topic created for the owner, or a shared catalogue topic reused. */
  personal: boolean;
  publications: number;
  origin: "seed" | "focus" | "neighbour";
  hiddenNeighbours: number;
};
export type KnowledgeEvidence = { publication: string; excerpt: string | null };
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
  /** Evidence from this agent's publications only. */
  evidence: KnowledgeEvidence[];
  evidenceCount: number;
};
export type KnowledgeGraph = {
  request: KnowledgeRequest;
  agents: KnowledgeAgent[];
  /** Null when the owner has no agent, or the requested one is not theirs. */
  agent: KnowledgeAgent | null;
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
