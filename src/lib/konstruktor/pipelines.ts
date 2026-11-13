import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { AccountStore } from "../accounts/store";
import type { PublicationStore } from "../publications/store";
import { enqueueSystemTask, systemTaskKey } from "../system-agents/queue";
import { systemAgentDefinition } from "../system-agents/registry";
import type { SystemAgentStore } from "../system-agents/store";
import { TopicError } from "../topics/types";
import { createJobQueue, type JobQueue, type JobState } from "../watch/jobs";
import { jobRuns, migrateOrchestrator, SYSTEM_TASK_KIND, type RunRecord } from "../watch/orchestrator";

/**
 * Konstruktor's knowledge pipelines, seen as CI runs. A run is a planned set of `publication-knowledge`
 * tasks on the existing system-task queue (`watch_job`); only the plan is stored here. Job states,
 * attempts, leases and logs stay the queue's and the execution history's (`xiagent_run`), so the web
 * server and the worker keep running them, and a restart resumes them through the queue's leases.
 */
export const PIPELINE_NAME = "Réindexation des connaissances";
export const PIPELINE_MODES = ["missing", "force"] as const;
export type PipelineMode = typeof PIPELINE_MODES[number];
export type PipelineTrigger = "manual" | "automatic";
export type PipelineStatus = "queued" | "running" | "success" | "partial" | "failed" | "cancelled";
export type PipelineJobStatus = "queued" | "running" | "interrupted" | "success" | "failed" | "skipped" | "cancelled";
const CANCELLED = "Annulé par l’utilisateur.";
const TERMINAL = new Set<PipelineJobStatus>(["success", "failed", "skipped", "cancelled"]);

export function migratePipelines(db: Database.Database) {
  migrateOrchestrator(db);
  db.exec(`CREATE TABLE IF NOT EXISTS konstruktor_pipeline_run (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, number INTEGER NOT NULL, agent TEXT NOT NULL, mode TEXT NOT NULL, trigger TEXT NOT NULL,
      created_at INTEGER NOT NULL, cancelled_at INTEGER, UNIQUE (owner, number));
    CREATE INDEX IF NOT EXISTS konstruktor_pipeline_run_owner ON konstruktor_pipeline_run (owner, agent, created_at);
    CREATE TABLE IF NOT EXISTS konstruktor_pipeline_job (
      run_id TEXT NOT NULL, position INTEGER NOT NULL, publication TEXT NOT NULL, title TEXT NOT NULL, revision TEXT,
      job_key TEXT, previous_keys TEXT NOT NULL DEFAULT '[]', skip_reason TEXT, PRIMARY KEY (run_id, publication));
    CREATE INDEX IF NOT EXISTS konstruktor_pipeline_job_key ON konstruktor_pipeline_job (job_key);`);
}

/** The worker's automatic key: one analysis per (owner, agent, publication, revision), shared by every run. */
export function knowledgeRequestId(owner: string, agent: string, publication: string, revision: string) {
  const digest = createHash("sha256").update(`${owner}:${agent}:${publication}:${revision}`).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

type RunRow = { id: string; owner: string; number: number; agent: string; mode: PipelineMode; trigger: PipelineTrigger; created_at: number; cancelled_at: number | null };
type JobRow = { run_id: string; position: number; publication: string; title: string; revision: string | null; job_key: string | null; previous_keys: string; skip_reason: string | null;
  job_id: string | null; state: JobState | null; last_error: string | null; result: string | null; lease_until: number | null; started_at: number | null; finished_at: number | null };
type Planned = { publication: string; title: string; revision: string | null; skip?: string; key?: { requestId: string; reuse: boolean } };

const startInput = z.object({ agent: z.uuid(), mode: z.enum(PIPELINE_MODES) }).strict();

export function createKnowledgePipelines({ db, accounts, publications, systemAgents, queue = createJobQueue(db), kick = () => {}, now = Date.now }: {
  db: Database.Database; accounts: Pick<AccountStore, "watchAgents">; publications: Pick<PublicationStore, "ensureIndexed" | "agentPublications" | "get">;
  systemAgents: Pick<SystemAgentStore, "get">; queue?: JobQueue; kick?: () => void; now?: () => number;
}) {
  migratePipelines(db);
  const konstruktor = systemAgentDefinition("konstruktor")!;

  function jobStatus(row: JobRow): { status: PipelineJobStatus; reason: string | null } {
    if (row.skip_reason) return { status: "skipped", reason: row.skip_reason };
    if (!row.state) return { status: "skipped", reason: "Historique purgé." };
    if (row.state === "pending") return { status: "queued", reason: row.last_error };
    if (row.state === "running") return row.lease_until !== null && row.lease_until <= now() ? { status: "interrupted", reason: "Interrompu (redémarrage) : reprise automatique." } : { status: "running", reason: null };
    if (row.state === "done") return (JSON.parse(row.result ?? "null") as { outcome?: string } | null)?.outcome === "obsolete" ? { status: "skipped", reason: "Publication modifiée depuis la planification." } : { status: "success", reason: null };
    return row.last_error === CANCELLED ? { status: "cancelled", reason: CANCELLED } : { status: "failed", reason: row.last_error };
  }

  function jobRows(runIds: string[], owner: string) {
    if (!runIds.length) return [];
    return db.prepare<{ runs: string; owner: string }, JobRow>(`SELECT j.*, w.id AS job_id, w.state, w.last_error, w.result, w.lease_until,
        (SELECT min(x.started_at) FROM xiagent_run x WHERE x.owner = @owner AND x.job_id = w.id) AS started_at,
        (SELECT max(x.finished_at) FROM xiagent_run x WHERE x.owner = @owner AND x.job_id = w.id) AS finished_at
      FROM konstruktor_pipeline_job j LEFT JOIN watch_job w ON w.key = j.job_key
      WHERE j.run_id IN (SELECT value FROM json_each(@runs)) ORDER BY j.run_id, j.position`).all({ runs: JSON.stringify(runIds), owner });
  }

  function summarize(run: RunRow, jobs: JobRow[]) {
    const states = jobs.map(jobStatus);
    const count = (status: PipelineJobStatus) => states.filter(item => item.status === status).length;
    const counts = { queued: count("queued"), running: count("running") + count("interrupted"), success: count("success"), failed: count("failed"), skipped: count("skipped"), cancelled: count("cancelled") };
    const finished = states.filter(item => TERMINAL.has(item.status)).length;
    let status: PipelineStatus;
    if (counts.running) status = "running";
    // Planning-time skips do not start a run: it stays queued until a job has begun.
    else if (counts.queued) status = states.some(item => !["queued", "skipped"].includes(item.status)) || jobs.some(job => job.started_at !== null) ? "running" : "queued";
    else if (counts.cancelled || run.cancelled_at) status = "cancelled";
    else if (counts.failed) status = counts.success ? "partial" : "failed";
    else status = "success";
    const starts = jobs.map(job => job.started_at).filter((at): at is number => at !== null);
    const ends = jobs.map(job => job.finished_at).filter((at): at is number => at !== null);
    const startedAt = starts.length ? Math.min(...starts) : null;
    const terminal = !["queued", "running"].includes(status);
    const finishedAt = terminal ? (ends.length ? Math.max(...ends) : run.cancelled_at ?? run.created_at) : null;
    return {
      id: run.id, number: run.number, pipeline: PIPELINE_NAME, agent: run.agent, mode: run.mode, trigger: run.trigger, status,
      createdAt: run.created_at, startedAt, finishedAt, durationMs: startedAt === null ? null : (finishedAt ?? now()) - startedAt,
      progress: { done: finished, total: jobs.length }, counts,
    };
  }

  const ownRun = (owner: string, id: string) => {
    const run = z.uuid().safeParse(id).success ? db.prepare<[string, string], RunRow>("SELECT * FROM konstruktor_pipeline_run WHERE id = ? AND owner = ?").get(id, owner) : undefined;
    if (!run) throw new TopicError("Run introuvable.", 404);
    return run;
  };
  /** Another run of this agent still has work queued or running (cross-process: read inside an IMMEDIATE transaction). */
  const activeRun = (owner: string, agent: string, except = "") => db.prepare<[string, string, string], { id: string }>(`SELECT r.id FROM konstruktor_pipeline_run r
      JOIN konstruktor_pipeline_job j ON j.run_id = r.id JOIN watch_job w ON w.key = j.job_key
      WHERE r.owner = ? AND r.agent = ? AND r.id != ? AND w.state IN ('pending', 'running') LIMIT 1`).get(owner, agent, except);
  const enqueue = (owner: string, agent: string, publication: string, revision: string, requestId: string) =>
    enqueueSystemTask(queue, { agentId: konstruktor.id, kind: "konstruktor", task: "publication-knowledge", owner, requestId, input: { publication, agent, revision }, trigger: "review" });

  /** The owner's own agent, its real publications, and what each needs: decided before any write. */
  /** Any completed analysis of this exact revision counts, whichever run or retry produced it. */
  const analysed = (owner: string, agent: string, publication: string, revision: string) => !!db.prepare<unknown[], { found: number }>(`SELECT 1 AS found FROM watch_job
      WHERE kind = ? AND state = 'done' AND json_extract(result, '$.outcome') = 'done' AND json_extract(payload, '$.task') = 'publication-knowledge'
      AND json_extract(payload, '$.owner') = ? AND json_extract(payload, '$.input.agent') = ? AND json_extract(payload, '$.input.publication') = ? AND json_extract(payload, '$.input.revision') = ? LIMIT 1`)
    .get(SYSTEM_TASK_KIND, owner, agent, publication, revision);

  async function plan(owner: string, agentId: string, mode: PipelineMode, trigger: PipelineTrigger): Promise<Planned[]> {
    const agent = (await accounts.watchAgents()).find(item => item.id === agentId && item.owner === owner);
    if (!agent) throw new TopicError("ΞAgent introuvable.", 404);
    await publications.ensureIndexed();
    const planned: Planned[] = [];
    for (const item of publications.agentPublications(agent.id)) {
      const title = (item.excerpt ?? "").slice(0, 140) || item.id;
      if (item.test) { planned.push({ publication: item.id, title, revision: null, skip: "Contenu de test exclu." }); continue; }
      const publication = await publications.get({ id: owner }, item.id).catch(() => null);
      if (!publication || publication.status !== "published") { planned.push({ publication: item.id, title, revision: null, skip: "Publication illisible ou non publiée." }); continue; }
      // The publication's own words; the index excerpt is normalized for search.
      const label = publication.summary.slice(0, 140) || title;
      const automatic = knowledgeRequestId(owner, agent.id, publication.id, publication.revision);
      const existing = queue.get(systemTaskKey("konstruktor", owner, automatic));
      if (mode === "missing" && (existing?.state === "done" || analysed(owner, agent.id, publication.id, publication.revision))) { planned.push({ publication: item.id, title: label, revision: publication.revision, skip: "Déjà analysée à cette révision." }); continue; }
      // The worker never retries a failure on its own: that is the owner's explicit decision (« Relancer les échecs »).
      if (trigger === "automatic" && existing?.state === "failed") { planned.push({ publication: item.id, title: label, revision: publication.revision, skip: "Échec précédent : relance manuelle requise." }); continue; }
      // A forced analysis, or a failed one, gets a new task; otherwise the shared automatic task (queued or new).
      const fresh = mode === "force" || existing?.state === "failed";
      planned.push({ publication: item.id, title: label, revision: publication.revision, key: { requestId: fresh ? randomUUID() : automatic, reuse: !fresh && !!existing } });
    }
    return planned;
  }

  /**
   * `missing`: only publications without a completed analysis of their current revision. `force`: every real
   * publication again; the task deduplicates concepts and never undoes an exclusion or a correction.
   * One active run per agent; an automatic run is only created when there is something to analyse.
   */
  async function start(owner: string, input: unknown, trigger: PipelineTrigger = "manual") {
    const data = startInput.parse(input);
    if (!(await systemAgents.get("konstruktor")).enabled) throw new TopicError("Konstruktor est désactivé.", 409);
    const planned = await plan(owner, data.agent, data.mode, trigger);
    const id = randomUUID();
    const created = db.transaction(() => {
      if (activeRun(owner, data.agent)) {
        if (trigger === "automatic") return null;
        throw new TopicError("Un run est déjà en cours pour ce ΞAgent.", 409);
      }
      if (trigger === "automatic" && !planned.some(item => item.key && !item.key.reuse)) return null;
      const number = db.prepare<[string], { n: number }>("SELECT coalesce(max(number), 0) + 1 AS n FROM konstruktor_pipeline_run WHERE owner = ?").get(owner)!.n;
      db.prepare("INSERT INTO konstruktor_pipeline_run (id, owner, number, agent, mode, trigger, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, owner, number, data.agent, data.mode, trigger, now());
      const insert = db.prepare("INSERT INTO konstruktor_pipeline_job (run_id, position, publication, title, revision, job_key, skip_reason) VALUES (?, ?, ?, ?, ?, ?, ?)");
      let enqueued = 0;
      planned.forEach((item, position) => {
        const key = item.key ? enqueue(owner, data.agent, item.publication, item.revision!, item.key.requestId).job.key : null;
        if (item.key && !item.key.reuse) enqueued++;
        insert.run(id, position, item.publication, item.title, item.revision, key, item.skip ?? null);
      });
      return { enqueued };
    }).immediate();
    if (!created) return null;
    if (created.enqueued) kick();
    return { run: get(owner, id), enqueued: created.enqueued };
  }

  /** Failed jobs only, as new tasks; earlier attempts stay in the job's history. */
  function retry(owner: string, runId: string) {
    const run = ownRun(owner, runId);
    const retried = db.transaction(() => {
      if (activeRun(owner, run.agent, run.id)) throw new TopicError("Un autre run est en cours pour ce ΞAgent.", 409);
      const failed = jobRows([run.id], owner).filter(row => jobStatus(row).status === "failed");
      for (const row of failed) {
        const key = enqueue(owner, run.agent, row.publication, row.revision!, randomUUID()).job.key;
        db.prepare("UPDATE konstruktor_pipeline_job SET job_key = ?, previous_keys = json_insert(previous_keys, '$[#]', ?) WHERE run_id = ? AND publication = ?").run(key, row.job_key, run.id, row.publication);
      }
      return failed.length;
    }).immediate();
    if (!retried) throw new TopicError("Aucun job en échec à relancer.", 409);
    kick();
    return get(owner, runId);
  }

  /** Queued jobs are withdrawn; a running one finishes (its lease is never broken). */
  function cancel(owner: string, runId: string) {
    const run = ownRun(owner, runId);
    db.transaction(() => {
      db.prepare("UPDATE konstruktor_pipeline_run SET cancelled_at = coalesce(cancelled_at, ?) WHERE id = ?").run(now(), run.id);
      for (const row of jobRows([run.id], owner)) if (row.job_key && row.state === "pending") queue.cancel(row.job_key, CANCELLED);
    }).immediate();
    return get(owner, runId);
  }

  function list(owner: string, { agent, limit = 30 }: { agent?: string; limit?: number } = {}) {
    const runs = db.prepare<unknown[], RunRow>(`SELECT * FROM konstruktor_pipeline_run WHERE owner = ? ${agent ? "AND agent = ?" : ""} ORDER BY created_at DESC, number DESC LIMIT ?`)
      .all(...[owner, ...(agent ? [agent] : []), Math.min(limit, 100)]);
    const byRun = new Map<string, JobRow[]>();
    for (const row of jobRows(runs.map(run => run.id), owner)) byRun.set(row.run_id, [...byRun.get(row.run_id) ?? [], row]);
    const summaries = runs.map(run => summarize(run, byRun.get(run.id) ?? []));
    // Viewing active runs also resumes work left behind by a restart, without waiting for the worker.
    if (summaries.some(run => run.status === "queued" || run.status === "running")) kick();
    return summaries;
  }

  function get(owner: string, runId: string) {
    const run = ownRun(owner, runId);
    const rows = jobRows([run.id], owner);
    const summary = summarize(run, rows);
    if (summary.status === "queued" || summary.status === "running") kick();
    const keys = (row: JobRow) => [...JSON.parse(row.previous_keys) as string[], ...(row.job_key ? [row.job_key] : [])];
    const jobs = rows.map(row => {
      const attempts: Pick<RunRecord, "status" | "attempt" | "startedAt" | "finishedAt" | "error" | "logs">[] = keys(row).flatMap(key => {
        const job = queue.get(key);
        return job ? jobRuns(db, owner, job.id).map(({ status, attempt, startedAt, finishedAt, error, logs }) => ({ status, attempt, startedAt, finishedAt, error, logs })) : [];
      });
      const { status, reason } = jobStatus(row);
      return { publication: row.publication, title: row.title, revision: row.revision, status, reason, startedAt: row.started_at, finishedAt: TERMINAL.has(status) ? row.finished_at : null, result: row.state === "done" ? JSON.parse(row.result ?? "null") : null, attempts };
    });
    const planned = rows.filter(row => !row.skip_reason).length;
    const analysis: PipelineStatus = summary.status;
    const stages = [
      { name: "Planification", status: "success" as PipelineStatus, detail: `${planned} publication(s) à analyser, ${rows.length - planned} ignorée(s).`, startedAt: run.created_at, finishedAt: run.created_at },
      { name: "Analyse Konstruktor", status: analysis, detail: `${summary.progress.done}/${summary.progress.total} traitée(s).`, startedAt: summary.startedAt, finishedAt: summary.finishedAt },
      { name: "Bilan", status: (["queued", "running"].includes(analysis) ? "queued" : analysis) as PipelineStatus, detail: `${summary.counts.success} réussie(s), ${summary.counts.failed} en échec, ${summary.counts.skipped} ignorée(s)${summary.counts.cancelled ? `, ${summary.counts.cancelled} annulée(s)` : ""}.`, startedAt: summary.finishedAt, finishedAt: summary.finishedAt },
    ];
    return { ...summary, stages, jobs };
  }

  /** The worker's pass: an automatic `missing` run for each agent with new work and no active run. */
  async function planAutomatic() {
    if (!(await systemAgents.get("konstruktor")).enabled) return 0;
    let enqueued = 0;
    for (const agent of await accounts.watchAgents()) {
      const result = await start(agent.owner, { agent: agent.id, mode: "missing" }, "automatic").catch(() => null);
      enqueued += result?.enqueued ?? 0;
    }
    return enqueued;
  }

  return { start, retry, cancel, list, get, planAutomatic };
}
export type KnowledgePipelines = ReturnType<typeof createKnowledgePipelines>;
export type PipelineRun = ReturnType<KnowledgePipelines["get"]>;
export type PipelineSummary = ReturnType<KnowledgePipelines["list"]>[number];
