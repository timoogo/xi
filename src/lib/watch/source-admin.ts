import type Database from "better-sqlite3";
import { z } from "zod";
import type { AccountStore } from "../accounts/store";
import type { TopicStore } from "../topics/store";
import { TopicError } from "../topics/types";
import { migrateWatchCollection, proposeFromUrl } from "./collect";
import type { PoliteFetch } from "./net";
import { normalizeSourceUrl, statusBeforeDisable, type SourceStore } from "./sources";
import { migrateWatchItems } from "./stories";
import { globalTrust, trustMatrix, trustResolver } from "./trust";

/**
 * Owner management of one catalogue source (the `/dashboard/sources/[id]` page): creation by hand,
 * consolidated detail, edits and status decisions. Trust decisions per ΞAgent and topic stay in
 * trust.ts; deletion is the catalogue tombstone (sources.ts), never a denial.
 */
type Deps = { db: Database.Database; accounts: AccountStore; topics: TopicStore; sources: SourceStore };

/** Topics the owner may attach a source to: those followed by their ΞAgents (plus, for an existing source, its own). */
async function ownerTopics({ accounts }: Deps, owner: string) {
  return new Set((await accounts.watchAgents()).filter(agent => agent.owner === owner).flatMap(agent => [agent.primaryTopicId, ...agent.secondaryTopicIds]));
}

export const createSourceSchema = z.object({ url: z.string().min(1).max(2_000), topicIds: z.array(z.uuid()).min(1).max(30) }).strict();

/**
 * A feed or site address added by the owner: normalized, checked against the catalogue before any
 * request (feed or site already known), then read (feed autodiscovery) and created pending. A
 * deleted source added again comes back pending; a denied one stays denied (reported as known).
 */
export async function createSource(deps: Deps & { fetch: PoliteFetch }, owner: string, input: unknown) {
  const { url: raw, topicIds } = createSourceSchema.parse(input);
  const url = normalizeSourceUrl(raw);
  const allowed = await ownerTopics(deps, owner);
  if (topicIds.some(id => !allowed.has(id))) throw new TopicError("Choisissez des topics suivis par vos ΞAgents.");
  const known = await deps.sources.find(owner, url);
  if (known && known.status !== "deleted") return { source: known, created: false, revived: false, duplicate: true };
  const result = await proposeFromUrl({ fetch: deps.fetch, sources: deps.sources, owner, url, topicIds, by: owner, note: "Ajoutée manuellement par le propriétaire.", revive: true });
  const revived = "revived" in result && !!result.revived;
  return { source: result.source, created: result.created, revived, duplicate: !result.created && !revived };
}

/** Status decisions and edits (`decisionSchema`); attached topics must be followed by the owner's ΞAgents. */
export async function updateSource(deps: Deps, owner: string, id: string, input: unknown) {
  const topicIds = z.object({ edits: z.object({ topicIds: z.array(z.string()).optional() }).passthrough().optional() }).passthrough().safeParse(input).data?.edits?.topicIds;
  if (topicIds) {
    const source = await deps.sources.get(owner, id);
    const allowed = await ownerTopics(deps, owner);
    if (topicIds.some(topic => !allowed.has(topic) && !source.topicIds.includes(topic))) throw new TopicError("Choisissez des topics suivis par vos ΞAgents.");
  }
  return deps.sources.decide(owner, id, input);
}

const ITEMS = 20;
const FETCHES = 10;
/** Links are shown only for web addresses: a feed may carry anything. */
const webLink = (url: string) => { try { return ["http:", "https:"].includes(new URL(url).protocol) ? url : null; } catch { return null; } };

/**
 * Everything known about one source of the owner, nothing estimated: catalogue entry and history,
 * collector state and recent fetches, trust (explicit decisions and what each ΞAgent resolves,
 * per topic), latest collected articles. Others' sources and tombstones are 404.
 */
export async function sourceDetail(deps: Deps, owner: string, id: string) {
  const source = await deps.sources.get(owner, id);
  migrateWatchCollection(deps.db); migrateWatchItems(deps.db);
  const [matrix, resolver] = await Promise.all([trustMatrix(deps, owner), trustResolver(deps.db, deps.sources, owner)]);
  const state = deps.db.prepare<[string], { next_fetch_at: number; last_fetch_at: number | null; last_outcome: string | null; last_error: string | null; consecutive_errors: number }>(
    "SELECT next_fetch_at, last_fetch_at, last_outcome, last_error, consecutive_errors FROM watch_source_state WHERE source_id = ?").get(source.id);
  const fetches = deps.db.prepare<[string, number], { at: number; outcome: string; http_status: number | null; items_new: number; items_seen: number; error: string | null }>(
    "SELECT at, outcome, http_status, items_new, items_seen, error FROM watch_fetch_log WHERE source_id = ? ORDER BY at DESC, id DESC LIMIT ?").all(source.id, FETCHES);
  const items = deps.db.prepare<[string, string, string, number], { id: string; title: string; url: string; original_url: string; published_at: string | null; fetched_at: number }>(
    `SELECT id, title, url, original_url, published_at, fetched_at FROM watch_item WHERE owner = ? AND (source_id = ? OR id IN (SELECT item_id FROM watch_item_seen WHERE source_id = ?))
     ORDER BY fetched_at DESC, rowid DESC LIMIT ?`).all(owner, source.id, source.id, ITEMS);
  return {
    source: { ...matrix.sources.find(item => item.id === source.id)!, ownerGroup: source.ownerGroup, orientation: source.orientation, pollMinutes: source.pollMinutes, updatedAt: source.updatedAt, history: source.history, reenableAs: source.status === "disabled" ? statusBeforeDisable(source) : null },
    globalTrust: globalTrust(source),
    agents: matrix.agents,
    topics: matrix.topics,
    decisions: matrix.decisions.filter(decision => decision.sourceId === source.id),
    /** What each ΞAgent resolves: without a retained topic, then for each of its topics. */
    effective: matrix.agents.map(agent => ({
      agentId: agent.id, trust: resolver.source(source.id, agent.id, null),
      topics: agent.topicIds.map(topicId => ({ topicId, trust: resolver.source(source.id, agent.id, topicId) })),
    })),
    collector: {
      collecting: source.status === "approved" || source.status === "proposed",
      nextFetchAt: state?.next_fetch_at ? new Date(state.next_fetch_at).toISOString() : null,
      lastFetchAt: state?.last_fetch_at ? new Date(state.last_fetch_at).toISOString() : null,
      lastOutcome: state?.last_outcome ?? null, lastError: state?.last_error ?? null, consecutiveErrors: state?.consecutive_errors ?? 0,
      fetches: fetches.map(row => ({ at: new Date(row.at).toISOString(), outcome: row.outcome, httpStatus: row.http_status, itemsNew: row.items_new, itemsSeen: row.items_seen, error: row.error })),
    },
    items: items.map(row => ({ id: row.id, title: row.title, url: webLink(row.original_url) ?? webLink(row.url), publishedAt: row.published_at, fetchedAt: new Date(row.fetched_at).toISOString() })),
  };
}
export type SourceDetail = Awaited<ReturnType<typeof sourceDetail>>;
