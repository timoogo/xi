import type { AccountStore } from "../accounts/store";
import { getAccountStore } from "../accounts/server";
import { getPublicationStore } from "../publications/server";
import type { PublicationStore } from "../publications/store";
import type { TopicStore } from "../topics/store";
import { getTopicStore } from "../topics/server";
import { TopicError, type Topic } from "../topics/types";
import { searchHref, topicHref } from "./query";
import { searchCatalog, type SearchAgent } from "./resolve";

type Stores = { topics: TopicStore; accounts: AccountStore };

/**
 * The search data a viewer may read: their own personal topics, the shared catalogue, and the ΞAgents visible to
 * them (public ones and their own, as in the account store). Nothing private of another user enters it.
 * Personal topics come first: for their owner, a personal topic answers its exact tag before a shared one
 * created later with the same tag (a shared topic always wins when a personal one would be created).
 */
export async function searchData(viewerId: string, stores?: Stores) {
  const [topics, accounts] = stores ? [stores.topics, stores.accounts] : await Promise.all([getTopicStore(), getAccountStore()]);
  const [{ shared, personal }, visible] = await Promise.all([topics.visible(viewerId), accounts.list(viewerId)]);
  const agents: SearchAgent[] = visible.map(account => ({
    id: account.id, handle: account.handle, name: account.name, description: account.description,
    primaryTopicId: account.editorial?.primaryTopicId ?? null, secondaryTopicIds: account.editorial?.secondaryTopicIds ?? [],
  }));
  return { topics: [...personal, ...shared] as Topic[], agents };
}

/** The viewer's explicit subscriptions that still designate a topic they may see, in subscription order. */
export async function subscribedTopics(viewerId: string, stores?: { topics: TopicStore; publications: PublicationStore }) {
  const [topics, publications] = stores ? [stores.topics, stores.publications] : await Promise.all([getTopicStore(), getPublicationStore()]);
  const [{ shared, personal }, settings] = await Promise.all([topics.visible(viewerId), publications.social({ id: viewerId })]);
  const byId = new Map<string, Topic>([...shared, ...personal].map(topic => [topic.id, topic]));
  return settings.topics.flatMap(id => byId.get(id) ?? []);
}

/**
 * Where a submitted search leads. Creation only happens here, on an explicit submission (never while typing nor on
 * a GET): a query made of exactly one `#tag` that resolves to no visible topic and is not ambiguous opens the
 * viewer's personal topic, created if needed. Everything else shows the results page.
 */
export async function searchTarget(viewerId: string, input: string, stores?: Stores): Promise<string> {
  const { topics, agents } = await searchData(viewerId, stores);
  const result = searchCatalog(input, topics, agents);
  if (result.redirect) return result.redirect;
  const [ref] = result.topics;
  if (!result.query.text && !result.query.agents.length && result.topics.length === 1 && !ref.match && !ref.ambiguous) {
    const { topic } = await (stores?.topics ?? await getTopicStore()).openPersonal(viewerId, ref.tag);
    return topicHref(topic.tag);
  }
  return searchHref(input);
}

/** Subscribes or unsubscribes the viewer, only to a topic they may see. Returns that topic. */
export async function setSubscription(viewerId: string, topicId: string, subscribed: boolean, stores?: { topics: TopicStore; publications: PublicationStore }) {
  return setTopicList(viewerId, "topics", topicId, subscribed, stores);
}

/** "Mes connaissances": an explicit registration by the viewer, never derived from a reading or a search. */
export async function setKnowledge(viewerId: string, topicId: string, known: boolean, stores?: { topics: TopicStore; publications: PublicationStore }) {
  return setTopicList(viewerId, "knowledge", topicId, known, stores);
}

async function setTopicList(viewerId: string, list: "topics" | "knowledge", topicId: string, member: boolean, stores?: { topics: TopicStore; publications: PublicationStore }) {
  const [topics, publications] = stores ? [stores.topics, stores.publications] : await Promise.all([getTopicStore(), getPublicationStore()]);
  const { shared, personal } = await topics.visible(viewerId);
  const topic = [...personal, ...shared].find(item => item.id === topicId);
  if (!topic) throw new TopicError("Topic introuvable.", 404);
  await (list === "topics" ? publications.setTopicSubscription : publications.setTopicKnowledge)({ id: viewerId }, topic.id, member);
  return topic;
}
