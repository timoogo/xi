// Resolution of a parsed search against data the viewer may already read (topic catalogue, visible ΞAgents).
// Deterministic and explicit only: exact tag, former tag (alias) or a unique last segment; anything else is a
// suggestion the user picks, never a silent guess.

import { ranked, words } from "../topics/analysis";
import type { Topic } from "../topics/types";
import { parseSearchQuery, topicHref, type SearchQuery } from "./query";

export type SearchAgent = { id: string; handle: string; name: string; description: string; primaryTopicId: string | null; secondaryTopicIds: string[] };
export type TopicMatch = { topic: Topic; via: "tag" | "alias" | "segment" };
/** `ambiguous`: several visible topics share the last segment of an unresolved tag; the user must choose. */
export type TopicReference = { tag: string; match: TopicMatch | null; candidates: Topic[]; ambiguous: boolean };
export type AgentReference = { handle: string; agent: SearchAgent | null; candidates: SearchAgent[] };
/** Direct links between the topics of a crossed search (`#a #b`), read from the hierarchy and declared relations. */
export type TopicLink = { from: string; to: string; kind: "parent" | "related" };
export type SearchResult = {
  query: SearchQuery;
  topics: TopicReference[];
  agents: AgentReference[];
  links: TopicLink[];
  textTopics: Topic[];
  textAgents: SearchAgent[];
  /** Set when the query names exactly one resolved topic or agent and nothing else: open it directly. */
  redirect: string | null;
};

const SUGGESTIONS = 5;
const lastSegment = (tag: string) => tag.slice(tag.lastIndexOf(".") + 1);

/** Exact tag, then former tag; `segments` also accepts a last segment carried by a single topic (`#france`). */
export function resolveTopic(topics: Topic[], tag: string, { segments = false } = {}): TopicMatch | null {
  const exact = topics.find(topic => topic.tag === tag);
  if (exact) return { topic: exact, via: "tag" };
  const alias = topics.find(topic => topic.aliases.includes(tag));
  if (alias) return { topic: alias, via: "alias" };
  if (!segments || tag.includes(".")) return null;
  const leaves = topics.filter(topic => lastSegment(topic.tag) === tag);
  return leaves.length === 1 ? { topic: leaves[0], via: "segment" } : null;
}

function topicCandidates(topics: Topic[], tag: string) {
  const leaf = lastSegment(tag);
  const bySegment = topics.filter(topic => lastSegment(topic.tag) === leaf || topic.aliases.some(alias => lastSegment(alias) === leaf));
  const byWords = ranked(tag.replace(/[.-]/g, " "), topics).map(item => item.topic);
  return [...new Set([...bySegment, ...byWords])].slice(0, SUGGESTIONS);
}

function rankAgents(text: string, agents: SearchAgent[]) {
  const tokens = new Set(words(text));
  if (!tokens.size) return [];
  return agents.map(agent => {
    const identity = new Set(words(`${agent.handle.replace(/[.-]/g, " ")} ${agent.name}`));
    const description = new Set(words(agent.description));
    return { agent, score: [...tokens].filter(w => identity.has(w)).length * 10 + [...tokens].filter(w => description.has(w)).length };
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.agent.handle.localeCompare(b.agent.handle)).map(item => item.agent);
}

function agentCandidates(agents: SearchAgent[], handle: string) {
  const prefixed = agents.filter(agent => agent.handle.startsWith(handle) || handle.startsWith(agent.handle));
  return [...new Set([...prefixed, ...rankAgents(handle.replace(/[.-]/g, " "), agents)])].slice(0, SUGGESTIONS);
}

function linksBetween(topics: Topic[]): TopicLink[] {
  const ids = new Set(topics.map(topic => topic.id));
  const links: TopicLink[] = [];
  for (const topic of topics) {
    if (topic.parentId && ids.has(topic.parentId)) links.push({ from: topic.parentId, to: topic.id, kind: "parent" });
    for (const id of topic.relatedIds) if (ids.has(id)) links.push({ from: topic.id, to: id, kind: "related" });
  }
  return links;
}

/** ΞAgents whose editorial specialization includes the topic, principal first. */
export function topicAgents(topicId: string, agents: SearchAgent[]) {
  return agents
    .map(agent => ({ agent, role: agent.primaryTopicId === topicId ? "principal" as const : agent.secondaryTopicIds.includes(topicId) ? "secondaire" as const : null }))
    .filter((item): item is { agent: SearchAgent; role: "principal" | "secondaire" } => item.role !== null)
    .sort((a, b) => (a.role === b.role ? 0 : a.role === "principal" ? -1 : 1) || a.agent.handle.localeCompare(b.agent.handle));
}

/** `topics` must be the shared catalogue and `agents` only the ΞAgents the viewer may see. */
export function searchCatalog(input: string, topics: Topic[], agents: SearchAgent[]): SearchResult {
  const query = parseSearchQuery(input);
  const topicRefs = query.topics.map(tag => {
    const match = resolveTopic(topics, tag, { segments: true });
    const ambiguous = !match && !tag.includes(".") && topics.filter(topic => lastSegment(topic.tag) === tag).length > 1;
    return { tag, match, candidates: match ? [] : topicCandidates(topics, tag), ambiguous };
  });
  const agentRefs = query.agents.map(handle => {
    const agent = agents.find(item => item.handle === handle) ?? null;
    return { handle, agent, candidates: agent ? [] : agentCandidates(agents, handle) };
  });
  const resolved = [...new Map(topicRefs.flatMap(ref => ref.match ? [[ref.match.topic.id, ref.match.topic] as const] : [])).values()];
  const text = query.text.trim();
  const only = !text && topicRefs.length + agentRefs.length === 1;
  const redirect = !only ? null
    : topicRefs[0]?.match ? topicHref(topicRefs[0].match.topic.tag)
    : agentRefs[0]?.agent ? `/dashboard/profiles/${encodeURIComponent(agentRefs[0].agent.id)}`
    : null;
  return {
    query, topics: topicRefs, agents: agentRefs, links: linksBetween(resolved),
    textTopics: text ? ranked(text, topics).slice(0, 20).map(item => item.topic) : [],
    textAgents: text ? rankAgents(text, agents).slice(0, 20) : [],
    redirect,
  };
}
