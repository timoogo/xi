import type Database from "better-sqlite3";
import type { AccountStore } from "../accounts/store";
import type { PublicationStore } from "../publications/store";
import { createJobQueue, type Job, type JobQueue } from "./jobs";
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
export type DrainSummary = { done: number; waiting: number; retried: number; failed: number; lost: number };

/**
 * Runs due jobs until none is left, `maxJobs` is reached or `deadline` passes.
 * The lease is renewed while a handler runs; a lost lease is never overwritten.
 */
export async function drainJobs({ queue, handlers, leaseMs = 5 * 60_000, maxJobs = 50, deadline = Infinity, clock = Date.now }: {
  queue: JobQueue; handlers: Record<string, Handler>; leaseMs?: number; maxJobs?: number; deadline?: number; clock?: () => number;
}): Promise<DrainSummary> {
  const summary: DrainSummary = { done: 0, waiting: 0, retried: 0, failed: 0, lost: 0 };
  for (let count = 0; count < maxJobs && clock() < deadline; count++) {
    const job = queue.claim(Object.keys(handlers), leaseMs);
    if (!job) break;
    const renew = setInterval(() => queue.heartbeat(job, leaseMs), Math.max(1_000, leaseMs / 3));
    renew.unref();
    let applied: boolean;
    let outcome: keyof DrainSummary;
    try {
      const result = await handlers[job.kind](job);
      if (result.status === "wait") { applied = queue.wait(job, result.until.getTime(), result.reason); outcome = "waiting"; }
      else { applied = queue.complete(job, result.result ?? null); outcome = "done"; }
    } catch (error) {
      applied = queue.fail(job, error);
      outcome = job.attempts >= job.maxAttempts ? "failed" : "retried";
    } finally { clearInterval(renew); }
    summary[applied ? outcome : "lost"]++;
  }
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
 * One scheduler pass: plan every agent's coming window, due collections of approved sources and
 * daily discovery (all idempotent; only kinds with a handler are planned), then run what is due.
 */
export async function tick({ db, accounts, sources, handlers, canEvaluate = () => false, now = () => new Date(), deadline }: {
  db: Database.Database; accounts: AccountStore; sources?: SourceStore; handlers: Record<string, Handler>;
  /** Whether a model is configured for the agent (local server and model reference). */
  canEvaluate?: (agent: WatchAgent) => boolean; now?: () => Date; deadline?: number;
}) {
  const queue = createJobQueue(db, () => now().getTime());
  const agents = await accounts.watchAgents();
  let planned = 0;
  for (const agent of agents) {
    for (const job of planAgentJobs(agent, now())) {
      if (handlers[job.kind] && queue.enqueue({ kind: job.kind, key: job.key, payload: job.payload, runAfter: job.runAfter.getTime(), maxAttempts: 3 }).created) planned++;
    }
  }
  if (sources && handlers["collect-source"]) planned += planCollection(db, queue, await sources.approved(), agents, now().getTime());
  if (handlers["discover-sources"]) planned += planDiscovery(queue, agents, now().getTime());
  if (handlers["evaluate-story"]) planned += planEvaluation(db, queue, agents, canEvaluate, now().getTime());
  if (handlers["draft-candidate"]) planned += planDrafting(db, queue, agents, canEvaluate, now().getTime());
  if (handlers["publish-alert"]) planned += planAlerts(db, queue, agents, now().getTime());
  const drained = await drainJobs({ queue, handlers, deadline, clock: () => now().getTime() });
  const purged = queue.purge(30 * 86_400_000);
  const purgedItems = sources ? purgeItems(db, now().getTime()) + purgeCandidates(db, now().getTime()) + purgeDecisions(db, now().getTime()) : 0;
  const summary = { planned, ...drained, purged, purgedItems, queue: queue.counts() };
  recordWorker(db, { at: now().getTime(), summary });
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
