import type Database from "better-sqlite3";
import { z } from "zod";
import type { AccountStore } from "../accounts/store";
import type { TopicStore } from "../topics/store";
import { TopicError } from "../topics/types";
import { migrateWatchCandidates } from "./evaluate";
import { createJobQueue } from "./jobs";
import type { Source, SourceStore } from "./sources";

/**
 * Trust matrix of an owner's sources, at three scopes: global (every agent and topic), one ΞAgent,
 * one topic. The global decision is the source's catalogue status (sources.ts: approved, rejected,
 * otherwise pending), with its history and revision; agent and topic decisions live in
 * `watch_source_trust`. No row means pending. For one agent and the topic retained for a story, a
 * denial at any applicable scope wins, then an approval at any scope, else pending.
 *
 * Pending sources are collected and analysed but never establish a claim alone; approved ones may;
 * denied ones are never evidence in their scope (evaluate.ts). A change re-checks the affected
 * candidates through the normal evaluation job (`recheck`): never a draft or a publication here.
 */
export const TRUST_SCOPES = ["global", "agent", "topic"] as const;
export type TrustScope = (typeof TRUST_SCOPES)[number];
export type Trust = "approved" | "pending" | "denied";
export type TrustDecision = { sourceId: string; scope: TrustScope; scopeId: string | null; decision: "approved" | "denied"; by: string; at: string };

const HOUR = 3_600_000;
/** Same horizon as the evaluation planning: older stories are never re-opened by a trust change. */
const RECHECK_MS = 72 * HOUR;

export function migrateSourceTrust(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS watch_source_trust (
      owner TEXT NOT NULL,
      source_id TEXT NOT NULL,
      scope TEXT NOT NULL CHECK (scope IN ('agent', 'topic')),
      scope_id TEXT NOT NULL,
      decision TEXT NOT NULL CHECK (decision IN ('approved', 'denied')),
      decided_by TEXT NOT NULL,
      decided_at INTEGER NOT NULL,
      PRIMARY KEY (owner, source_id, scope, scope_id)
    );`);
}

/** Global trust carried by the catalogue status. A disabled source is not collected and no longer approved. */
const GLOBAL: Record<Source["status"], Trust> = { approved: "approved", rejected: "denied", deleted: "denied", proposed: "pending", disabled: "pending" };
export const globalTrust = (source: Pick<Source, "status">) => GLOBAL[source.status];

/** Denial first, then approval, else pending. */
export const resolveTrust = (decisions: Trust[]): Trust => decisions.includes("denied") ? "denied" : decisions.includes("approved") ? "approved" : "pending";

type TrustRow = { source_id: string; scope: "agent" | "topic"; scope_id: string; decision: "approved" | "denied"; decided_by: string; decided_at: number };
const scopedRows = (db: Database.Database, owner: string) => {
  migrateSourceTrust(db);
  return db.prepare<[string], TrustRow>("SELECT source_id, scope, scope_id, decision, decided_by, decided_at FROM watch_source_trust WHERE owner = ?").all(owner);
};

/**
 * Owner-scoped resolver over one read of the catalogue and of the decisions. `topicId` null: only
 * the global and agent scopes are known (before the topic is retained). A source outside the
 * owner's catalogue is never usable.
 */
export async function trustResolver(db: Database.Database, sources: SourceStore, owner: string) {
  const catalog = new Map((await sources.list(owner, { includeDeleted: true })).sources.map(source => [source.id, source]));
  const scoped = new Map(scopedRows(db, owner).map(row => [`${row.source_id}:${row.scope}:${row.scope_id}`, row.decision]));
  const at = (sourceId: string, scope: "agent" | "topic", id: string | null): Trust => (id && scoped.get(`${sourceId}:${scope}:${id}`)) || "pending";
  const source = (sourceId: string, agentId: string, topicId: string | null): Trust => {
    const entry = catalog.get(sourceId);
    return entry ? resolveTrust([globalTrust(entry), at(sourceId, "agent", agentId), at(sourceId, "topic", topicId)]) : "denied";
  };
  /** An article carried by several feeds: approved if one carrier is, usable unless every carrier is denied. */
  const item = (carriers: string[], agentId: string, topicId: string | null): Trust => {
    const values = carriers.map(id => source(id, agentId, topicId));
    return values.includes("approved") ? "approved" : values.includes("pending") ? "pending" : "denied";
  };
  return { catalog, source, item };
}
export type TrustResolver = Awaited<ReturnType<typeof trustResolver>>;

/** Every feed that carried each item (its first source included). */
export function itemCarriers(db: Database.Database, itemIds: string[]) {
  const carriers = new Map<string, string[]>();
  for (let i = 0; i < itemIds.length; i += 500) {
    const chunk = itemIds.slice(i, i + 500);
    const marks = chunk.map(() => "?").join(", ");
    const rows = db.prepare<string[], { item_id: string; source_id: string }>(`SELECT id AS item_id, source_id FROM watch_item WHERE id IN (${marks})
      UNION SELECT item_id, source_id FROM watch_item_seen WHERE item_id IN (${marks})`).all(...chunk, ...chunk);
    for (const row of rows) carriers.set(row.item_id, [...(carriers.get(row.item_id) ?? []), row.source_id]);
  }
  return carriers;
}

// ---------------------------------------------------------------- matrix

type Deps = { db: Database.Database; accounts: AccountStore; topics: TopicStore; sources: SourceStore; now?: () => Date };

const domainOf = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; } };

/** The owner's view: sources (deleted excluded), their agents with topics, the topics, and every explicit decision. */
export async function trustMatrix({ db, accounts, topics, sources }: Deps, owner: string) {
  const [{ sources: catalog }, watchAgents, accountList, topicList] = await Promise.all([sources.list(owner), accounts.watchAgents(), accounts.list(owner), topics.list()]);
  const names = new Map(accountList.filter(account => account.owner === owner).map(account => [account.id, account.name]));
  const agents = watchAgents.filter(agent => agent.owner === owner && names.has(agent.id))
    .map(agent => ({ id: agent.id, handle: agent.handle, name: names.get(agent.id)!, topicIds: [agent.primaryTopicId, ...agent.secondaryTopicIds] }))
    .sort((a, b) => a.handle.localeCompare(b.handle));
  const used = new Set([...agents.flatMap(agent => agent.topicIds), ...catalog.flatMap(source => source.topicIds)]);
  const decisions: TrustDecision[] = [];
  for (const source of catalog) {
    if (source.status !== "approved" && source.status !== "rejected") continue;
    const entry = source.history.findLast(item => item.action === source.status);
    decisions.push({ sourceId: source.id, scope: "global", scopeId: null, decision: source.status === "approved" ? "approved" : "denied", by: entry?.by ?? owner, at: entry?.at ?? source.updatedAt });
  }
  const known = new Set(catalog.map(source => source.id));
  for (const row of scopedRows(db, owner)) if (known.has(row.source_id)) {
    decisions.push({ sourceId: row.source_id, scope: row.scope, scopeId: row.scope_id, decision: row.decision, by: row.decided_by, at: new Date(row.decided_at).toISOString() });
  }
  return {
    sources: catalog.map(source => ({
      id: source.id, publisher: source.publisher, url: source.url, site: source.site, domain: domainOf(source.site ?? source.url), kind: source.kind,
      status: source.status, revision: source.revision, topicIds: source.topicIds, reliability: source.reliability, createdAt: source.createdAt,
      origin: source.proposedBy.startsWith("agent:") ? { kind: "agent" as const, agentId: source.proposedBy.slice(6) } : { kind: "owner" as const, agentId: null },
    })),
    agents,
    topics: topicList.filter(topic => used.has(topic.id)).map(topic => ({ id: topic.id, tag: topic.tag, name: topic.name })).sort((a, b) => a.tag.localeCompare(b.tag)),
    decisions,
  };
}
export type TrustMatrix = Awaited<ReturnType<typeof trustMatrix>>;

export const trustInputSchema = z.object({
  sourceId: z.uuid(), scope: z.enum(TRUST_SCOPES), scopeId: z.uuid().nullable(),
  decision: z.enum(["approved", "denied", "pending"]),
  /** The source revision: required for a global decision, which changes the catalogue file. */
  revision: z.uuid().optional(), note: z.string().trim().max(1_000).optional(),
}).strict().refine(input => (input.scope === "global") === (input.scopeId === null), "Périmètre invalide.");

const GLOBAL_ACTION = { approved: "approve", denied: "reject", pending: "reset" } as const;

/**
 * One owner decision. Others' sources, agents and topics are 404; a stale global revision is 409.
 * Setting the current value again changes nothing and re-checks nothing.
 */
export async function decideTrust(deps: Deps, owner: string, input: unknown) {
  const { db, accounts, topics, sources, now = () => new Date() } = deps;
  const request = trustInputSchema.parse(input);
  const source = await sources.get(owner, request.sourceId);
  const at = now().getTime();
  let changed: boolean;
  if (request.scope === "global") {
    if (!request.revision) throw new TopicError("Révision de la source requise.", 400);
    changed = globalTrust(source) !== request.decision || source.status === "disabled";
    if (changed) await sources.decide(owner, source.id, { action: GLOBAL_ACTION[request.decision], revision: request.revision, ...(request.note ? { note: request.note } : {}) });
    else if (source.revision !== request.revision) throw new TopicError("La source a changé depuis votre lecture. Rechargez.", 409);
  } else {
    const scopeId = request.scopeId!;
    const agents = (await accounts.watchAgents()).filter(agent => agent.owner === owner);
    if (request.scope === "agent" && !agents.some(agent => agent.id === scopeId)) throw new TopicError("ΞAgent introuvable.", 404);
    if (request.scope === "topic") {
      const followed = new Set([...agents.flatMap(agent => [agent.primaryTopicId, ...agent.secondaryTopicIds]), ...source.topicIds]);
      if (!followed.has(scopeId) || !(await topics.list()).some(topic => topic.id === scopeId)) throw new TopicError("Topic introuvable.", 404);
    }
    migrateSourceTrust(db);
    const key = { owner, source: source.id, scope: request.scope, id: scopeId };
    const current = db.prepare<typeof key, { decision: string }>("SELECT decision FROM watch_source_trust WHERE owner = @owner AND source_id = @source AND scope = @scope AND scope_id = @id").get(key)?.decision ?? "pending";
    changed = current !== request.decision;
    if (changed && request.decision === "pending") db.prepare("DELETE FROM watch_source_trust WHERE owner = @owner AND source_id = @source AND scope = @scope AND scope_id = @id").run(key);
    else if (changed) db.prepare(`INSERT INTO watch_source_trust (owner, source_id, scope, scope_id, decision, decided_by, decided_at) VALUES (@owner, @source, @scope, @id, @decision, @owner, @at)
      ON CONFLICT (owner, source_id, scope, scope_id) DO UPDATE SET decision = excluded.decision, decided_by = excluded.decided_by, decided_at = excluded.decided_at`).run({ ...key, decision: request.decision, at });
  }
  const rechecked = changed ? planTrustRecheck(db, { owner, sourceId: source.id, scope: request.scope, scopeId: request.scopeId, now: at }) : 0;
  return { sourceId: source.id, scope: request.scope, scopeId: request.scopeId, decision: request.decision, changed, rechecked };
}

/**
 * Controlled re-check after a trust change: recent candidates of the owner whose story carries an
 * article of the source, in the changed scope, still at the evaluated version and without a draft
 * (held, accepted, or rejected after their claims were extracted). One queued `recheck` job per
 * candidate at most: the evaluation replays its stored stages, so nothing is asked twice to the
 * model unless the usable sources changed. Drafts are re-checked when they are published.
 */
export function planTrustRecheck(db: Database.Database, { owner, sourceId, scope, scopeId, now }: { owner: string; sourceId: string; scope: TrustScope; scopeId: string | null; now: number }) {
  migrateWatchCandidates(db);
  const queue = createJobQueue(db, () => now);
  const rows = db.prepare<Record<string, unknown>, { agent_id: string; story_id: string; item_count: number }>(`
    SELECT c.agent_id, c.story_id, s.item_count FROM watch_candidate c JOIN watch_story s ON s.id = c.story_id AND s.owner = c.owner
    WHERE c.owner = @owner AND c.story_version = s.item_count AND s.last_seen_at >= @since
      AND (c.status IN ('held', 'accepted') OR (c.status = 'rejected' AND json_extract(c.data, '$.extraction') IS NOT NULL))
      AND json_extract(c.data, '$.draft') IS NULL
      AND (@scope = 'global' OR (@scope = 'agent' AND c.agent_id = @scopeId) OR (@scope = 'topic' AND c.topic_id = @scopeId))
      AND EXISTS (SELECT 1 FROM watch_item i WHERE i.story_id = c.story_id AND (i.source_id = @source OR EXISTS (SELECT 1 FROM watch_item_seen seen WHERE seen.item_id = i.id AND seen.source_id = @source)))`)
    .all({ owner, since: now - RECHECK_MS, scope, scopeId, source: sourceId });
  const queued = db.prepare<[string, string], { n: number }>("SELECT count(*) AS n FROM watch_job WHERE kind = 'evaluate-story' AND state = 'pending' AND json_extract(payload, '$.recheck') = 1 AND json_extract(payload, '$.agentId') = ? AND json_extract(payload, '$.storyId') = ?");
  let planned = 0;
  for (const row of rows) {
    if (queued.get(row.agent_id, row.story_id)!.n) continue;
    if (queue.enqueue({ kind: "evaluate-story", key: `evaluate-story:recheck:${row.agent_id}:${row.story_id}:${now}`, payload: { agentId: row.agent_id, storyId: row.story_id, version: row.item_count, recheck: true }, runAfter: now, maxAttempts: 3 }).created) planned++;
  }
  return planned;
}

/**
 * Publication-time check of the stored claims under the current trust: an established claim stays
 * established only with at least one approved quote; a corroboration that lost a quote to a denial
 * needs two distinct voices among the remaining ones (voices are counted at evaluation otherwise).
 */
export function establishedUnderTrust(db: Database.Database, trust: TrustResolver, { agentId, topicId, claims }: { agentId: string; topicId: string | null; claims: { status: string; evidence: string }[] }) {
  const established = claims.filter(claim => claim.status === "corroborated" || claim.status === "primary");
  const quotes = established.map(claim => (JSON.parse(claim.evidence) as { quotes?: { itemId: string }[] }).quotes ?? []);
  const carriers = itemCarriers(db, [...new Set(quotes.flat().map(quote => quote.itemId))]);
  const lineage = new Map(db.prepare<string[], { id: string; lineage: number }>(`SELECT id, lineage FROM watch_item WHERE id IN (${[...carriers.keys()].map(() => "?").join(", ") || "''"})`).all(...carriers.keys()).map(row => [row.id, row.lineage]));
  return established.filter((claim, i) => {
    const checked = quotes[i].map(quote => ({ lineage: lineage.get(quote.itemId), trust: carriers.has(quote.itemId) ? trust.item(carriers.get(quote.itemId)!, agentId, topicId) : "denied" as const }));
    const usable = checked.filter(quote => quote.trust !== "denied");
    if (!usable.some(quote => quote.trust === "approved")) return false;
    return claim.status === "primary" || usable.length === checked.length || new Set(usable.map(quote => quote.lineage)).size >= 2;
  }).length;
}
