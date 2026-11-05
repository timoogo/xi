import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { checkMigrationOnCopy } from "../src/lib/maintenance/migration-check";
import { createJobQueue } from "../src/lib/watch/jobs";
import { files } from "./helpers/konstruktor";
import { world } from "./helpers/publish-world";

/**
 * A database as an instance before the editorial queue (L8) and the supervision indexes (L9) left it:
 * drafted candidates (one already published), a legacy publication window planned. Built in the
 * fixture's own temporary directory, then checked through a copy.
 */
async function oldInstance(t: test.TestContext) {
  const w = await world(t, "2026-01-15T22:00:00Z");
  await w.drafted({ title: "Le Sénat adopte la loi sur l'eau", fact: "Le Sénat a adopté mardi la loi sur la gestion de l'eau" });
  await w.drafted({ title: "Le budget de la culture augmente", fact: "Le ministère de la Culture disposera de crédits accrus en 2027" });
  // Legacy mode: the agent's night window (its own slot) publishes one of them.
  w.clock.now = w.slot(new Date(w.clock.now));
  await w.run();
  assert.equal(w.db.prepare("SELECT count(*) FROM watch_decision WHERE outcome = 'published'").pluck().get(), 1);
  createJobQueue(w.db, () => w.clock.now).enqueue({ kind: "publication-window", key: "publication-window:legacy", payload: { agentId: w.agentId }, runAfter: w.clock.now + 86_400_000, maxAttempts: 3 });
  w.db.exec("DROP TABLE editorial_queue; DROP INDEX IF EXISTS xiagent_run_owner; DROP INDEX IF EXISTS watch_decision_owner;");
  w.db.pragma("wal_checkpoint(TRUNCATE)");
  return w;
}

test("migration on a copy: the pre-L8 instance migrates, twice, without loss; the queue is rebuilt; the originals are untouched", { timeout: 60_000 }, async t => {
  const w = await oldInstance(t);
  const published = w.db.prepare("SELECT count(*) FROM watch_decision WHERE outcome = 'published'").pluck().get() as number;
  assert.equal(published, 1);
  const originals = await files(w.root);
  const database = join(w.root, "app.sqlite");
  const before = await import("node:fs/promises").then(fs => fs.readFile(database));
  const work = await mkdtemp(join(tmpdir(), "xi-migration-copy-"));
  t.after(() => rm(work, { recursive: true, force: true }));

  const report = await checkMigrationOnCopy({ database, vault: w.root, workDir: join(work, "run"), now: w.clock.now });
  assert.ok(report.ok, JSON.stringify(report.problems));
  assert.ok(report.notes.includes("Table créée : editorial_queue."));
  assert.ok(report.notes.some(note => /fenêtre\(s\) de publication historique/.test(note)), "a rollback to legacy finds its windows");
  assert.deepEqual(report.queue, { ready: 1, drafted: 1 }, "the unpublished draft waits in the queue; the published one is not re-queued as ready");
  for (const table of ["watch_candidate", "watch_decision", "watch_job", "watch_story", "watch_item"]) assert.ok(report.after[table] >= report.before[table], table);
  // The copy is the migrated one; the originals did not change (files, SQLite bytes, schema).
  const copied = new Database(report.copy.database, { readonly: true });
  t.after(() => copied.close());
  assert.equal(copied.prepare("SELECT count(*) FROM sqlite_master WHERE name IN ('editorial_queue', 'xiagent_run_owner', 'watch_decision_owner')").pluck().get(), 3);
  assert.deepEqual(await files(w.root), originals);
  assert.deepEqual(await import("node:fs/promises").then(fs => fs.readFile(database)), before);
  assert.equal(w.db.prepare("SELECT count(*) FROM sqlite_master WHERE name = 'editorial_queue'").pluck().get(), 0);

  // Refused: a work directory inside the vault or next to the database.
  await assert.rejects(checkMigrationOnCopy({ database, vault: w.root, workDir: join(w.root, "copie") }), /distinct/);
});

test("migration-check script: Better Auth and application migrations on the copy, JSON report, exit status", { timeout: 120_000 }, async t => {
  const w = await oldInstance(t);
  const originals = await files(w.root);
  const { stdout } = await promisify(execFile)("npx", ["tsx", "scripts/migration-check.ts", "--database", join(w.root, "app.sqlite"), "--vault", w.root], {
    env: { ...process.env, BETTER_AUTH_SECRET: "x".repeat(40), BETTER_AUTH_URL: "http://localhost:3000", AUTH_DATABASE_PATH: "/nonexistent/never-used.sqlite" },
  });
  const report = JSON.parse(stdout) as { ok: boolean; queue: { ready: number }; notes: string[] };
  assert.equal(report.ok, true, stdout);
  assert.equal(report.queue.ready, 1, stdout);
  assert.ok(report.notes.includes("Table créée : user."), "Better Auth's tables created on the copy");
  assert.deepEqual(await files(w.root), originals, "the originals are never written");
});
