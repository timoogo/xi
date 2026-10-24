import type Database from "better-sqlite3";
import type { AccountStore } from "../accounts/store";
import type { PublicationStore } from "../publications/store";
import { createJobQueue, retryDelay, PRIORITY, type ConcurrencyLimit, type Job, type JobQueue } from "./jobs";
import { activeGrants, admit, catchUp, classifyError, finishRun, globalRetentionDays, INFERENCE_KINDS, jobAgent, jobTrigger, OUTAGE_MS, purgeRuns, startRun, type Admission } from "./orchestrator";
import { agentSchedule, publishOpen, watchOpen } from "../xiagents/schedule";
export { PRIORITY };
import { collectHandler, discoverHandler, planCollection, planDiscovery } from "./collect";
import { draftHandler, planDrafting } from "./drafting";
import { evaluateHandler, planEvaluation, purgeCandidates } from "./evaluate";
import type { Inference } from "./inference";
import type { PoliteFetch } from "./net";
import type { TopicStore } from "../topics/store";
import type { WatchAgent } from "../accounts/types";
import { planAgentJobs } from "./schedule";
import type { SourceStore } from "./sources";
import { purgeItems } from "./stories";
import { createPublisher, planAlerts, purgeDecisions, type PublishSettings } from "./publisher";

export type HandlerResult = { status: "done"; result?: unknown } | { status: "wait"; until: Date; reason: string };
export type Handler = (job: Job) => Promise<HandlerResult>;
const SLOW_INDEX_MS = 2_000;
export type DrainSummary = { done: number; waiting: number; retried: number; failed: number; lost: number; interrupted: number; deferred: number };

/** Orchestration hooks of a drain: start admission, interruption deadline, history and owners. */
export type DrainControl = {
  admit: (job: Job) => Promise<Admission>;
  /** Owner recorded on the run (agents' owner, or the payload's). Jobs without one are not recorded. */
  owner: (job: Job) => Promise<string | null>;
  db: Database.Database;
};

class Interrupted extends Error { constructor(readonly until: number, message: string) { super(message); } }

/**
 * Runs due jobs until none is left, `maxJobs` is reached or `deadline` passes, with up to
 * `concurrency` jobs at once in this process and `limits` across processes (local model).
 * The lease is renewed while a handler runs; a lost lease is never overwritten. With `control`,
 * each job is admitted when it starts (calendars, pause), interrupted at its deadline or on pause
 * (its stages are persisted by the handlers; it resumes at the next opening without consuming an
 * attempt), classified on failure (permanent errors are not retried) and recorded in the history.
 */
export async function drainJobs({ queue, handlers, leaseMs = 5 * 60_000, maxJobs = 50, deadline = Infinity, clock = Date.now, concurrency = 1, limits = [], control }: {
  queue: JobQueue; handlers: Record<string, Handler>; leaseMs?: number; maxJobs?: number; deadline?: number; clock?: () => number;
  concurrency?: number; limits?: readonly ConcurrencyLimit[]; control?: DrainControl;
}): Promise<DrainSummary> {
  const summary: DrainSummary = { done: 0, waiting: 0, retried: 0, failed: 0, lost: 0, interrupted: 0, deferred: 0 };
  let started = 0;
  const kinds = Object.keys(handlers);
  async function runOne(job: Job) {
    const owner = control ? await control.owner(job) : null;
    const runId = control && owner ? `${job.id}:${job.attempts}` : null;
    const record = (status: Parameters<typeof finishRun>[2], extra: Parameters<typeof finishRun>[4] = {}) => { if (runId) finishRun(control!.db, runId, status, clock(), extra); };
    const admission = control ? await control.admit(job) : null;
    if (admission && !admission.allowed) {
      // Not started: no attempt consumed, no history row (the job did not run).
      summary[queue.wait(job, admission.until, admission.reason) ? "deferred" : "lost"]++;
      return;
    }
    if (runId) startRun(control!.db, { id: runId, jobId: job.id, agentId: jobAgent(job), owner: owner!, kind: job.kind, trigger: admission?.allowed ? admission.trigger : jobTrigger(job), attempt: job.attempts, maxAttempts: job.maxAttempts, log: `Tentative ${job.attempts}/${job.maxAttempts}${admission?.allowed && admission.deadline ? `, à terminer avant ${new Date(admission.deadline).toISOString()}` : ""}.` }, clock());
    let stop: (error: Interrupted) => void = () => {};
    const interrupted = new Promise<never>((_, reject) => { stop = reject; });
    interrupted.catch(() => {});
    const renew = setInterval(() => {
      queue.heartbeat(job, leaseMs);
      // An explicit pause stops running work too.
      if (control) void control.admit(job).then(next => { if (!next.allowed && next.code === "paused") stop(new Interrupted(next.until, next.reason)); }).catch(() => {});
    }, Math.max(1_000, leaseMs / 3));
    renew.unref();
    const timer = admission?.allowed && admission.deadline !== null ? setTimeout(() => stop(new Interrupted(admission.deadline!, "Fin de plage de veille et tolérance dépassées : tâche interrompue proprement, reprise à la prochaine ouverture.")), Math.max(0, admission.deadline - clock())) : null;
    timer?.unref();
    let applied: boolean;
    let outcome: keyof DrainSummary;
    const work = handlers[job.kind](job);
    work.catch(() => {});
    try {
      const result = await Promise.race([work, interrupted]);
      if (result.status === "wait") { applied = queue.wait(job, result.until.getTime(), result.reason); outcome = "waiting"; record("waiting", { log: result.reason }); }
      else { applied = queue.complete(job, result.result ?? null); outcome = "done"; record("done", { result: result.result ?? null, log: "Terminée." }); }
    } catch (error) {
      if (error instanceof Interrupted) {
        // Resumes at the next opening (the admission then decides), without consuming an attempt.
        applied = queue.wait(job, Math.max(clock() + 60_000, error.until), error.message); outcome = "interrupted";
        record("interrupted", { log: error.message });
      } else {
        const kind = classifyError(error);
        if (kind === "unavailable") {
          const until = (error as { retryAt?: number | null }).retryAt ?? clock() + 15 * 60_000;
          applied = queue.wait(job, until, error instanceof Error ? error.message : "Service indisponible."); outcome = "waiting";
          record("waiting", { log: `Service indisponible, nouvel essai à ${new Date(until).toISOString()} sans consommer de tentative.` });
        } else {
          const final = kind === "permanent" || job.attempts >= job.maxAttempts;
          applied = queue.fail(job, error, { permanent: kind === "permanent" }); outcome = final ? "failed" : "retried";
          const message = (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 500);
          record(final ? "failed" : "retrying", { error: message, log: final ? `Échec définitif${kind === "permanent" ? " (erreur permanente, non réessayée)" : " après la dernière tentative"} : ${message}` : `Échec, nouvel essai dans ${Math.round(retryDelay(job.attempts) / 60_000)} min : ${message}` });
        }
      }
    } finally { clearInterval(renew); if (timer) clearTimeout(timer); }
    if (!applied && runId) record("lost", { log: "Bail perdu : un autre processus a repris la tâche." });
    summary[applied ? outcome : "lost"]++;
  }
  async function lane() {
    while (started < maxJobs && clock() < deadline) {
      const job = queue.claim(kinds, leaseMs, limits);
      if (!job) return;
      started++;
      await runOne(job);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, lane));
  return summary;
}

/** Night window, weekly review and alerts (see publisher.ts); kept as one entry point for tests and the worker. */
export function windowHandlers(options: Parameters<typeof createPublisher>[0]): Record<string, Handler> {
  const { handlers } = createPublisher(options);
  return { "publication-window": measured(options.publications, handlers["publication-window"]), "weekly-review": handlers["weekly-review"], "publish-alert": handlers["publish-alert"] };
}

/** The full index reread stays for now; its duration is kept to spot slowdowns as the vault grows. */
function measured(publications: PublicationStore, handler: Handler): Handler {
  return async job => {
    const started = performance.now();
    await publications.ensureIndexed();
    const indexMs = Math.round(performance.now() - started);
    if (indexMs > SLOW_INDEX_MS) console.warn("Watch: slow publication index reconciliation", indexMs);
    const result = await handler(job);
    return result.status === "done" ? { ...result, result: { ...(result.result as object), indexMs } } : result;
  };
}

/**
 * Every handler of the engine. `fetch` is the polite, SSRF-protected fetcher; `inference` the local
 * model server (null when not configured: nothing is evaluated, nothing falls back elsewhere).
 */
export function engineHandlers({ db, accounts, topics, publications, sources, fetch, inference, defaultModel, settings, now }: {
  db: Database.Database; accounts: AccountStore; topics: TopicStore; publications: PublicationStore; sources: SourceStore; fetch: PoliteFetch;
  inference: Inference | null; defaultModel: string | null; settings: PublishSettings; now: () => Date;
}): Record<string, Handler> {
  const clock = () => now().getTime();
  return {
    ...windowHandlers({ db, accounts, sources, publications, settings, now: clock }),
    "collect-source": collectHandler({ db, sources, fetch, now: clock }),
    "discover-sources": discoverHandler({ db, sources, agents: () => accounts.watchAgents(), fetch, now: clock }),
    "evaluate-story": evaluateHandler({ db, accounts, topics, publications, sources, inference, defaultModel, now: clock }),
    "draft-candidate": draftHandler({ db, accounts, topics, publications, inference, defaultModel, now: clock }),
  };
}

/**
 * One scheduler pass:
 * 1. scheduled resumptions of paused agents (with their recorded catch-up choice);
 * 2. outage detection: a gap since the previous pass longer than OUTAGE_MS grants each running
 *    agent a bounded catch-up of its missed watch time;
 * 3. planning (all idempotent; only kinds with a handler): publication windows from each agent's
 *    publish calendar; collection, discovery, evaluation and drafting for agents inside their watch
 *    calendar or a grant; light off-hours detection for agents allowing major events (collection,
 *    then only stories already carried by several independent voices, at high priority);
 * 4. draining what is due, each job admitted when it starts;
 * 5. purges (finished jobs, collected items, execution logs by retention).
 */
export async function tick({ db, accounts, sources, handlers, canEvaluate = () => false, now = () => new Date(), deadline, concurrency = 1, inferenceConcurrency = 1, retentionDays = globalRetentionDays() }: {
  db: Database.Database; accounts: AccountStore; sources?: SourceStore; handlers: Record<string, Handler>;
  /** Whether a model is configured for the agent (local server and model reference). */
  canEvaluate?: (agent: WatchAgent) => boolean; now?: () => Date; deadline?: number;
  /** Jobs run at once by this pass, and inference jobs at once across processes. */
  concurrency?: number; inferenceConcurrency?: number; retentionDays?: number;
}) {
  const clock = () => now().getTime();
  const queue = createJobQueue(db, clock);
  migrateWatchWorker(db);
  const previous = (db.prepare("SELECT last_tick_at FROM watch_worker WHERE id = 'worker'").get() as { last_tick_at: number | null } | undefined)?.last_tick_at ?? null;

  const resumed = await accounts.resumeDue(now());
  let agents = await accounts.watchAgents();
  const running = () => agents.filter(agent => agent.active && agent.watch.valid && agent.watch.policy.enabled && !agent.watch.policy.paused);
  let caughtUp = 0;
  for (const { agentId, pause } of resumed) {
    const agent = agents.find(item => item.id === agentId);
    if (agent && pause.resumeWith === "catch-up" && catchUp(db, agent, Date.parse(pause.since), clock(), "Reprise programmée après pause, avec rattrapage.")) caughtUp++;
  }
  if (previous !== null && clock() - previous > OUTAGE_MS) {
    for (const agent of running()) if (catchUp(db, agent, previous, clock(), `Interruption du worker détectée (aucun passage pendant ${Math.round((clock() - previous) / 60_000)} min).`)) caughtUp++;
  }
  const grants = activeGrants(db, clock());
  const watching = running().filter(agent => grants.has(agent.id) || watchOpen(agent, clock()));
  const lightly = running().filter(agent => !watching.includes(agent) && agentSchedule(agent).majorEvents.enabled);

  let planned = 0;
  for (const agent of agents) {
    for (const job of planAgentJobs(agent, now())) {
      if (handlers[job.kind] && queue.enqueue({ kind: job.kind, key: job.key, payload: job.payload, runAfter: job.runAfter.getTime(), maxAttempts: 3 }).created) planned++;
    }
  }
  if (sources && handlers["collect-source"]) planned += planCollection(db, queue, await sources.approved(), [...watching, ...lightly], clock());
  if (handlers["discover-sources"]) planned += planDiscovery(queue, watching, clock());
  if (handlers["evaluate-story"]) {
    planned += planEvaluation(db, queue, watching, canEvaluate, clock(), { grants });
    planned += planEvaluation(db, queue, lightly, canEvaluate, clock(), { major: true });
  }
  if (handlers["draft-candidate"]) {
    planned += planDrafting(db, queue, watching, canEvaluate, clock());
    planned += planDrafting(db, queue, lightly, canEvaluate, clock(), { major: true });
  }
  if (handlers["publish-alert"]) planned += planAlerts(db, queue, agents.filter(agent => agentSchedule(agent).majorEvents.enabled || publishOpen(agent, clock())), clock());

  const byId = () => new Map(agents.map(agent => [agent.id, agent]));
  let index = byId();
  let readAt = clock();
  // Re-read at most every 30 s: a pause or calendar change applies to jobs not yet started.
  const fresh = async () => { if (clock() - readAt > 30_000) { agents = await accounts.watchAgents(); index = byId(); readAt = clock(); } return index; };
  const control: DrainControl = {
    db,
    admit: async job => { const agentId = jobAgent(job); return admit(job, agentId ? (await fresh()).get(agentId) : undefined, activeGrants(db, clock()), clock()); },
    owner: async job => { const agentId = jobAgent(job); return (agentId ? (await fresh()).get(agentId)?.owner : null) ?? ((job.payload as { owner?: unknown } | null)?.owner as string | undefined) ?? null; },
  };
  const drained = await drainJobs({ queue, handlers, deadline, clock, concurrency, limits: [{ kinds: INFERENCE_KINDS, max: inferenceConcurrency }], control });
  const purged = queue.purge(30 * 86_400_000);
  const purgedItems = sources ? purgeItems(db, clock()) + purgeCandidates(db, clock()) + purgeDecisions(db, clock()) : 0;
  const purgedRuns = purgeRuns(db, agents, clock(), retentionDays);
  const summary = { planned, ...drained, resumed: resumed.length, caughtUp, purged, purgedItems, purgedRuns, queue: queue.counts() };
  recordWorker(db, { at: clock(), summary });
  return summary;
}

/** Last pass of the worker, shown on the agent pages (one row: a single worker host is expected). */
export function migrateWatchWorker(db: Database.Database) {
  db.exec("CREATE TABLE IF NOT EXISTS watch_worker (id TEXT PRIMARY KEY, last_tick_at INTEGER, summary TEXT, last_error TEXT, last_error_at INTEGER)");
}
export function recordWorker(db: Database.Database, entry: { at: number; summary?: unknown; error?: string }) {
  migrateWatchWorker(db);
  if (entry.error) db.prepare("INSERT INTO watch_worker (id, last_error, last_error_at) VALUES ('worker', ?, ?) ON CONFLICT(id) DO UPDATE SET last_error = excluded.last_error, last_error_at = excluded.last_error_at").run(entry.error.slice(0, 500), entry.at);
  else db.prepare("INSERT INTO watch_worker (id, last_tick_at, summary) VALUES ('worker', ?, ?) ON CONFLICT(id) DO UPDATE SET last_tick_at = excluded.last_tick_at, summary = excluded.summary").run(entry.at, JSON.stringify(entry.summary));
}
