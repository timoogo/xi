import type { AccountStore } from "../accounts/store";
import type { PublicationStore } from "../publications/store";
import type { TopicRelationStore } from "../topics/relations";
import type { TopicStore } from "../topics/store";
import { isPersonal, TopicError, type Topic } from "../topics/types";
import { KNOWLEDGE_LIMITS, type ConceptProvenance, type KnowledgeEdge, type KnowledgeGraph, type KnowledgeNode, type KnowledgeRequest } from "./knowledge-graph";

type Stores = { accounts: Pick<AccountStore, "list">; topics: Pick<TopicStore, "visible">; relations: Pick<TopicRelationStore, "learnedAmong">; publications: Pick<PublicationStore, "agentMemory" | "get"> };

const ownedAgents = async (viewer: string, accounts: Stores["accounts"]) =>
  (await accounts.list(viewer)).filter(account => account.owner === viewer)
    .map(({ id, name, handle }) => ({ id, name, handle })).sort((a, b) => a.name.localeCompare(b.name, "fr"));

/**
 * What one of the viewer's agents learned: its concepts (from `agentMemory`, so only readable, published, current
 * revisions of its real publications) and the relations resting on those publications. Read only.
 */
async function learned(viewer: string, agentId: string, stores: Stores) {
  const [rows, catalog] = await Promise.all([stores.publications.agentMemory(viewer, agentId, "private"), stores.topics.visible(viewer)]);
  const topics = new Map<string, Topic>([...catalog.shared, ...catalog.personal].map(topic => [topic.id, topic]));
  const concepts = new Map<string, { topic: Topic; rows: typeof rows }>();
  for (const row of rows) {
    const topic = topics.get(row.topic);
    if (!topic) continue;
    const entry = concepts.get(topic.id) ?? { topic, rows: [] };
    entry.rows.push(row);
    concepts.set(topic.id, entry);
  }
  return { rows, concepts };
}

export async function knowledgeGraph(viewer: string, request: KnowledgeRequest, stores: Stores): Promise<KnowledgeGraph> {
  const agents = await ownedAgents(viewer, stores.accounts);
  // Never another user's agent, and never several agents at once: the requested one, or by default the first.
  const agent = request.agent ? agents.find(item => item.id === request.agent) ?? null : agents[0] ?? null;
  const base = { request: { ...request, agent: agent?.id ?? request.agent }, agents, agent };
  const none = { ...base, nodes: [], edges: [], counts: { concepts: 0, publications: 0, accepted: 0, proposed: 0, excluded: 0 }, truncated: false };
  if (!agent) return none;
  const { rows, concepts } = await learned(viewer, agent.id, stores);
  const publications = new Set(rows.map(row => row.publication));
  const relations = await stores.relations.learnedAmong(viewer, new Set(concepts.keys()), publications);
  // Exclusions (global or personal) never pass for validated relations: hidden unless explicitly requested.
  const rejected = (r: (typeof relations)[number]) => r.status === "excluded" || r.hidden;
  const shown = relations.filter(r => request.excluded || !rejected(r));
  const neighbours = new Map<string, Set<string>>();
  for (const r of shown) for (const [a, b] of [[r.source, r.target], [r.target, r.source]]) neighbours.set(a, (neighbours.get(a) ?? new Set()).add(b));
  const rank = (id: string) => [neighbours.get(id)?.size ?? 0, new Set(concepts.get(id)!.rows.map(row => row.publication)).size] as const;
  const order = (a: string, b: string) => { const [da, pa] = rank(a), [db, pb] = rank(b); return db - da || pb - pa || concepts.get(a)!.topic.name.localeCompare(concepts.get(b)!.topic.name, "fr"); };

  const displayed = new Map<string, KnowledgeNode["origin"]>();
  const add = (id: string, origin: KnowledgeNode["origin"]) => { if (concepts.has(id) && !displayed.has(id) && displayed.size < KNOWLEDGE_LIMITS.nodes) displayed.set(id, origin); };
  if (request.focus) add(request.focus, "focus");
  for (const id of [...concepts.keys()].sort(order).slice(0, KNOWLEDGE_LIMITS.seeds)) add(id, "seed");
  for (const id of request.open) {
    add(id, "neighbour");
    // Each exploration brings neighbours not displayed yet (the best-ranked ones often already are, as seeds).
    for (const other of [...(neighbours.get(id) ?? [])].filter(other => !displayed.has(other)).sort(order).slice(0, KNOWLEDGE_LIMITS.neighbours)) add(other, "neighbour");
  }

  const nodes: KnowledgeNode[] = [...displayed].map(([id, origin]) => {
    const { topic, rows: own } = concepts.get(id)!;
    return {
      id, tag: topic.tag, name: topic.name, description: topic.description?.trim() || null, personal: isPersonal(topic),
      publications: new Set(own.map(row => row.publication)).size, origin,
      hiddenNeighbours: [...(neighbours.get(id) ?? [])].filter(other => !displayed.has(other)).length,
    };
  });
  const edges: KnowledgeEdge[] = shown.filter(r => displayed.has(r.source) && displayed.has(r.target)).map(r => {
    const correction = r.history.findLast(entry => entry.action === "type_changed");
    const decision = r.history.findLast(entry => entry.action === "accepted" || entry.action === "excluded" || entry.action === "restored");
    return {
      id: r.id, type: r.type, source: r.source, target: r.target, directed: r.directed, status: r.status, hidden: r.hidden,
      origin: r.origin, createdBy: r.createdBy, confidence: r.confidence, justification: r.justification, createdAt: r.createdAt,
      correction: correction ? { from: correction.from ?? "", to: correction.to ?? "", at: correction.at, reason: correction.reason ?? null } : null,
      decision: decision ? { action: decision.action as "accepted" | "excluded" | "restored", at: decision.at, reason: decision.reason ?? null } : null,
      evidence: r.evidence.slice(0, KNOWLEDGE_LIMITS.evidence).map(e => ({ publication: e.publication!, excerpt: e.excerpt ?? null })),
      evidenceCount: r.evidence.length,
    };
  });
  const active = relations.filter(r => !rejected(r));
  return {
    ...base, nodes, edges,
    counts: { concepts: concepts.size, publications: publications.size, accepted: active.filter(r => r.status === "accepted").length, proposed: active.filter(r => r.status === "proposed").length, excluded: relations.length - active.length },
    truncated: displayed.size < concepts.size,
  };
}

/** The publications (and their web sources) one concept of the viewer's agent was extracted from. 404 otherwise. */
export async function conceptProvenance(viewer: string, agentId: string, topicId: string, stores: Stores): Promise<ConceptProvenance> {
  if (!(await ownedAgents(viewer, stores.accounts)).some(agent => agent.id === agentId)) throw new TopicError("ΞAgent introuvable.", 404);
  const concept = (await learned(viewer, agentId, stores)).concepts.get(topicId);
  if (!concept) throw new TopicError("Concept introuvable pour ce ΞAgent.", 404);
  const quotes = new Map<string, string[]>();
  for (const row of concept.rows) quotes.set(row.publication, [...(quotes.get(row.publication) ?? []), row.excerpt]);
  const publications = await Promise.all([...quotes].slice(0, KNOWLEDGE_LIMITS.publications).map(async ([id, excerpts]) => {
    const publication = await stores.publications.get({ id: viewer }, id);
    return {
      id, title: publication.summary, publishedAt: publication.publishedAt, visibility: publication.visibility, quotes: excerpts,
      sources: publication.sources.map(source => ({ title: source.title, url: source.url, publisher: source.publisher })),
    };
  }));
  return { concept: { id: concept.topic.id, tag: concept.topic.tag, name: concept.topic.name }, total: quotes.size, publications };
}
