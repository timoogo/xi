import type Database from "better-sqlite3";
import { z } from "zod";
import type { WatchAgent } from "../accounts/types";
import { TopicError } from "../topics/types";
import { intervals } from "../xiagents/calendar";
import { agentSchedule, nextWatchOpening, watchOpen, watchWindowEnd, DEFAULT_RETENTION_DAYS } from "../xiagents/schedule";
import { FeedError } from "./feeds";
import { InferenceConfigError, InferenceUnavailableError } from "./inference";
import type { Job } from "./jobs";
import { FetchError } from "./net";

/**
 * Orchestration of the ΞAgents on top of the durable queue (jobs.ts):
 * - admission: calendars, pauses and grants are checked when a task starts, even after waiting;
 * - grants: bounded permissions to watch outside the calendar (catch-up after an outage or a
 *   pause, manual run). They never open a publication calendar;
 * - execution history (`xiagent_run`): one row per attempt, with real results and logs only;
 * - error classification for retries.
 */
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** A gap between two worker passes longer than this is an involuntary outage (timer: 10 min). */
export const OUTAGE_MS = 30 * MINUTE;

export type Trigger = "calendar" | "manual" | "catch-up" | "major-event";
export const TRIGGER_LABELS: Record<Trigger, string> = { calendar: "Calendrier", manual: "Manuel", "catch-up": "Rattrapage", "major-event": "Événement majeur" };
/** Monitoring tasks follow the watch calendar; publication tasks check the publish calendar themselves. */
export const WATCH_KINDS = ["discover-sources", "evaluate-story", "draft-candidate"] as const;
export const PUBLISH_KINDS = ["publication-window", "weekly-review", "publish-alert"] as const;
/** Kinds that call the local model: their concurrency is limited across processes. */
/** Jobs that call the local model: they share XI_INFERENCE_CONCURRENCY across processes. */
export const INFERENCE_KINDS = ["evaluate-story", "draft-candidate", "enrich-publication"] as const;

const jobAgentId = (job: Pick<Job, "payload">) => (job.payload as { agentId?: unknown } | null)?.agentId;
export const jobAgent = (job: Pick<Job, "payload">) => typeof jobAgentId(job) === "string" ? jobAgentId(job) as string : null;
export const jobTrigger = (job: Pick<Job, "payload">): Trigger => {
  const value = (job.payload as { trigger?: unknown } | null)?.trigger;
  return value === "manual" || value === "catch-up" || value === "major-event" ? value : "calendar";
};

export function migrateOrchestrator(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS xiagent_run (
      id TEXT PRIMARY KEY,
      job_id TEXT,
      agent_id TEXT,
      owner TEXT NOT NULL,
      kind TEXT NOT NULL,
      trigger TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('running', 'done', 'waiting', 'retrying', 'failed', 'interrupted', 'lost')),
      attempt INTEGER NOT NULL DEFAULT 1,
      max_attempts INTEGER NOT NULL DEFAULT 1,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      result TEXT,
      error TEXT,
      logs TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX IF NOT EXISTS xiagent_run_agent ON xiagent_run (owner, agent_id, started_at);
    CREATE TABLE IF NOT EXISTS xiagent_grant (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      owner TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('catch-up', 'manual')),
      from_at INTEGER NOT NULL,
      until_at INTEGER NOT NULL,
      reason TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS xiagent_grant_agent ON xiagent_grant (agent_id, until_at);
  `);
}

// ---------------------------------------------------------------- errors

export type ErrorClass = "permanent" | "transient" | "unavailable";
/** Invalid data or refused configuration never improves by retrying; network and model hiccups may. */
export function classifyError(error: unknown): ErrorClass {
  if (error instanceof InferenceUnavailableError) return "unavailable";
  if (error instanceof z.ZodError || error instanceof InferenceConfigError || error instanceof FeedError) return "permanent";
  if (error instanceof TopicError) return error.status >= 400 && error.status < 500 && error.status !== 409 ? "permanent" : "transient";
  if (error instanceof FetchError) return ["blocked-url", "blocked-address", "too-large"].includes(error.code) ? "permanent" : "transient";
  return "transient";
}

// ---------------------------------------------------------------- grants

export type Grant = { id: string; agentId: string; kind: "catch-up" | "manual"; from: number; until: number; reason: string };
/** Idempotent by id. */
export function grant(db: Database.Database, input: Grant & { owner: string }, now: number) {
  migrateOrchestrator(db);
  return db.prepare("INSERT INTO xiagent_grant VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING")
    .run(input.id, input.agentId, input.owner, input.kind, input.from, input.until, input.reason, now).changes === 1;
}
export function activeGrants(db: Database.Database, now: number) {
  migrateOrchestrator(db);
  const rows = db.prepare<[number], { id: string; agent_id: string; kind: Grant["kind"]; from_at: number; until_at: number; reason: string }>("SELECT * FROM xiagent_grant WHERE until_at > ? ORDER BY until_at DESC").all(now);
  const grants = new Map<string, Grant>();
  for (const row of rows) if (!grants.has(row.agent_id)) grants.set(row.agent_id, { id: row.id, agentId: row.agent_id, kind: row.kind, from: row.from_at, until: row.until_at, reason: row.reason });
  return grants;
}

/**
 * Missed watch time of an agent in [from, to), bounded by its catch-up limit. Null when nothing
 * was missed (calendar closed during the gap, or catch-up disabled).
 */
export function missedWatch(agent: WatchAgent, from: number, to: number) {
  const schedule = agentSchedule(agent);
  if (!schedule.catchUpHours) return null;
  // Nothing is missed before the agent existed.
  const created = agent.createdAt ? Date.parse(agent.createdAt) : -Infinity;
  const start = Math.max(from, to - schedule.catchUpHours * HOUR, created);
  const spans = intervals(schedule.watch, schedule.timeZone, start, to);
  const missed = spans.reduce((total, span) => total + span.end - span.start, 0);
  return missed > 0 ? { from: spans[0].start, to: spans.at(-1)!.end, missedMs: missed, limited: to - schedule.catchUpHours * HOUR > from } : null;
}

/** Catch-up grant: watch for long enough to collect and evaluate what was missed (1 to 6 hours). */
export function catchUp(db: Database.Database, agent: WatchAgent, from: number, now: number, cause: string) {
  const missed = missedWatch(agent, from, now);
  if (!missed) return null;
  const until = now + Math.min(6 * HOUR, Math.max(HOUR, missed.missedMs));
  const reason = `${cause} Veille manquée : ${Math.round(missed.missedMs / MINUTE)} min entre ${new Date(missed.from).toISOString()} et ${new Date(missed.to).toISOString()}${missed.limited ? ` (limitée à ${agentSchedule(agent).catchUpHours} h)` : ""}.`;
  const id = `catch-up:${agent.id}:${missed.from}`;
  if (!grant(db, { id, agentId: agent.id, owner: agent.owner, kind: "catch-up", from: missed.from, until, reason }, now)) return null;
  const run = startRun(db, { id, agentId: agent.id, owner: agent.owner, kind: "catch-up", trigger: "catch-up" }, now);
  finishRun(db, run, "done", now, { result: { from: missed.from, to: missed.to, missedMinutes: Math.round(missed.missedMs / MINUTE), grantedUntil: until }, log: reason });
  return { from: missed.from, until, reason };
}

// ---------------------------------------------------------------- admission

export type Admission =
  | { allowed: true; deadline: number | null; trigger: Trigger }
  | { allowed: false; until: number; reason: string; code: "paused" | "closed" | "major-disabled" };

/**
 * Whether a job may start now. Watch tasks need the watch calendar, a grant, or (for major-event
 * detection) the major-event exception; an explicit pause blocks everything, exceptions included.
 * `deadline`: when the task must be interrupted (window end + the agent's grace), null for none.
 */
export function admit(job: Pick<Job, "kind" | "payload">, agent: WatchAgent | undefined, grants: Map<string, Grant>, now: number): Admission {
  if (!agent) return { allowed: true, deadline: null, trigger: jobTrigger(job) };
  if (agent.watch.policy.paused) {
    const resumeAt = agent.pause?.resumeAt ? Date.parse(agent.pause.resumeAt) : null;
    return { allowed: false, code: "paused", reason: "ΞAgent en pause : tâche suspendue jusqu’à la reprise.", until: resumeAt && resumeAt > now ? resumeAt : now + 15 * MINUTE };
  }
  const trigger = jobTrigger(job);
  if (!(WATCH_KINDS as readonly string[]).includes(job.kind)) return { allowed: true, deadline: null, trigger };
  const schedule = agentSchedule(agent);
  const granted = grants.get(agent.id);
  if (granted) return { allowed: true, deadline: granted.until + schedule.graceMinutes * MINUTE, trigger: trigger === "calendar" ? granted.kind : trigger };
  // An explicit manual command is a one-off permission of its own (never a publication).
  if (trigger === "manual") return { allowed: true, deadline: null, trigger };
  if (trigger === "major-event") {
    return schedule.majorEvents.enabled ? { allowed: true, deadline: null, trigger }
      : { allowed: false, code: "major-disabled", reason: "Exception pour événement majeur désactivée : attente de la plage de veille.", until: nextWatchOpening(agent, now) ?? now + DAY };
  }
  // Drafting an accepted candidate prepares the next publication window: not bound to the watch
  // calendar. Pause (above), freshness (drafting), the inference limit and publication rules still apply.
  if (job.kind === "draft-candidate") return { allowed: true, deadline: null, trigger };
  const end = watchWindowEnd(agent, now);
  if (end !== null && watchOpen(agent, now)) return { allowed: true, deadline: end + schedule.graceMinutes * MINUTE, trigger };
  return { allowed: false, code: "closed", reason: "Hors de la plage de veille : tâche en attente de la prochaine ouverture.", until: nextWatchOpening(agent, now) ?? now + DAY };
}

// ---------------------------------------------------------------- execution history

export type RunStatus = "running" | "done" | "waiting" | "retrying" | "failed" | "interrupted" | "lost";
export type RunLog = { at: number; level: "info" | "warn" | "error"; message: string };
export type RunRecord = {
  id: string; jobId: string | null; agentId: string | null; owner: string; kind: string; trigger: Trigger; status: RunStatus;
  attempt: number; maxAttempts: number; startedAt: number; finishedAt: number | null; result: unknown; error: string | null; logs: RunLog[];
};
type RunRow = { id: string; job_id: string | null; agent_id: string | null; owner: string; kind: string; trigger: Trigger; status: RunStatus; attempt: number; max_attempts: number; started_at: number; finished_at: number | null; result: string | null; error: string | null; logs: string };
const toRun = (row: RunRow): RunRecord => ({
  id: row.id, jobId: row.job_id, agentId: row.agent_id, owner: row.owner, kind: row.kind, trigger: row.trigger, status: row.status,
  attempt: row.attempt, maxAttempts: row.max_attempts, startedAt: row.started_at, finishedAt: row.finished_at,
  result: row.result === null ? null : JSON.parse(row.result), error: row.error, logs: JSON.parse(row.logs),
});

export function startRun(db: Database.Database, input: { id: string; jobId?: string; agentId: string | null; owner: string; kind: string; trigger: Trigger; attempt?: number; maxAttempts?: number; log?: string }, now: number) {
  migrateOrchestrator(db);
  const logs: RunLog[] = [{ at: now, level: "info", message: input.log ?? "Démarrage." }];
  db.prepare("INSERT OR REPLACE INTO xiagent_run (id, job_id, agent_id, owner, kind, trigger, status, attempt, max_attempts, started_at, logs) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)")
    .run(input.id, input.jobId ?? null, input.agentId, input.owner, input.kind, input.trigger, input.attempt ?? 1, input.maxAttempts ?? 1, now, JSON.stringify(logs));
  return input.id;
}
export function logRun(db: Database.Database, id: string, entry: RunLog) {
  db.prepare("UPDATE xiagent_run SET logs = json_insert(logs, '$[#]', json(?)) WHERE id = ?").run(JSON.stringify({ ...entry, message: entry.message.slice(0, 1_000) }), id);
}
export function finishRun(db: Database.Database, id: string, status: Exclude<RunStatus, "running">, now: number, extra: { result?: unknown; error?: string; log?: string; level?: RunLog["level"] } = {}) {
  if (extra.log) logRun(db, id, { at: now, level: extra.level ?? (status === "failed" ? "error" : status === "done" ? "info" : "warn"), message: extra.log });
  db.prepare("UPDATE xiagent_run SET status = ?, finished_at = ?, result = coalesce(?, result), error = ? WHERE id = ?")
    .run(status, now, extra.result === undefined ? null : JSON.stringify(extra.result), extra.error?.slice(0, 500) ?? null, id);
}

/** The owner's runs, optionally of one agent (owner-level collection runs included). Owner-scoped: never another user's. */
export function listRuns(db: Database.Database, owner: string, { agentId, limit = 50, before }: { agentId?: string; limit?: number; before?: number } = {}) {
  migrateOrchestrator(db);
  const rows = db.prepare<unknown[], RunRow>(`SELECT * FROM xiagent_run WHERE owner = ? ${agentId ? "AND (agent_id = ? OR agent_id IS NULL)" : ""} AND started_at < ? ORDER BY started_at DESC LIMIT ?`)
    .all(...[owner, ...(agentId ? [agentId] : []), before ?? Number.MAX_SAFE_INTEGER, Math.min(limit, 200)]);
  return rows.map(toRun);
}
export function getRun(db: Database.Database, owner: string, id: string) {
  migrateOrchestrator(db);
  const row = db.prepare<[string, string], RunRow>("SELECT * FROM xiagent_run WHERE id = ? AND owner = ?").get(id, owner);
  return row ? toRun(row) : null;
}

/**
 * Retention of detailed execution logs: the agent's own setting, else the global one
 * (XI_RUN_RETENTION_DAYS, 30 days by default). Publications, their sources, drafts and
 * publication decisions live elsewhere and are not touched here.
 */
export function purgeRuns(db: Database.Database, agents: readonly WatchAgent[], now: number, globalDays = DEFAULT_RETENTION_DAYS) {
  migrateOrchestrator(db);
  let purged = 0;
  const custom = agents.filter(agent => agentSchedule(agent).retentionDays !== null);
  for (const agent of custom) purged += db.prepare("DELETE FROM xiagent_run WHERE agent_id = ? AND status != 'running' AND started_at < ?").run(agent.id, now - agentSchedule(agent).retentionDays! * DAY).changes;
  const placeholders = custom.map(() => "?").join(", ");
  purged += db.prepare(`DELETE FROM xiagent_run WHERE status != 'running' AND started_at < ? ${custom.length ? `AND (agent_id IS NULL OR agent_id NOT IN (${placeholders}))` : ""}`).run(now - globalDays * DAY, ...custom.map(agent => agent.id)).changes;
  purged += db.prepare("DELETE FROM xiagent_grant WHERE until_at < ?").run(now - globalDays * DAY).changes;
  return purged;
}
export const globalRetentionDays = (env: Record<string, string | undefined> = process.env) => {
  const days = Number(env.XI_RUN_RETENTION_DAYS);
  return Number.isInteger(days) && days >= 1 && days <= 365 ? days : DEFAULT_RETENTION_DAYS;
};
