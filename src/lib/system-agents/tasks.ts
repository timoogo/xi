import type Database from "better-sqlite3";
import { z } from "zod";
import type { AccountStore } from "../accounts/store";
import type { TopicStore } from "../topics/store";
import { TopicError } from "../topics/types";
import { InferenceConfigError, InferenceUnavailableError } from "../watch/inference";
import { createJobQueue, type Job } from "../watch/jobs";
import { describeLLM, type LLMBinding } from "../watch/llm-binding";
import type { ModelChoices } from "../konstruktor/context";
import { admit, drainLimits, jobRuns, SYSTEM_TASK_KIND, type RunRecord } from "../watch/orchestrator";
import { drainJobs, type DrainControl, type Handler } from "../watch/worker";
import { KONSTRUKTOR_TASKS } from "../konstruktor/converse";
import { REVIEW_TASK } from "../konstruktor/suggestions";
import { ARBITER_TASKS } from "../arbiter/decide";
import type { SourceStore } from "../watch/sources";
import { enqueueSystemTask, payloadSchema, systemTaskKey, type SystemTaskPayload } from "./queue";
import { systemAgentDefinition, type SystemAgentKind } from "./registry";
import type { SystemAgent, SystemAgentStore } from "./store";

/**
 * Interactive tasks of the system ΞAgents, on the watch engine's durable queue (`watch_job`, kind
 * `system-task`): leases, fencing, retries, error classification and run history are the engine's.
 *
 * - A request is idempotent on (agent, requester, requestId) and runs for its requester only, with
 *   the requester's local model configuration (never another instance, model or provider).
 * - The web server drains these jobs as soon as they are requested (`kick`); the periodic worker
 *   drains them too, so a task interrupted by a crash resumes when its lease expires.
 * - No editorial calendar applies; the inference limit and SYSTEM_CONCURRENCY do.
 * - While a task holds its lease, the agent's Bloub is "working" (busyAgents reads `agentId`).
 */

/** Stores a task may read, always on behalf of its requester (`owner`); writes stay with the user (L5). */
/** Stores a system task may read; `models`: the owner's local instances and models (none known when absent). */
export type SystemServices = { db: Database.Database; accounts: AccountStore; topics: TopicStore; sources?: SourceStore; models?: (owner: string) => ModelChoices };
/** What a task gets: its requester, the agent (enabled), validated input, the requester's model and the stores. */
export type SystemTaskContext<I> = { owner: string; agent: SystemAgent; input: I; llm: () => LLMBinding; now: () => number; services: SystemServices; jobId: string };
/**
 * `run` is a method (bivariant): a task with its own input type fits the registries below.
 * `internal`: only requested by Ξ's own services (e.g. a conversation turn), never through the generic API.
 */
export type SystemTask<I = unknown> = { input: z.ZodType<I>; internal?: boolean; run(context: SystemTaskContext<I>): Promise<unknown> };

/** Checks that the requester's local model answers: the smallest end-to-end task, for every agent. */
const probeModel: SystemTask<null> = {
  input: z.null(),
  async run({ llm, now }) {
    const binding = llm();
    // A missing or refused configuration does not improve by waiting: reported at once.
    if (!binding.ok) throw new InferenceConfigError(binding.message);
    const started = now();
    const reply = await binding.inference.complete({ model: binding.resolved.model, system: "Tu es un test de disponibilité. Réponds en un mot.", prompt: "Réponds uniquement : OK" });
    return { model: describeLLM(binding.resolved), latencyMs: now() - started, reply: reply.trim().slice(0, 200) };
  },
};

const COMMON_TASKS: Record<string, SystemTask> = { "probe-model": probeModel };
/** Each agent's own tasks (Konstruktor's conversations, the arbiter's decisions) are declared here. */
const AGENT_TASKS: Partial<Record<SystemAgentKind, Record<string, SystemTask>>> = { konstruktor: { ...KONSTRUKTOR_TASKS, review: REVIEW_TASK }, "priority-arbiter": ARBITER_TASKS };
export const systemTask = (kind: string, task: string): SystemTask | null =>
  Object.hasOwn(AGENT_TASKS[kind as SystemAgentKind] ?? {}, task) ? AGENT_TASKS[kind as SystemAgentKind]![task]
    : Object.hasOwn(COMMON_TASKS, task) && systemAgentDefinition(kind) ? COMMON_TASKS[task] : null;

type Payload = SystemTaskPayload;
const requestSchema = z.object({ requestId: z.uuid(), task: z.string().min(1).max(64), input: z.unknown().optional() }).strict();
/** Unfinished requests a user may have at once, all agents together. */
export const MAX_OPEN_REQUESTS = 5;

export type SystemTaskView = {
  requestId: string; kind: string; task: string; state: Job["state"]; attempts: number; maxAttempts: number;
  /** Next attempt for a pending task (after a failure or while the model is unavailable). */
  runAfter: number; createdAt: number; updatedAt: number; result: unknown; message: string | null;
  runs: Pick<RunRecord, "status" | "attempt" | "startedAt" | "finishedAt" | "error" | "logs">[];
};

/**
 * Interactive retries while the local model is unreachable: the delay follows the time the task has
 * already waited (15 s, 15 s, 30 s, 1 min, 2 min, 4 min, then 5 min at most), so a conversation
 * resumes quickly after a short outage without a tight loop. Past MAX_INTERACTIVE_WAIT the task fails
 * visibly. Stateless (from the job's creation): drainJobs rewrites the run row of a waiting attempt.
 * Editorial tasks keep their own 15-minute rhythm (watch/worker.ts).
 */
export const interactiveRetryDelay = (waitedMs: number) => Math.min(Math.max(waitedMs, 15_000), 5 * 60_000);
export const MAX_INTERACTIVE_WAIT = 15 * 60_000;
const MAX_SERVER_DELAY = 15 * 60_000;

/** Executes system tasks: the agent must still exist and be enabled when the task starts. */
export function systemTaskHandler({ store, llm, services, now = Date.now }: { store: SystemAgentStore; llm: (owner: string) => LLMBinding; services: SystemServices; now?: () => number }): Handler {
  return async job => {
    const payload = payloadSchema.parse(job.payload);
    const agent = await store.get(payload.kind);
    if (!agent.enabled) throw new TopicError("Agent système désactivé : demande abandonnée.", 423);
    const task = systemTask(payload.kind, payload.task);
    if (!task) throw new TopicError("Tâche inconnue pour cet agent système.", 400);
    try {
      return { status: "done", result: await task.run({ owner: payload.owner, agent, input: task.input.parse(payload.input), llm: () => llm(payload.owner), now, services, jobId: job.id }) };
    } catch (error) {
      if (!(error instanceof InferenceUnavailableError)) throw error;
      const waited = Math.max(0, now() - job.createdAt);
      if (waited >= MAX_INTERACTIVE_WAIT) throw new TopicError(`Modèle local toujours indisponible après ${Math.round(waited / 60_000)} min d’attente : ${error.message}`, 424);
      const delay = interactiveRetryDelay(waited);
      // A server-given date is honoured (within bounds): it knows when it will be back.
      const until = Math.min(Math.max(now() + delay, error.retryAt ?? 0), now() + MAX_SERVER_DELAY);
      return { status: "wait", until: new Date(until), reason: `Modèle local indisponible (${error.message}) : nouvel essai à ${new Date(until).toISOString()}.` };
    }
  };
}

export function createSystemTasks({ db, store, llm, services, now = Date.now, inferenceConcurrency = 1, autorun = true }: {
  db: Database.Database; store: SystemAgentStore; llm: (owner: string) => LLMBinding; services: Omit<SystemServices, "db">; now?: () => number; inferenceConcurrency?: number;
  /** False keeps requests queued for the periodic worker (XI_WATCH_DISABLED, tests). */
  autorun?: boolean;
}) {
  const queue = createJobQueue(db, now);
  const handlers = { [SYSTEM_TASK_KIND]: systemTaskHandler({ store, llm, services: { ...services, db }, now }) };
  // No calendar: admission only records the trigger. The history belongs to the requester.
  const control: DrainControl = { db, admit: async job => admit(job, undefined, new Map(), now()), owner: async job => (job.payload as Payload).owner };
  const prefix = (kind: string, owner: string) => systemTaskKey(kind, owner, "");
  const view = (job: Job, owner: string): SystemTaskView => {
    const payload = job.payload as Payload;
    return {
      requestId: payload.requestId, kind: payload.kind, task: payload.task, state: job.state, attempts: job.attempts, maxAttempts: job.maxAttempts,
      runAfter: job.runAfter, createdAt: job.createdAt, updatedAt: job.updatedAt, result: job.state === "done" ? job.result : null, message: job.state === "done" ? null : job.lastError,
      runs: jobRuns(db, owner, job.id).map(({ status, attempt, startedAt, finishedAt, error, logs }) => ({ status, attempt, startedAt, finishedAt, error, logs })),
    };
  };
  const agentOf = (kind: string) => { if (!systemAgentDefinition(kind)) throw new TopicError("Agent système introuvable.", 404); };

  /** `{ requestId, task, input? }`: the same request again returns the same task (409 if it differs). */
  async function request(owner: string, kind: string, input: unknown, { internal = false, trigger = "manual" as Payload["trigger"] } = {}) {
    const agent = await store.get(kind);
    const data = requestSchema.parse(input);
    const task = systemTask(kind, data.task);
    if (!task || (task.internal && !internal)) throw new TopicError("Tâche inconnue pour cet agent système.", 400);
    const taskInput = task.input.parse(data.input ?? null);
    const key = systemTaskKey(kind, owner, data.requestId);
    const existing = queue.get(key);
    if (existing) {
      const payload = existing.payload as Payload;
      if (payload.task !== data.task || JSON.stringify(payload.input) !== JSON.stringify(taskInput)) throw new TopicError("Identifiant de demande déjà utilisé pour une autre demande.", 409);
      return { request: view(existing, owner), created: false };
    }
    if (!agent.enabled) throw new TopicError("Agent système désactivé.", 409);
    // Reviews planned by Ξ never count against (or block) the user's own requests.
    const open = db.prepare<[string, string], { n: number }>("SELECT count(*) AS n FROM watch_job WHERE kind = ? AND state IN ('pending', 'running') AND json_extract(payload, '$.owner') = ? AND json_extract(payload, '$.trigger') = 'manual'").get(SYSTEM_TASK_KIND, owner)!.n;
    if (trigger === "manual" && open >= MAX_OPEN_REQUESTS) throw new TopicError(`Trop de demandes en cours (${MAX_OPEN_REQUESTS} au plus). Réessayez quand elles sont terminées.`, 429);
    const { job, created } = enqueueSystemTask(queue, { agentId: agent.id, kind, task: data.task, owner, requestId: data.requestId, input: taskInput, trigger });
    if (created) void kick();
    return { request: view(job, owner), created };
  }

  /** The requester's own task only: another user's request id is unknown (404). */
  function get(owner: string, kind: string, requestId: string) {
    agentOf(kind);
    const job = z.uuid().safeParse(requestId).success ? queue.get(prefix(kind, owner) + requestId) : null;
    if (!job) throw new TopicError("Demande introuvable.", 404);
    // A poll also resumes work left behind (crashed server, model back), without waiting for the worker.
    if (job.state === "pending" || job.state === "running") void kick();
    return view(job, owner);
  }

  /** The requester's latest tasks for this agent. */
  function list(owner: string, kind: string, limit = 20) {
    agentOf(kind);
    const start = prefix(kind, owner);
    const keys = db.prepare<[string, number, string, number], { key: string }>("SELECT key FROM watch_job WHERE kind = ? AND substr(key, 1, ?) = ? ORDER BY created_at DESC, rowid DESC LIMIT ?")
      .all(SYSTEM_TASK_KIND, start.length, start, Math.min(limit, 50));
    return keys.map(({ key }) => view(queue.get(key)!, owner));
  }

  let draining: Promise<void> | null = null;
  let again = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Drains due system tasks in this process at once. Several kicks while draining make one more
   * pass. Afterwards, a timer comes back for tasks still pending (model busy elsewhere, retry date)
   * or held by a lease that may expire; the periodic worker remains the recovery path.
   */
  function kick(): Promise<void> {
    if (!autorun) return Promise.resolve();
    if (draining) { again = true; return draining; }
    clearTimeout(timer);
    draining = (async () => {
      do {
        again = false;
        await drainJobs({ queue, handlers, clock: now, concurrency: 1, maxJobs: 20, limits: drainLimits(inferenceConcurrency), control });
      } while (again);
    })().catch(error => { console.error("System tasks drain failed", error instanceof Error ? error.name : "unknown"); })
      .finally(() => { draining = null; scheduleNext(); });
    return draining;
  }
  function scheduleNext() {
    const next = db.prepare<[string], { at: number | null }>("SELECT min(CASE state WHEN 'pending' THEN run_after ELSE lease_until END) AS at FROM watch_job WHERE kind = ? AND state IN ('pending', 'running')").get(SYSTEM_TASK_KIND)!.at;
    if (next === null) return;
    timer = setTimeout(() => void kick(), Math.min(Math.max(next - now(), 5_000), 10 * 60_000));
    timer.unref();
  }
  function close() { clearTimeout(timer); return draining ?? Promise.resolve(); }

  return { request, get, list, kick, close };
}
export type SystemTasks = ReturnType<typeof createSystemTasks>;
