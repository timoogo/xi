// Server side of the topic network: loads only what the viewer may read and keeps the displayed sub-graph.

import type { AccountStore } from "../accounts/store";
import type { PublicationStore } from "../publications/store";
import { searchData } from "../search/server";
import { NETWORK_LIMITS, type NetworkExpert, type NetworkNode, type NetworkRequest, type TopicNetwork } from "./network";
import type { NetworkEdge, TopicRelationStore } from "./relations";
import type { TopicStore } from "./store";
import { isPersonal, type Topic } from "./types";

type Stores = { topics: TopicStore; relations: TopicRelationStore; publications: PublicationStore; accounts: AccountStore };

export async function topicNetwork(viewer: string, request: NetworkRequest, stores: Stores): Promise<TopicNetwork> {
  const { topics, agents } = await searchData(viewer, stores);
  const byId = new Map<string, Topic>(topics.map(topic => [topic.id, topic]));
  const [settings, allEdges, contributions] = await Promise.all([
    stores.publications.social({ id: viewer }),
    stores.relations.networkEdges(viewer, { proposed: true }),
    stores.publications.agentContributions(viewer, agents.map(agent => agent.id)),
  ]);
  const known = settings.knowledge.filter(id => byId.has(id));
  const interests = settings.topics.filter(id => byId.has(id));

  // Experts: a visible agent's declared topics, and the topics of its publications the viewer can read.
  const experts = new Map<string, Map<string, NetworkExpert>>();
  const expertOf = (topicId: string, agent: (typeof agents)[number]) => {
    const forTopic = experts.get(topicId) ?? new Map<string, NetworkExpert>();
    experts.set(topicId, forTopic);
    const entry = forTopic.get(agent.id) ?? { id: agent.id, handle: agent.handle, name: agent.name, role: null, contributions: 0 };
    forTopic.set(agent.id, entry);
    return entry;
  };
  const agentById = new Map(agents.map(agent => [agent.id, agent]));
  for (const agent of agents) {
    if (agent.primaryTopicId && byId.has(agent.primaryTopicId)) expertOf(agent.primaryTopicId, agent).role = "principal";
    for (const id of agent.secondaryTopicIds) if (byId.has(id)) expertOf(id, agent).role ??= "secondaire";
  }
  for (const row of contributions) {
    const agent = agentById.get(row.agent_id);
    if (agent && byId.has(row.topic_id)) expertOf(row.topic_id, agent).contributions += row.count;
  }
  const weight = (id: string) => [...(experts.get(id)?.values() ?? [])].reduce((sum, e) => sum + e.contributions + (e.role ? 1 : 0), 0);
  const expertTopics = [...experts.keys()].sort((a, b) => weight(b) - weight(a) || byId.get(a)!.name.localeCompare(byId.get(b)!.name, "fr"));

  const active = new Set(request.layers);
  const candidates = [
    ...(active.has("knowledge") ? known : []), ...(active.has("interests") ? interests : []), ...(active.has("experts") ? expertTopics : []),
  ];
  const seeds = [...new Set(candidates)];
  const displayed = new Map<string, NetworkNode["origin"]>();
  const focus = request.focus && byId.has(request.focus) ? request.focus : null;
  if (focus) displayed.set(focus, "focus");
  for (const id of seeds) {
    if (displayed.size >= NETWORK_LIMITS.seeds) break;
    if (!displayed.has(id)) displayed.set(id, "seed");
  }
  let truncated = seeds.some(id => !displayed.has(id));

  // Progressive exploration: each explored topic (in request order) brings its neighbours, within the limits.
  const edges = allEdges.filter(edge => edge.status === "accepted" || request.proposed);
  const neighbours = new Map<string, Set<string>>();
  for (const edge of edges) {
    for (const [a, b] of [[edge.source, edge.target], [edge.target, edge.source]]) {
      if (!neighbours.has(a)) neighbours.set(a, new Set());
      neighbours.get(a)!.add(b);
    }
  }
  const byName = (a: string, b: string) => byId.get(a)!.name.localeCompare(byId.get(b)!.name, "fr") || a.localeCompare(b);
  for (const id of request.open) {
    if (!displayed.has(id)) continue;
    const next = [...(neighbours.get(id) ?? [])].filter(other => !displayed.has(other)).sort(byName);
    for (const [i, other] of next.entries()) {
      if (i >= NETWORK_LIMITS.neighbours || displayed.size >= NETWORK_LIMITS.nodes) { truncated = true; break; }
      displayed.set(other, "neighbour");
    }
  }

  const nodes = [...displayed].map(([id, origin]): NetworkNode => {
    const topic = byId.get(id)!;
    return {
      id, tag: topic.tag, name: topic.name, personal: isPersonal(topic), origin,
      known: known.includes(id), interest: interests.includes(id),
      experts: [...(experts.get(id)?.values() ?? [])].sort((a, b) => b.contributions - a.contributions || a.handle.localeCompare(b.handle)),
      hiddenNeighbours: [...(neighbours.get(id) ?? [])].filter(other => !displayed.has(other)).length,
    };
  });
  const shown = (edge: NetworkEdge) => displayed.has(edge.source) && displayed.has(edge.target);
  return {
    request, nodes, edges: edges.filter(shown), truncated,
    proposals: allEdges.filter(edge => edge.status === "proposed" && shown(edge)).length,
    counts: { knowledge: known.length, interests: interests.length, experts: expertTopics.length },
  };
}
