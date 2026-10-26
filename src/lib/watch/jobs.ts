import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

/**
 * Durable job queue of the watch engine, in the application SQLite database (WAL).
 * Operational state, not derived from the vault: it is never dropped with the index tables.
 * A claim takes a lease with a fencing token: only the current holder can finish the job,
 * and an expired lease (crashed worker) makes the job claimable again.
 */
export type JobState = "pending" | "running" | "done" | "failed";
export type Job = {
  id: string; kind: string; key: string; payload: unknown; state: JobState; priority?: number;
  runAfter: number; attempts: number; maxAttempts: number;
  leaseToken: string | null; leaseUntil: number | null;
  lastError: string | null; result: unknown; createdAt: number; updatedAt: number;
};
type Row = {
  id: string; kind: string; key: string; payload: string; state: JobState; priority: number; run_after: number; attempts: number; max_attempts: number;
  lease_token: string | null; lease_until: number | null; last_error: string | null; result: string | null; created_at: number; updated_at: number;
};

export function migrateWatchJobs(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS watch_job (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      key TEXT NOT NULL UNIQUE,
      payload TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'done', 'failed')),
      run_after INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL,
      lease_token TEXT,
      lease_until INTEGER,
      last_error TEXT,
      result TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS watch_job_due ON watch_job (state, run_after);
  `);
  // Additive: older rows (and older binaries, which ignore the column) keep priority 0.
  if (!db.prepare<[], { name: string }>("SELECT name FROM pragma_table_info('watch_job')").all().some(column => column.name === "priority")) {
    db.exec("ALTER TABLE watch_job ADD COLUMN priority INTEGER NOT NULL DEFAULT 0");
  }
}

/** Ordinary work: 0. Manual runs: 5. Major events: 10. */
export const PRIORITY = { ordinary: 0, manual: 5, major: 10 } as const;
/**
 * Anti-starvation: a due job gains one priority point per AGING_MS of waiting (capped), so an
 * ordinary job waiting an hour ranks with a fresh major event and then passes by age.
 */
export const AGING_MS = 6 * 60_000;
const MAX_AGING = 20;
/**
 * Pipeline stage: drafting an already accepted candidate ranks just below a fresh major event, so a
 * backlog of evaluations (a bulk re-analysis) never holds back the next publication. Aging still
 * applies: evaluations waiting about an hour longer pass first, and drafts are few (one per accepted
 * candidate). No preemption: a running job keeps its lease and the concurrency limits hold.
 */
export const STAGE_BONUS: Record<string, number> = { "draft-candidate": PRIORITY.major - 1 };
const stageBonus = `CASE kind ${Object.entries(STAGE_BONUS).map(([kind, bonus]) => `WHEN '${kind}' THEN ${bonus}`).join(" ")} ELSE 0 END`;
/** At most `max` jobs of these kinds may hold a live lease at once, across every process. */
export type ConcurrencyLimit = { kinds: readonly string[]; max: number };

const toJob = (row: Row): Job => ({
  id: row.id, kind: row.kind, key: row.key, payload: JSON.parse(row.payload), state: row.state, priority: row.priority ?? 0,
  runAfter: row.run_after, attempts: row.attempts, maxAttempts: row.max_attempts,
  leaseToken: row.lease_token, leaseUntil: row.lease_until, lastError: row.last_error,
  result: row.result === null ? null : JSON.parse(row.result), createdAt: row.created_at, updatedAt: row.updated_at,
});

/** Retry delay after the n-th failed attempt: 1 min, 2, 4… capped at 6 h. */
export const retryDelay = (attempts: number) => Math.min(60_000 * 2 ** Math.max(0, attempts - 1), 6 * 3_600_000);

// Errors are stored for diagnostics: keep them short; handlers must not put content or secrets in messages.
const describe = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 500);

export function createJobQueue(db: Database.Database, now: () => number = Date.now) {
  migrateWatchJobs(db);

  /**
   * Idempotent: the key identifies the job for its whole life, even once done or failed.
   * Re-planning a pending job with a higher priority raises it (an ordinary job found to be a major event).
   */
  function enqueue(input: { kind: string; key: string; payload: unknown; runAfter?: number; maxAttempts?: number; priority?: number }) {
    const at = now();
    const priority = input.priority ?? PRIORITY.ordinary;
    const inserted = db.prepare(`INSERT INTO watch_job (id, kind, key, payload, state, run_after, max_attempts, created_at, updated_at, priority)
      VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?) ON CONFLICT(key) DO NOTHING`)
      .run(randomUUID(), input.kind, input.key, JSON.stringify(input.payload ?? null), input.runAfter ?? at, input.maxAttempts ?? 5, at, at, priority).changes === 1;
    if (!inserted && priority > PRIORITY.ordinary) db.prepare("UPDATE watch_job SET priority = ?, updated_at = ? WHERE key = ? AND state = 'pending' AND priority < ?").run(priority, at, input.key, priority);
    const job = get(input.key)!;
    if (job.kind !== input.kind) throw new Error("Job key already used by another kind.");
    return { job, created: inserted };
  }

  function get(key: string) {
    const row = db.prepare<[string], Row>("SELECT * FROM watch_job WHERE key = ?").get(key);
    return row ? toJob(row) : null;
  }

  /**
   * Claims the due job of the given kinds with the highest aged priority plus stage bonus (oldest first on ties).
   * Kinds whose concurrency limit is reached are skipped. BEGIN IMMEDIATE: one claimer at a time across processes.
   */
  const claimTransaction = db.transaction((wanted: string[], leaseMs: number, limits: readonly ConcurrencyLimit[]) => {
    const at = now();
    const running = (kinds: readonly string[]) => (db.prepare<unknown[], { n: number }>(`SELECT count(*) AS n FROM watch_job WHERE state = 'running' AND lease_until > ? AND kind IN (${kinds.map(() => "?").join(", ")})`).get(at, ...kinds)!).n;
    const full = new Set(limits.filter(limit => limit.kinds.length && running(limit.kinds) >= limit.max).flatMap(limit => limit.kinds));
    const kinds = wanted.filter(kind => !full.has(kind));
    if (!kinds.length) return null;
    const placeholders = kinds.map(() => "?").join(", ");
    const due = db.prepare<unknown[], Row>(`SELECT * FROM watch_job WHERE kind IN (${placeholders})
      AND ((state = 'pending' AND run_after <= ?) OR (state = 'running' AND lease_until <= ?))
      ORDER BY priority + ${stageBonus} + min((? - run_after) / ${AGING_MS}, ${MAX_AGING}) DESC, run_after, created_at, rowid LIMIT 1`);
    for (;;) {
      const row = due.get(...kinds, at, at, at);
      if (!row) return null;
      // A job whose holder kept crashing has used its attempts: stop instead of looping forever.
      if (row.state === "running" && row.attempts >= row.max_attempts) {
        db.prepare("UPDATE watch_job SET state = 'failed', lease_token = NULL, lease_until = NULL, last_error = ?, updated_at = ? WHERE id = ?")
          .run("Lease expired after the last attempt.", at, row.id);
        continue;
      }
      const token = randomUUID();
      db.prepare("UPDATE watch_job SET state = 'running', attempts = attempts + 1, lease_token = ?, lease_until = ?, updated_at = ? WHERE id = ?")
        .run(token, at + leaseMs, at, row.id);
      return toJob(db.prepare<[string], Row>("SELECT * FROM watch_job WHERE id = ?").get(row.id)!);
    }
  });
  function claim(kinds: string[], leaseMs: number, limits: readonly ConcurrencyLimit[] = []): Job | null {
    if (!kinds.length) return null;
    return claimTransaction.immediate(kinds, leaseMs, limits);
  }

  /** Every transition below requires the current lease: false means the lease was lost. */
  const held = "WHERE id = @id AND lease_token = @token AND state = 'running'";
  function heartbeat(job: Job, leaseMs: number) {
    return db.prepare(`UPDATE watch_job SET lease_until = @until, updated_at = @at ${held}`).run({ id: job.id, token: job.leaseToken, until: now() + leaseMs, at: now() }).changes === 1;
  }
  function complete(job: Job, result: unknown = null) {
    return db.prepare(`UPDATE watch_job SET state = 'done', result = @result, lease_token = NULL, lease_until = NULL, updated_at = @at ${held}`)
      .run({ id: job.id, token: job.leaseToken, result: JSON.stringify(result), at: now() }).changes === 1;
  }
  /** Not a failure (e.g. inference unavailable): back to pending without consuming an attempt. */
  function wait(job: Job, until: number, reason: string) {
    return db.prepare(`UPDATE watch_job SET state = 'pending', attempts = attempts - 1, run_after = @until, last_error = @reason, lease_token = NULL, lease_until = NULL, updated_at = @at ${held}`)
      .run({ id: job.id, token: job.leaseToken, until, reason: reason.slice(0, 500), at: now() }).changes === 1;
  }
  /** A permanent error (invalid data, refused configuration) is final at once: never retried in a loop. */
  function fail(job: Job, error: unknown, { permanent = false } = {}) {
    const at = now();
    const final = permanent || job.attempts >= job.maxAttempts;
    return db.prepare(`UPDATE watch_job SET state = @state, run_after = @runAfter, last_error = @error, lease_token = NULL, lease_until = NULL, updated_at = @at ${held}`)
      .run({ id: job.id, token: job.leaseToken, state: final ? "failed" : "pending", runAfter: final ? job.runAfter : at + retryDelay(job.attempts), error: describe(error), at }).changes === 1;
  }

  function counts() {
    const rows = db.prepare<[], { state: JobState; n: number }>("SELECT state, count(*) AS n FROM watch_job GROUP BY state").all();
    return Object.fromEntries(rows.map(row => [row.state, row.n])) as Partial<Record<JobState, number>>;
  }
  /** Removes finished jobs older than the retention period; their keys may then be reused. */
  function purge(olderThanMs: number) {
    return db.prepare("DELETE FROM watch_job WHERE state IN ('done', 'failed') AND updated_at < ?").run(now() - olderThanMs).changes;
  }

  return { enqueue, get, claim, heartbeat, complete, wait, fail, counts, purge };
}
export type JobQueue = ReturnType<typeof createJobQueue>;
