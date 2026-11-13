import type { AccountStore } from "../accounts/store";
import type { PublicationStore } from "../publications/store";
import type { TopicRelationStore } from "../topics/relations";
import type { TopicStore } from "../topics/store";
import { isPersonal, TopicError, type Topic } from "../topics/types";
import { conceptKey } from "../search/text";
import { justificationLink } from "./knowledge";
import { KNOWLEDGE_LIMITS, type ConceptProvenance, type KnowledgeEdge, type KnowledgeGraph, type KnowledgeNode, type KnowledgeRequest } from "./knowledge-graph";

type Stores = { accounts: Pick<AccountStore, "list">; topics: Pick<TopicStore, "visible">; relations: Pick<TopicRelationStore, "learnedAmong">; publications: Pick<PublicationStore, "agentMemory" | "get"> };

const ownedAgents = async (viewer: string, accounts: Stores["accounts"]) =>
  (await accounts.list(viewer)).filter(account => account.owner === viewer)
    .map(({ id, name, handle }) => ({ id, name, handle })).sort((a, b) => a.name.localeCompare(b.name, "fr"));

/**
 * What one of the viewer's agents learned: its concepts (from `agentMemory`, so only readable, published, current
 * revisions of its real publications), with the rows each comes from. Read only.
 */
async function learned(viewer: string, agentId: string, topics: Map<string, Topic>, stores: Stores) {
  const rows = await stores.publications.agentMemory(viewer, agentId, "private");
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
const catalogue = async (viewer: string, stores: Stores) => {
  const catalog = await stores.topics.visible(viewer);
  return new Map<string, Topic>([...catalog.shared, ...catalog.personal].map(topic => [topic.id, topic]));
};

type Learned = Awaited<ReturnType<TopicRelationStore["learnedAmong"]>>[number];
/**
 * The text's linking words of one piece of evidence. Evidence recorded before they were stored has them only in
 * Konstruktor's justification, written for the relation's first evidence: read back from there, never guessed.
 */
function evidenceLink(relation: Learned, evidence: Learned["evidence"][number], topics: Map<string, Topic>) {
  const ends = [relation.source, relation.target];
  if (evidence.label) return { label: evidence.label, subject: evidence.subject && ends.includes(evidence.subject) ? evidence.subject : null };
  const legacy = evidence.position === 0 && relation.origin === "inference" ? justificationLink(relation.justification) : null;
  if (!legacy) return { label: null, subject: null };
  const subject = ends.find(id => { const topic = topics.get(id); return topic && conceptKey(topic.name) === conceptKey(legacy.from); }) ?? null;
  return { label: legacy.link, subject };
}

export async function knowledgeGraph(viewer: string, request: KnowledgeRequest, stores: Stores): Promise<KnowledgeGraph> {
  const agents = await ownedAgents(viewer, stores.accounts);
  // Never another user's agent: the requested ones that are the viewer's, every one, or by default the first.
  const owned = new Set(request.agents);
  const selected = request.all ? agents : request.agents.length ? agents.filter(agent => owned.has(agent.id)) : agents.slice(0, 1);
  const base = { request: { ...request, agents: request.all ? [] : request.agents.length ? request.agents : selected.map(agent => agent.id) }, agents, selected };
  const none = { ...base, nodes: [], edges: [], counts: { concepts: 0, publications: 0, accepted: 0, proposed: 0, excluded: 0 }, truncated: false };
  if (!selected.length) return none;
  const topics = await catalogue(viewer, stores);
  const memories = await Promise.all(selected.map(async agent => ({ agent: agent.id, ...await learned(viewer, agent.id, topics, stores) })));

  // The union: a concept is a topic, drawn once, with each agent's own publications kept apart.
  const concepts = new Map<string, { topic: Topic; byAgent: Map<string, Set<string>> }>();
  const author = new Map<string, string>();
  for (const memory of memories) for (const [id, { topic, rows }] of memory.concepts) {
    const entry = concepts.get(id) ?? { topic, byAgent: new Map() };
    entry.byAgent.set(memory.agent, new Set(rows.map(row => row.publication)));
    concepts.set(id, entry);
    for (const row of rows) author.set(row.publication, memory.agent);
  }
  const publications = new Set(author.keys());
  const knows = (agent: string, id: string) => concepts.get(id)?.byAgent.has(agent) ?? false;
  // A relation belongs to an agent through its own publications only, and only between concepts it learned itself.
  const relations = (await stores.relations.learnedAmong(viewer, new Set(concepts.keys()), publications)).map(r => {
    const byAgent = new Map<string, Learned["evidence"]>();
    for (const e of r.evidence) {
      const agent = author.get(e.publication!);
      if (agent && knows(agent, r.source) && knows(agent, r.target)) byAgent.set(agent, [...byAgent.get(agent) ?? [], e]);
    }
    return { ...r, byAgent };
  }).filter(r => r.byAgent.size);
  // Exclusions (global or personal) never pass for validated relations: hidden unless explicitly requested.
  const rejected = (r: (typeof relations)[number]) => r.status === "excluded" || r.hidden;
  const shown = relations.filter(r => request.excluded || !rejected(r));
  const neighbours = new Map<string, Set<string>>();
  for (const r of shown) for (const [a, b] of [[r.source, r.target], [r.target, r.source]]) neighbours.set(a, (neighbours.get(a) ?? new Set()).add(b));
  const sources = (id: string) => new Set([...concepts.get(id)!.byAgent.values()].flatMap(set => [...set])).size;
  const rank = (id: string) => [neighbours.get(id)?.size ?? 0, sources(id)] as const;
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
    const { topic, byAgent } = concepts.get(id)!;
    return {
      id, tag: topic.tag, name: topic.name, description: topic.description?.trim() || null, personal: isPersonal(topic),
      publications: sources(id), agents: selected.filter(agent => byAgent.has(agent.id)).map(agent => ({ id: agent.id, publications: byAgent.get(agent.id)!.size })),
      origin, hiddenNeighbours: [...(neighbours.get(id) ?? [])].filter(other => !displayed.has(other)).length,
    };
  });
  const edges: KnowledgeEdge[] = shown.filter(r => displayed.has(r.source) && displayed.has(r.target)).map(r => {
    const correction = r.history.findLast(entry => entry.action === "type_changed");
    const decision = r.history.findLast(entry => entry.action === "accepted" || entry.action === "excluded" || entry.action === "restored");
    // Excerpts are capped per relation, shared between its agents: each one keeps at least one.
    const each = Math.max(1, Math.floor(KNOWLEDGE_LIMITS.evidence / r.byAgent.size));
    const provenance = selected.filter(agent => r.byAgent.has(agent.id)).map(agent => {
      const own = r.byAgent.get(agent.id)!;
      return { agent: agent.id, count: own.length, evidence: own.slice(0, each).map(e => ({ publication: e.publication!, excerpt: e.excerpt ?? null, ...evidenceLink(r, e, topics) })) };
    });
    const labels = new Map<string, { text: string; subject: string | null }>();
    for (const e of [...r.byAgent.values()].flat()) {
      const { label, subject } = evidenceLink(r, e, topics);
      if (label && labels.size < KNOWLEDGE_LIMITS.labels) labels.set(`${subject}|${label.toLowerCase()}`, { text: label, subject });
    }
    return {
      id: r.id, type: r.type, source: r.source, target: r.target, directed: r.directed, status: r.status, hidden: r.hidden,
      origin: r.origin, createdBy: r.createdBy, confidence: r.confidence, justification: r.justification, createdAt: r.createdAt,
      correction: correction ? { from: correction.from ?? "", to: correction.to ?? "", at: correction.at, reason: correction.reason ?? null } : null,
      decision: decision ? { action: decision.action as "accepted" | "excluded" | "restored", at: decision.at, reason: decision.reason ?? null } : null,
      provenance, evidenceCount: [...r.byAgent.values()].reduce((sum, own) => sum + own.length, 0), labels: [...labels.values()],
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
  const concept = (await learned(viewer, agentId, await catalogue(viewer, stores), stores)).concepts.get(topicId);
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
