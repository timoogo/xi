import type Database from "better-sqlite3";
import { z } from "zod";
import type { WatchAgent } from "../accounts/types";
import { migrateArbitrations, type ArbitrationStatus } from "../arbiter/arbitration";
import { migrateWatchCandidates } from "../watch/evaluate";
import { migrateWatchJobs } from "../watch/jobs";
import { migrateOrchestrator, type RunStatus } from "../watch/orchestrator";
import type { PublicationStore } from "../publications/store";
import { diffusionWait, migrateWatchDecisions, publishSettingsFromEnv, type DiffusionWait, type PublishSettings } from "../watch/publisher";
import { migrateEditorialQueue, ownerQueue, queueCounts, type QueueState } from "../watch/queue";
import { WATCH_TIME_ZONE } from "../watch/schedule";
import { migrateWatchItems } from "../watch/stories";
import { addDays, intervals, isValidTimeZone, localDate, zonedInstant, type Interval } from "./calendar";
import { agentSchedule } from "./schedule";
import { ACTIVITY_STATES, QUEUE_STATES, SUPERVISION_VIEWS, type ActivityState } from "./supervision-shared";
export * from "./supervision-shared";

/**
 * Global calendar and editorial supervision of an owner's ΞAgents: read-only projections of what
 * already exists (calendars, editorial queue, orchestrator runs, publication decisions, @arbitre
 * requests). Nothing here writes a configuration or plans work, and every query is owner-scoped:
 * the caller passes the owner's own agents, and rows are also filtered by `owner`.
 *
 * Calendars are permissions: configured windows are shown as such, never as publication times
 * (the central diffuser decides when, see publisher.ts `diffuse`). Executions are what really ran.
 * Days are local dates of the viewer's time zone; each agent's calendar is evaluated in its own
 * zone, so ranges crossing midnight and daylight-saving changes fall where they really are.
 */
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value), "Date invalide.");
const id = z.string().min(1).max(200);
/** URL parameters of the page and the API (both read the same ones). */
export const supervisionQuerySchema = z.object({
  view: z.enum(SUPERVISION_VIEWS).default("calendar"),
  agent: id.optional(), topic: id.optional(), story: id.optional(),
  month: month.optional(), date: date.optional(),
  tz: z.string().max(64).refine(isValidTimeZone, "Fuseau horaire inconnu.").optional(),
  from: date.optional(), to: date.optional(),
  state: z.enum([...ACTIVITY_STATES, ...QUEUE_STATES]).optional(),
  before: z.string().max(400).refine(value => parseCursor(value) !== null, "Curseur de pagination invalide.").optional(),
}).refine(query => !query.from || !query.to || query.from <= query.to, { message: "Période invalide : le début suit la fin.", path: ["from"] })
  .refine(query => !query.from || !query.to || (Date.parse(query.to) - Date.parse(query.from)) / 86_400_000 <= 92, { message: "Période trop longue (92 jours au plus).", path: ["to"] });
export type SupervisionQuery = z.infer<typeof supervisionQuerySchema>;
/** A readable message for the first invalid parameter. */
export const queryError = (error: z.ZodError) => {
  const issue = error.issues[0];
  return issue?.code === "custom" ? issue.message : `Paramètre « ${issue?.path.join(".") || "?"} » invalide.`;
};
export function parseSupervisionQuery(params: URLSearchParams | Record<string, string | string[] | undefined>) {
  const entries = params instanceof URLSearchParams ? [...params.entries()] : Object.entries(params).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value] as const);
  return supervisionQuerySchema.safeParse(Object.fromEntries(entries.filter(([, value]) => value !== undefined && value !== "")));
}

/** The owner's agents, narrowed by agent and by Topic (agents whose perimeter includes it). */
export function scopeAgents(agents: readonly WatchAgent[], owner: string, { agent, topic }: Pick<SupervisionQuery, "agent" | "topic">) {
  return agents.filter(item => item.owner === owner && (!agent || item.id === agent) && (!topic || item.primaryTopicId === topic || item.secondaryTopicIds.includes(topic)));
}
/** The viewer's zone: asked, else the one all agents share, else Paris. */
export function viewTimeZone(agents: readonly WatchAgent[], asked?: string) {
  if (asked) return asked;
  const zones = new Set(agents.map(agent => agentSchedule(agent).timeZone));
  return zones.size === 1 ? [...zones][0] : WATCH_TIME_ZONE;
}

const placeholders = (values: readonly unknown[]) => values.map(() => "?").join(", ");
const HOUR = 3_600_000;

// ---------------------------------------------------------------- executions

const EMPTY_OUTCOMES = new Set(["no-candidates", "no-ready", "nothing-published", "no-material", "skipped", "held", "rejected", "already-evaluated", "already-drafted", "merged", "queued", "deferred", "abandoned"]);
/** What a recorded run amounted to, from its status and result. */
export function activityState(status: RunStatus, result: unknown): ActivityState {
  if (status === "failed" || status === "interrupted" || status === "lost") return "error";
  if (status === "running" || status === "waiting" || status === "retrying") return status;
  const value = (result ?? {}) as { outcome?: unknown; new?: unknown; proposed?: unknown };
  if (typeof value.outcome === "string" && EMPTY_OUTCOMES.has(value.outcome)) return "empty";
  if (value.new === 0 || value.proposed === 0) return "empty";
  return "done";
}
const DECISION_STATE: Record<string, ActivityState> = { published: "done", selected: "done", deferred: "waiting", abandoned: "empty", skipped: "empty" };
const ARBITRATION_STATE: Record<ArbitrationStatus, ActivityState> = { pending: "waiting", favorable: "done", refused: "done", unavailable: "error", disabled: "empty", expired: "empty", obsolete: "empty" };
const STATUS_OF: Partial<Record<ActivityState, RunStatus[]>> = { error: ["failed", "interrupted", "lost"], waiting: ["waiting"], retrying: ["retrying"], running: ["running"], done: ["done"], empty: ["done"] };

export type ActivityItem = {
  type: "run" | "decision" | "arbitration"; id: string; at: number; end: number | null; agentId: string | null; kind: string; state: ActivityState;
  status: string; attempt: number | null; maxAttempts: number | null; reason: string | null; storyId: string | null; storyTitle: string | null;
};
type RunRow = { id: string; agent_id: string | null; kind: string; status: RunStatus; attempt: number; max_attempts: number; started_at: number; finished_at: number | null; result: string | null; error: string | null; story_id: string | null; title: string | null };

/** Position of an item in the activity order (most recent first, then by type and id): unique, so no item is lost between pages. */
export type ActivityCursor = { at: number; key: string };
const keyOf = (item: Pick<ActivityItem, "type" | "id">) => `${item.type}:${item.id}`;
export const cursorOf = (item: ActivityItem) => `${item.at}:${keyOf(item)}`;
export function parseCursor(value: string): ActivityCursor | null {
  const match = /^(\d{1,16}):((?:run|decision|arbitration):.{1,300})$/.exec(value);
  return match ? { at: Number(match[1]), key: match[2] } : null;
}
// Binary order, as SQLite compares text.
const byPosition = (a: ActivityItem, b: ActivityItem) => b.at - a.at || (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0);

/**
 * Executions (runs), publication decisions (including the central diffuser's, which has no run of
 * its own) and @arbitre requests of the scoped agents in [from, to), most recent first, after
 * `after` when given. Each source is read in the same total order (instant, then type and id) with
 * a keyset condition, in batches until `limit` items match the state filter or the source ends:
 * equal instants never hide an item, and a state computed from a run's result never truncates a page.
 */
export function activity(db: Database.Database, owner: string, agents: readonly WatchAgent[], { from, to, state, story, limit = 100, all = false, after = null }: { from: number; to: number; state?: ActivityState; story?: string; limit?: number; all?: boolean; after?: ActivityCursor | null }): ActivityItem[] {
  migrateOrchestrator(db); migrateWatchJobs(db); migrateWatchDecisions(db); migrateArbitrations(db); migrateWatchItems(db);
  const ids = agents.map(agent => agent.id);
  if (!ids.length) return [];
  // Owner-level runs (no agent) belong to the unfiltered view only.
  const agentClause = (column: string) => `(${column} IN (${placeholders(ids)})${all ? ` OR ${column} IS NULL` : ""})`;
  const statuses = state ? STATUS_OF[state] ?? [] : null;
  const keyset = (at: string, key: string) => `AND (${at} < ? OR (${at} = ? AND ${key} > ?)) ORDER BY ${at} DESC, ${key} ASC LIMIT ?`;
  function read<Row>(sql: string, params: unknown[], at: string, key: string, toItem: (row: Row) => ActivityItem) {
    const found: ActivityItem[] = [];
    let cursor = after;
    const query = db.prepare<unknown[], Row>(`${sql} ${keyset(at, key)}`);
    for (;;) {
      const rows = query.all(...params, cursor?.at ?? Number.MAX_SAFE_INTEGER, cursor?.at ?? Number.MAX_SAFE_INTEGER, cursor?.key ?? "", limit);
      for (const row of rows) {
        const item = toItem(row);
        cursor = { at: item.at, key: keyOf(item) };
        if (!state || item.state === state) { found.push(item); if (found.length === limit) return found; }
      }
      if (rows.length < limit) return found;
    }
  }
  const runs = read<RunRow>(`SELECT r.id, r.agent_id, r.kind, r.status, r.attempt, r.max_attempts, r.started_at, r.finished_at, r.result, r.error, json_extract(j.payload, '$.storyId') AS story_id, s.title
    FROM xiagent_run r LEFT JOIN watch_job j ON j.id = r.job_id LEFT JOIN watch_story s ON s.id = json_extract(j.payload, '$.storyId') AND s.owner = r.owner
    WHERE r.owner = ? AND r.started_at >= ? AND r.started_at < ? AND ${agentClause("r.agent_id")} ${statuses ? `AND r.status IN (${placeholders(statuses)})` : ""} ${story ? "AND json_extract(j.payload, '$.storyId') = ?" : ""}`,
  [owner, from, to, ...ids, ...(statuses ?? []), ...(story ? [story] : [])], "r.started_at", "'run:' || r.id", row => {
    const result = row.result === null ? null : JSON.parse(row.result) as { reason?: unknown } | null;
    return {
      type: "run", id: row.id, at: row.started_at, end: row.finished_at, agentId: row.agent_id, kind: row.kind, state: activityState(row.status, result), status: row.status,
      attempt: row.attempt, maxAttempts: row.max_attempts, reason: row.error ?? (typeof result?.reason === "string" ? result.reason : null), storyId: row.story_id, storyTitle: row.title,
    };
  });
  const decisions = read<{ id: string; agent_id: string; story_id: string | null; outcome: string; reason: string; at: number; title: string | null }>(`SELECT d.id, d.agent_id, d.story_id, d.outcome, d.reason, d.at, s.title
    FROM watch_decision d LEFT JOIN watch_story s ON s.id = d.story_id AND s.owner = d.owner
    WHERE d.owner = ? AND d.at >= ? AND d.at < ? AND d.agent_id IN (${placeholders(ids)}) ${story ? "AND d.story_id = ?" : ""}`,
  [owner, from, to, ...ids, ...(story ? [story] : [])], "d.at", "'decision:' || d.id",
  row => ({ type: "decision", id: row.id, at: row.at, end: null, agentId: row.agent_id, kind: `decision:${row.outcome}`, state: DECISION_STATE[row.outcome] ?? "done", status: row.outcome, attempt: null, maxAttempts: null, reason: row.reason, storyId: row.story_id, storyTitle: row.title }));
  const requests = read<{ id: string; agent_id: string; story_id: string; title: string; status: ArbitrationStatus; reason: string | null; decision: string | null; created_at: number; updated_at: number }>(`SELECT id, agent_id, story_id, title, status, reason, decision, created_at, updated_at
    FROM arbiter_request WHERE owner = ? AND created_at >= ? AND created_at < ? AND agent_id IN (${placeholders(ids)}) ${story ? "AND story_id = ?" : ""}`,
  [owner, from, to, ...ids, ...(story ? [story] : [])], "created_at", "'arbitration:' || id", row => {
    const decision = row.decision ? JSON.parse(row.decision) as { priority: boolean; justification: string } : null;
    return { type: "arbitration", id: row.id, at: row.created_at, end: row.status === "pending" ? null : row.updated_at, agentId: row.agent_id, kind: "arbitration", state: ARBITRATION_STATE[row.status], status: row.status, attempt: null, maxAttempts: null,
      reason: decision ? `Prioritaire : ${decision.priority ? "oui" : "non"}. ${decision.justification}` : row.reason, storyId: row.story_id, storyTitle: row.title };
  });
  return [...runs, ...decisions, ...requests].sort(byPosition).slice(0, limit);
}

// ---------------------------------------------------------------- calendar

/** Local dates of the month in the viewer's zone, with their real instants. */
function monthDays(monthValue: string, timeZone: string) {
  const first = `${monthValue}-01`;
  const days: { date: string; start: number; end: number }[] = [];
  for (let day = first; day.startsWith(monthValue); day = addDays(day, 1)) days.push({ date: day, start: zonedInstant(day, 0, timeZone), end: zonedInstant(addDays(day, 1), 0, timeZone) });
  return days;
}
const overlap = (spans: readonly Interval[], start: number, end: number) => spans.reduce((total, span) => total + Math.max(0, Math.min(span.end, end) - Math.max(span.start, start)), 0);

export type CalendarDay = {
  date: string; watchHours: number; publishHours: number; watchAgents: number; publishAgents: number;
  runs: number; errors: number; empty: number; published: number; future: boolean;
};
/** Month heatmap: configured hours (summed over agents, real durations) and real executions per local date. */
export function calendarMonth(db: Database.Database, owner: string, agents: readonly WatchAgent[], { month: monthValue, timeZone, now }: { month: string; timeZone: string; now: number }): CalendarDay[] {
  const days = monthDays(monthValue, timeZone);
  const from = days[0].start, to = days.at(-1)!.end;
  const windows = agents.map(agent => {
    const schedule = agentSchedule(agent);
    return { watch: intervals(schedule.watch, schedule.timeZone, from, to), publish: intervals(schedule.publish, schedule.timeZone, from, to) };
  });
  const executed = activity(db, owner, agents, { from, to, limit: 5_000 });
  const byDay = new Map<string, ActivityItem[]>();
  for (const item of executed) {
    const key = localDate(item.at, timeZone);
    byDay.set(key, [...byDay.get(key) ?? [], item]);
  }
  return days.map(day => {
    const watch = windows.map(window => overlap(window.watch, day.start, day.end));
    const publish = windows.map(window => overlap(window.publish, day.start, day.end));
    const items = byDay.get(day.date) ?? [];
    const runs = items.filter(item => item.type === "run");
    return {
      date: day.date, watchHours: watch.reduce((a, b) => a + b, 0) / HOUR, publishHours: publish.reduce((a, b) => a + b, 0) / HOUR,
      watchAgents: watch.filter(Boolean).length, publishAgents: publish.filter(Boolean).length,
      runs: runs.length, errors: runs.filter(item => item.state === "error").length, empty: runs.filter(item => item.state === "empty").length,
      published: items.filter(item => item.type === "decision" && item.status === "published").length, future: day.start > now,
    };
  });
}

export type DayLane = { agentId: string; handle: string; timeZone: string; explicit: boolean; status: "active" | "paused" | "disabled"; watch: Interval[]; publish: Interval[] };
/** Hourly timeline of one local date: each agent's configured windows, then what really happened. */
export function calendarDay(db: Database.Database, owner: string, agents: readonly WatchAgent[], { date: day, timeZone }: { date: string; timeZone: string }) {
  const start = zonedInstant(day, 0, timeZone), end = zonedInstant(addDays(day, 1), 0, timeZone);
  // Hour marks in real time: 23 or 25 of them on daylight-saving days.
  const hours: number[] = [];
  for (let at = start; at < end; at += HOUR) hours.push(at);
  const lanes: DayLane[] = agents.map(agent => {
    const schedule = agentSchedule(agent);
    const enabled = agent.active && agent.watch.valid && agent.watch.policy.enabled;
    return {
      agentId: agent.id, handle: agent.handle, timeZone: schedule.timeZone, explicit: schedule.explicit, status: !enabled ? "disabled" : agent.watch.policy.paused ? "paused" : "active",
      watch: intervals(schedule.watch, schedule.timeZone, start, end), publish: intervals(schedule.publish, schedule.timeZone, start, end),
    };
  });
  return { date: day, start, end, hours, lanes, activity: activity(db, owner, agents, { from: start, to: end, limit: 500 }) };
}

// ---------------------------------------------------------------- queue

export type QueueRow = {
  draftId: string; agentId: string; storyId: string; title: string | null; topicId: string | null; lane: "night" | "immediate"; weekly: boolean;
  importance: number; relevance: number; freshness: number; originAt: number; expiresAt: number; state: QueueState; reason: string | null; readyAt: number; updatedAt: number;
  arbitration: { status: ArbitrationStatus; priority: boolean | null; justification: string | null } | null;
  /** A ready content: why the diffuser does not publish it now (null: eligible, next diffusion pass). */
  wait: DiffusionWait | null;
};
/** What the diffuser's eligibility needs: the operator's flags and each agent's real publications. */
export type DiffusionContext = { settings: PublishSettings; publishedAt: (agentId: string) => readonly Date[] };
/** The web side's context: the same environment flags as the worker, the indexed publications. */
export const diffusionContext = (publications: Pick<PublicationStore, "agentPublications">, settings: PublishSettings = publishSettingsFromEnv()): DiffusionContext =>
  ({ settings, publishedAt: agentId => publications.agentPublications(agentId).filter(item => !item.test).map(item => item.publishedAt) });
/** The editorial queue as stored (ownerQueue), with story titles and the latest @arbitre request of each news. */
export function editorialQueue(db: Database.Database, owner: string, agents: readonly WatchAgent[], { state, now, limit = 200, diffusion }: { state?: QueueState; now: number; limit?: number; diffusion?: DiffusionContext }) {
  migrateEditorialQueue(db); migrateWatchCandidates(db); migrateArbitrations(db); migrateWatchItems(db);
  const ids = agents.map(agent => agent.id);
  if (!ids.length) return { rows: [] as QueueRow[], counts: { ready: 0, published: 0, withdrawn: 0, expired: 0 } };
  const items = ownerQueue(db, owner, limit, { agentIds: ids, ...(state ? { states: [state] } : {}) });
  const title = db.prepare<[string, string], { title: string }>("SELECT title FROM watch_story WHERE id = ? AND owner = ?");
  const request = db.prepare<[string, string, string], { status: ArbitrationStatus; decision: string | null }>("SELECT status, decision FROM arbiter_request WHERE owner = ? AND agent_id = ? AND story_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1");
  const byId = new Map(agents.map(agent => [agent.id, agent]));
  const last = db.prepare<[string], { at: number }>("SELECT at FROM watch_decision WHERE owner = ? AND outcome = 'published' ORDER BY at DESC LIMIT 1").get(owner)?.at ?? null;
  const times = new Map<string, readonly Date[]>();
  const publishedAt = (agentId: string) => { if (!times.has(agentId)) times.set(agentId, diffusion!.publishedAt(agentId)); return times.get(agentId)!; };
  const rows = items.map((item): QueueRow => {
    const found = request.get(owner, item.agentId, item.storyId);
    const decision = found?.decision ? JSON.parse(found.decision) as { priority: boolean; justification: string } : null;
    const age = (item.state === "ready" ? now : item.updatedAt) - item.originAt;
    return {
      draftId: item.draftId, agentId: item.agentId, storyId: item.storyId, title: title.get(item.storyId, owner)?.title ?? null, topicId: item.topicId, lane: item.lane, weekly: item.weekly,
      importance: item.importance, relevance: item.relevance, freshness: Math.max(0, Math.min(1, 1 - age / Math.max(1, item.expiresAt - item.originAt))), originAt: item.originAt, expiresAt: item.expiresAt,
      state: item.state, reason: item.reason, readyAt: item.readyAt, updatedAt: item.updatedAt,
      arbitration: found ? { status: found.status, priority: decision?.priority ?? null, justification: decision?.justification ?? null } : null,
      wait: item.state === "ready" && diffusion ? diffusionWait(item, byId.get(item.agentId), { settings: diffusion.settings, now, publishedAt: publishedAt(item.agentId), lastOwnerPublication: last }) : null,
    };
  });
  return { rows, counts: queueCounts(db, owner, ids) };
}

// ---------------------------------------------------------------- one entry point

/**
 * Everything one view needs, for the page and the API. `agents`: all watch agents (filtered here to
 * the owner's); `now` fixes "today" and the default month, day and period.
 */
export function supervision(db: Database.Database, owner: string, allAgents: readonly WatchAgent[], query: SupervisionQuery, now: number, diffusion?: DiffusionContext) {
  const owned = allAgents.filter(agent => agent.owner === owner);
  const agents = scopeAgents(owned, owner, query);
  const timeZone = viewTimeZone(agents.length ? agents : owned, query.tz);
  const today = localDate(now, timeZone);
  const base = { view: query.view, timeZone, today, agents: owned.map(agent => ({ id: agent.id, handle: agent.handle, topicIds: [agent.primaryTopicId, ...agent.secondaryTopicIds] })), scoped: agents.map(agent => agent.id) };
  if (query.view === "calendar") {
    const selected = query.date ?? today;
    const monthValue = query.month ?? selected.slice(0, 7);
    return { ...base, view: "calendar" as const, month: monthValue, days: calendarMonth(db, owner, agents, { month: monthValue, timeZone, now }), day: calendarDay(db, owner, agents, { date: selected, timeZone }) };
  }
  if (query.view === "queue") {
    const state = QUEUE_STATES.find(value => value === query.state);
    return { ...base, view: "queue" as const, state: state ?? null, ...editorialQueue(db, owner, agents, { state, now, diffusion }) };
  }
  const fromDate = query.from ?? addDays(query.to ?? today, -6), toDate = query.to ?? (query.from ? addDays(query.from, 6) : today);
  const state = ACTIVITY_STATES.find(value => value === query.state);
  const from = zonedInstant(fromDate, 0, timeZone), to = zonedInstant(addDays(toDate, 1), 0, timeZone);
  const limit = 100;
  const items = activity(db, owner, agents, { from, to, state, story: query.story, limit: limit + 1, all: !query.agent && !query.topic, after: query.before ? parseCursor(query.before) : null });
  return { ...base, view: "activity" as const, from: fromDate, to: toDate, state: state ?? null, story: query.story ?? null, items: items.slice(0, limit), more: items.length > limit ? cursorOf(items[limit - 1]) : null };
}
export type Supervision = ReturnType<typeof supervision>;
