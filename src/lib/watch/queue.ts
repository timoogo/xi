import type Database from "better-sqlite3";
import { migrateWatchCandidates } from "./evaluate";

/**
 * The common editorial queue: every content ready to publish, whatever its ΞAgent, waiting for the
 * central diffuser (publisher.ts `diffuse`). Preparing a content (evaluation, drafting) never depends
 * on when it will go out: a draft ready at 23:00 waits here for its agent's publish window.
 *
 * - The queue is a projection of drafted candidates (`watch_candidate`, the single source of what is
 *   ready), one row per draft (its deterministic id): `sync` adds what became ready and records what
 *   left (published, withdrawn) at every pass, so it is idempotent, resumes after any interruption and
 *   migrates drafts prepared before it existed, without publishing anything itself.
 * - States: `ready`, then `published`, `withdrawn` (rejected, held, re-evaluated, retired) or
 *   `expired` (too old to publish, see MAX_AGE); a row leaves `ready` once.
 * - Freshness: `origin_at` is the news' first publication by a source; `expires_at` the limit after
 *   which it is never published.
 */
export type QueueState = "ready" | "published" | "withdrawn" | "expired";
export type QueueItem = {
  draftId: string; owner: string; agentId: string; storyId: string; storyVersion: number; topicId: string | null;
  lane: "night" | "immediate"; weekly: boolean; importance: number; relevance: number; originAt: number; expiresAt: number;
  state: QueueState; reason: string | null; readyAt: number; updatedAt: number;
};

const HOUR = 3_600_000;
/** A news item is not published after this age (from its first publication by a source); an alert waiting in the queue has the night one. */
export const MAX_AGE = { immediate: 6 * HOUR, night: 36 * HOUR, weekly: 8 * 24 * HOUR };

export function migrateEditorialQueue(db: Database.Database) {
  migrateWatchCandidates(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS editorial_queue (
      draft_id TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      story_id TEXT NOT NULL,
      story_version INTEGER NOT NULL,
      topic_id TEXT,
      lane TEXT NOT NULL CHECK (lane IN ('night', 'immediate')),
      weekly INTEGER NOT NULL DEFAULT 0,
      importance REAL NOT NULL,
      relevance REAL NOT NULL,
      origin_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('ready', 'published', 'withdrawn', 'expired')),
      reason TEXT,
      ready_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS editorial_queue_ready ON editorial_queue (state, agent_id);
    CREATE INDEX IF NOT EXISTS editorial_queue_owner ON editorial_queue (owner, updated_at);
  `);
}

type Row = { draft_id: string; owner: string; agent_id: string; story_id: string; story_version: number; topic_id: string | null; lane: "night" | "immediate"; weekly: number; importance: number; relevance: number; origin_at: number; expires_at: number; state: QueueState; reason: string | null; ready_at: number; updated_at: number };
const toItem = (row: Row): QueueItem => ({
  draftId: row.draft_id, owner: row.owner, agentId: row.agent_id, storyId: row.story_id, storyVersion: row.story_version, topicId: row.topic_id, lane: row.lane, weekly: row.weekly === 1,
  importance: row.importance, relevance: row.relevance, originAt: row.origin_at, expiresAt: row.expires_at, state: row.state, reason: row.reason, readyAt: row.ready_at, updatedAt: row.updated_at,
});

/**
 * Brings the queue in line with the candidates, in one transaction (safe with concurrent workers):
 * a drafted candidate with a validated draft is `ready`; a ready row whose draft is no longer the
 * candidate's drafted one is `published` (the candidate was) or `withdrawn`. Returns the changes.
 */
export function syncEditorialQueue(db: Database.Database, now: number) {
  migrateEditorialQueue(db);
  return db.transaction(() => {
    const added = db.prepare(`INSERT INTO editorial_queue (draft_id, owner, agent_id, story_id, story_version, topic_id, lane, weekly, importance, relevance, origin_at, expires_at, state, reason, ready_at, updated_at)
      SELECT json_extract(c.data, '$.draft.id'), c.owner, c.agent_id, c.story_id, c.story_version, c.topic_id, c.lane, coalesce(json_extract(c.data, '$.weeklySelected'), 0),
        coalesce(c.importance, 0), coalesce(c.relevance, 0), o.origin,
        o.origin + CASE WHEN json_extract(c.data, '$.weeklySelected') THEN @weekly ELSE @night END, 'ready', NULL, @now, @now
      FROM watch_candidate c
      JOIN (SELECT id, owner, coalesce(CAST(strftime('%s', first_published_at) AS INTEGER) * 1000, first_seen_at) AS origin FROM watch_story) o ON o.id = c.story_id AND o.owner = c.owner
      WHERE c.status = 'drafted' AND c.lane IN ('night', 'immediate') AND json_extract(c.data, '$.draft.id') IS NOT NULL AND json_extract(c.data, '$.draft.revision') IS NOT NULL
      ON CONFLICT (draft_id) DO NOTHING`).run({ now, night: MAX_AGE.night, weekly: MAX_AGE.weekly }).changes;
    // A candidate back to `drafted` after a refusal keeps its row: the lane and selection follow it.
    db.prepare(`UPDATE editorial_queue SET lane = c.lane, weekly = coalesce(json_extract(c.data, '$.weeklySelected'), 0), importance = coalesce(c.importance, 0), updated_at = @now
      FROM watch_candidate c WHERE editorial_queue.state = 'ready' AND c.agent_id = editorial_queue.agent_id AND c.story_id = editorial_queue.story_id AND c.status = 'drafted'
        AND json_extract(c.data, '$.draft.id') = editorial_queue.draft_id AND c.lane IN ('night', 'immediate') AND (c.lane != editorial_queue.lane OR coalesce(json_extract(c.data, '$.weeklySelected'), 0) != editorial_queue.weekly)`).run({ now });
    const left = db.prepare<[], { draft_id: string; status: string | null; reason: string | null; current: string | null }>(`SELECT q.draft_id, c.status, c.reason, json_extract(c.data, '$.draft.id') AS current FROM editorial_queue q
      LEFT JOIN watch_candidate c ON c.agent_id = q.agent_id AND c.story_id = q.story_id
      WHERE q.state = 'ready' AND (c.status IS NULL OR c.status != 'drafted' OR c.lane NOT IN ('night', 'immediate') OR json_extract(c.data, '$.draft.id') IS NOT q.draft_id)`).all();
    const close = db.prepare("UPDATE editorial_queue SET state = ?, reason = ?, updated_at = ? WHERE draft_id = ? AND state = 'ready'");
    let published = 0, withdrawn = 0;
    for (const row of left) {
      const done = row.status === "published" && row.current === row.draft_id;
      close.run(done ? "published" : "withdrawn", done ? "Publiée." : (row.reason ?? "Retirée : le candidat n’est plus prêt à publier.").slice(0, 500), now, row.draft_id);
      if (done) published++; else withdrawn++;
    }
    return { added, published, withdrawn };
  })();
}

export function readyItems(db: Database.Database) {
  migrateEditorialQueue(db);
  return db.prepare<[], Row>("SELECT * FROM editorial_queue WHERE state = 'ready' ORDER BY ready_at, draft_id").all().map(toItem);
}
export const hasReady = (db: Database.Database) => { migrateEditorialQueue(db); return !!db.prepare("SELECT 1 FROM editorial_queue WHERE state = 'ready' LIMIT 1").get(); };

/** Leaves `ready` once (first writer wins). */
export function closeItem(db: Database.Database, draftId: string, state: Exclude<QueueState, "ready">, reason: string, now: number) {
  return db.prepare("UPDATE editorial_queue SET state = ?, reason = ?, updated_at = ? WHERE draft_id = ? AND state = 'ready'").run(state, reason.slice(0, 500), now, draftId).changes === 1;
}

/** The owner's queue, most recent first (diagnostics, supervision); `agentIds` and `states` narrow it. */
export function ownerQueue(db: Database.Database, owner: string, limit = 50, { agentIds, states }: { agentIds?: readonly string[]; states?: readonly QueueState[] } = {}) {
  migrateEditorialQueue(db);
  const list = (values: readonly string[]) => values.map(() => "?").join(", ");
  return db.prepare<unknown[], Row>(`SELECT * FROM editorial_queue WHERE owner = ? ${agentIds ? `AND agent_id IN (${list(agentIds)})` : ""} ${states ? `AND state IN (${list(states)})` : ""} ORDER BY updated_at DESC, draft_id LIMIT ?`)
    .all(owner, ...(agentIds ?? []), ...(states ?? []), Math.min(limit, 500)).map(toItem);
}
/** Items per state for the owner (same narrowing). */
export function queueCounts(db: Database.Database, owner: string, agentIds?: readonly string[]) {
  migrateEditorialQueue(db);
  const rows = db.prepare<unknown[], { state: QueueState; n: number }>(`SELECT state, count(*) AS n FROM editorial_queue WHERE owner = ? ${agentIds ? `AND agent_id IN (${agentIds.map(() => "?").join(", ")})` : ""} GROUP BY state`).all(owner, ...(agentIds ?? []));
  return Object.fromEntries((["ready", "published", "withdrawn", "expired"] as const).map(state => [state, rows.find(row => row.state === state)?.n ?? 0])) as Record<QueueState, number>;
}
