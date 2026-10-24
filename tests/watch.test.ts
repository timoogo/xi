import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { createAccountStore } from "../src/lib/accounts/store";
import { DEFAULT_WATCH_POLICY, type WatchPolicy } from "../src/lib/accounts/types";
import { createPublicationStore } from "../src/lib/publications/store";
import { openVault } from "../src/lib/publications/vault";
import { createTopicStore } from "../src/lib/topics/store";
import { createJobQueue, retryDelay } from "../src/lib/watch/jobs";
import { agentSlot, inNightWindow, nightWindow, planAgentJobs, publicationGate, zonedParts } from "../src/lib/watch/schedule";
import { drainJobs, tick, windowHandlers } from "../src/lib/watch/worker";
import { createSourceStore } from "../src/lib/watch/sources";

const exec = promisify(execFile);
const child = (...args: string[]) => exec(process.execPath, ["--import", "tsx", "tests/helpers/watch-child.ts", ...args]).then(r => JSON.parse(r.stdout) as string[]);
const at = (iso: string) => new Date(iso);
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const enabled: WatchPolicy = { ...DEFAULT_WATCH_POLICY, enabled: true };

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "xi-watch-"));
  const dbPath = join(root, "app.sqlite");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL"); db.pragma("busy_timeout = 5000");
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  const vault = await openVault(root);
  const topics = createTopicStore({ vault, db });
  const accounts = createAccountStore({ vault, db, topics });
  const publications = createPublicationStore({ vault, db });
  const run = await topics.propose("alice", "Un jardin fictif");
  await topics.confirm("alice", run.id, { tag: "politiks", name: "Politiks", description: "Test", scope: "Simulation fictive", parentId: null, relatedIds: [] }, true);
  const proposed = await accounts.propose("alice", run.topicId);
  const ready = await accounts.resume("alice", proposed.id);
  await accounts.confirm("alice", ready.id, ready.draft, true);
  return { root, dbPath, db, vault, accounts, publications, sources: createSourceStore({ vault, topics }), topicId: run.topicId, agentId: ready.accountId };
}

test("schedule: Paris night window across DST, stable agent slots", () => {
  const winter = nightWindow(at("2026-01-15T12:00:00Z"));
  assert.equal(winter.date, "2026-01-16");
  assert.equal(winter.start.toISOString(), "2026-01-16T02:00:00.000Z"); assert.equal(winter.end.toISOString(), "2026-01-16T05:00:00.000Z");
  const summer = nightWindow(at("2026-07-15T12:00:00Z"));
  assert.equal(summer.start.toISOString(), "2026-07-16T01:00:00.000Z"); assert.equal(summer.end.toISOString(), "2026-07-16T04:00:00.000Z");
  // Spring forward (02:00 → 03:00) and fall back (03:00 → 02:00) nights.
  const spring = nightWindow(at("2026-03-28T22:00:00Z"));
  assert.deepEqual([spring.date, spring.start.toISOString(), spring.end.toISOString(), spring.sunday], ["2026-03-29", "2026-03-29T01:00:00.000Z", "2026-03-29T04:00:00.000Z", true]);
  const autumn = nightWindow(at("2026-10-24T22:00:00Z"));
  assert.deepEqual([autumn.date, autumn.start.toISOString(), autumn.end.toISOString(), autumn.sunday], ["2026-10-25", "2026-10-25T02:00:00.000Z", "2026-10-25T05:00:00.000Z", true]);
  assert.equal(zonedParts(autumn.start).hour, 3);
  // Inside the window it is the current one; from 06:00 the next one.
  assert.equal(nightWindow(at("2026-01-16T04:59:00Z")).date, "2026-01-16");
  assert.equal(nightWindow(at("2026-01-16T05:00:00Z")).date, "2026-01-17");
  assert.equal(inNightWindow(at("2026-01-16T02:00:00Z")), true);
  assert.equal(inNightWindow(at("2026-01-16T01:59:59Z")), false);
  assert.equal(inNightWindow(at("2026-01-16T05:00:00Z")), false);
  for (let i = 0; i < 50; i++) {
    const id = randomUUID();
    const slot = agentSlot(id, winter);
    assert.ok(slot >= winter.start && slot.getTime() < winter.start.getTime() + 150 * MIN);
    assert.equal(slot.getTime(), agentSlot(id, winter).getTime());
  }
});

test("schedule: publication gate, ceilings and no minimum quota", () => {
  const night = at("2026-01-16T03:00:00Z"); // 04:00 Paris, Friday
  const base = { lane: "night" as const, now: night, autoPublish: true, active: true, policyValid: true, policy: enabled, publishedAt: [] };
  assert.deepEqual(publicationGate(base), { allowed: true });
  assert.deepEqual(publicationGate({ ...base, autoPublish: false }), { allowed: false, reason: "auto-disabled", retryAt: null });
  assert.equal((publicationGate({ ...base, active: false }) as { reason: string }).reason, "inactive");
  assert.equal((publicationGate({ ...base, policyValid: false }) as { reason: string }).reason, "invalid-policy");
  assert.equal((publicationGate({ ...base, policy: DEFAULT_WATCH_POLICY }) as { reason: string }).reason, "disabled");
  assert.equal((publicationGate({ ...base, policy: { ...enabled, paused: true } }) as { reason: string }).reason, "paused");
  const noon = at("2026-01-16T11:00:00Z");
  assert.deepEqual(publicationGate({ ...base, now: noon }), { allowed: false, reason: "outside-window", retryAt: at("2026-01-17T02:00:00Z") });
  assert.deepEqual(publicationGate({ ...base, now: noon, lane: "immediate" }), { allowed: true });
  // Minimum interval between publications, for every lane.
  const recent = new Date(night.getTime() - 30 * MIN);
  assert.deepEqual(publicationGate({ ...base, publishedAt: [recent] }), { allowed: false, reason: "interval", retryAt: new Date(recent.getTime() + 240 * MIN) });
  assert.equal((publicationGate({ ...base, lane: "immediate", publishedAt: [recent] }) as { reason: string }).reason, "interval");
  // Rolling 24 h ceiling: allowed again when the oldest counted publication leaves the period.
  const policy = { ...enabled, maxPerDay: 2, minIntervalMinutes: 15 };
  const two = [new Date(night.getTime() - 20 * HOUR), new Date(night.getTime() - 2 * HOUR)];
  assert.deepEqual(publicationGate({ ...base, policy, publishedAt: two }), { allowed: false, reason: "daily-cap", retryAt: new Date(two[0].getTime() + DAY) });
  assert.deepEqual(publicationGate({ ...base, policy, publishedAt: [two[1], new Date(night.getTime() - 25 * HOUR)] }), { allowed: true });
  // Future instants (clock skew) are ignored rather than blocking.
  assert.deepEqual(publicationGate({ ...base, publishedAt: [new Date(night.getTime() + HOUR)] }), { allowed: true });
  // Weekly review: Sunday window only, and only after a week without publication.
  const sunday = at("2026-01-18T03:00:00Z");
  const weekly = { ...base, lane: "weekly" as const, now: sunday };
  assert.equal((publicationGate({ ...weekly, now: night }) as { reason: string }).reason, "not-weekly-window");
  assert.equal((publicationGate({ ...weekly, publishedAt: [new Date(sunday.getTime() - 6 * DAY)] }) as { reason: string }).reason, "recent-publication");
  assert.deepEqual(publicationGate({ ...weekly, publishedAt: [new Date(sunday.getTime() - 8 * DAY)] }), { allowed: true });
  assert.deepEqual(publicationGate(weekly), { allowed: true });
});

test("schedule: planned jobs per agent and night, idempotent keys", () => {
  const agent = { id: randomUUID(), active: true, watch: { valid: true, policy: enabled } };
  const friday = at("2026-01-15T12:00:00Z");
  const [job, ...rest] = planAgentJobs(agent, friday);
  assert.equal(rest.length, 0);
  assert.equal(job.key, `publication-window:${agent.id}:2026-01-16`);
  assert.deepEqual(job.payload, { agentId: agent.id, date: "2026-01-16" });
  assert.equal(job.runAfter.getTime(), agentSlot(agent.id, nightWindow(friday)).getTime());
  const saturday = planAgentJobs(agent, at("2026-01-17T12:00:00Z"));
  assert.deepEqual(saturday.map(j => j.kind), ["publication-window", "weekly-review"]);
  assert.equal(saturday[1].runAfter.getTime() - saturday[0].runAfter.getTime(), 10 * MIN);
  for (const off of [{ ...agent, active: false }, { ...agent, watch: { valid: false, policy: enabled } }, { ...agent, watch: { valid: true, policy: DEFAULT_WATCH_POLICY } }, { ...agent, watch: { valid: true, policy: { ...enabled, paused: true } } }]) {
    assert.deepEqual(planAgentJobs(off, friday), []);
  }
});

test("queue: idempotent enqueue, due claims, fenced leases, retries, waits and purge", async t => {
  const db = new Database(":memory:"); t.after(() => db.close());
  let clock = 1_000_000;
  const queue = createJobQueue(db, () => clock);
  const first = queue.enqueue({ kind: "k", key: "k:1", payload: { a: 1 }, runAfter: clock + 10, maxAttempts: 2 });
  assert.equal(first.created, true);
  assert.equal(queue.enqueue({ kind: "k", key: "k:1", payload: { a: 2 } }).created, false);
  assert.deepEqual(queue.get("k:1")!.payload, { a: 1 });
  assert.throws(() => queue.enqueue({ kind: "other", key: "k:1", payload: null }), /another kind/);
  assert.equal(queue.claim(["k"], 1000), null, "not due yet");
  assert.equal(queue.claim([], 1000), null);
  clock += 10;
  assert.equal(queue.claim(["unrelated"], 1000), null, "kinds filter");
  const job = queue.claim(["k"], 1000)!;
  assert.equal(job.state, "running"); assert.equal(job.attempts, 1);
  assert.equal(queue.claim(["k"], 1000), null, "leased");
  assert.equal(queue.heartbeat(job, 1000), true);
  // Expired lease: another worker takes over, the stale holder can no longer finish.
  clock += 1001;
  const second = queue.claim(["k"], 1000)!;
  assert.equal(second.id, job.id); assert.equal(second.attempts, 2); assert.notEqual(second.leaseToken, job.leaseToken);
  for (const stale of [() => queue.complete(job), () => queue.fail(job, new Error("x")), () => queue.wait(job, clock, "x"), () => queue.heartbeat(job, 1000)]) assert.equal(stale(), false);
  // Waiting does not consume an attempt.
  assert.equal(queue.wait(second, clock + 500, "Inférence indisponible"), true);
  const waiting = queue.get("k:1")!;
  assert.deepEqual([waiting.state, waiting.attempts, waiting.runAfter, waiting.lastError], ["pending", 1, clock + 500, "Inférence indisponible"]);
  clock += 500;
  const third = queue.claim(["k"], 1000)!;
  assert.equal(third.attempts, 2);
  // Last attempt failed: final state, with the error kept for diagnostics.
  assert.equal(queue.fail(third, new TypeError("boom")), true);
  assert.deepEqual([queue.get("k:1")!.state, queue.get("k:1")!.lastError], ["failed", "TypeError: boom"]);
  // Backoff before the last attempt.
  queue.enqueue({ kind: "k", key: "k:2", payload: null, maxAttempts: 3 });
  const retry = queue.claim(["k"], 1000)!;
  queue.fail(retry, new Error("transient"));
  assert.deepEqual([queue.get("k:2")!.state, queue.get("k:2")!.runAfter], ["pending", clock + retryDelay(1)]);
  assert.equal(retryDelay(2), 2 * MIN); assert.equal(retryDelay(20), 6 * HOUR);
  // A crashed holder on its last attempt does not loop forever.
  queue.enqueue({ kind: "k", key: "k:3", payload: null, maxAttempts: 1 });
  clock += retryDelay(1);
  const claimedThird = [queue.claim(["k"], 1000)!, queue.claim(["k"], 1000)!].map(j => j.key).sort();
  assert.deepEqual(claimedThird, ["k:2", "k:3"]);
  clock += 1001;
  assert.equal(queue.claim(["k"], 1000)!.key, "k:2", "k:2 reclaimed, k:3 failed");
  assert.equal(queue.get("k:3")!.state, "failed");
  // Done job keeps its result; purge removes finished jobs after retention.
  queue.enqueue({ kind: "k", key: "k:4", payload: null });
  const done = queue.claim(["k"], 1000)!;
  assert.equal(done.key, "k:4");
  assert.equal(queue.complete(done, { outcome: "ok" }), true);
  assert.deepEqual(queue.get("k:4")!.result, { outcome: "ok" });
  assert.deepEqual(queue.counts(), { done: 1, failed: 2, running: 1 });
  clock += DAY;
  assert.equal(queue.purge(HOUR), 3);
  assert.equal(queue.enqueue({ kind: "k", key: "k:4", payload: null }).created, true);
});

test("queue: concurrent worker processes claim each job exactly once", { timeout: 60_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "xi-watch-queue-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "queue.sqlite");
  const db = new Database(path); db.pragma("journal_mode = WAL");
  const queue = createJobQueue(db);
  const keys = Array.from({ length: 200 }, (_, i) => `race:${i}`);
  for (const key of keys) queue.enqueue({ kind: "race", key, payload: null });
  db.close();
  const claimed = (await Promise.all(Array.from({ length: 4 }, () => child("claim", path)))).flat();
  assert.equal(claimed.length, keys.length, "no job claimed twice");
  assert.deepEqual([...new Set(claimed)].sort(), [...keys].sort());
});

test("drain: handler outcomes, lease renewal while running, unknown kinds left alone", { timeout: 30_000 }, async t => {
  const db = new Database(":memory:"); t.after(() => db.close());
  const queue = createJobQueue(db);
  for (const key of ["ok", "wait", "throw", "slow"]) queue.enqueue({ kind: key, key, payload: null, maxAttempts: 2 });
  queue.enqueue({ kind: "nobody", key: "nobody", payload: null });
  const summary = await drainJobs({ queue, leaseMs: 1500, handlers: {
    ok: async () => ({ status: "done", result: 42 }),
    wait: async () => ({ status: "wait", until: new Date(Date.now() + HOUR), reason: "Inférence indisponible" }),
    throw: async () => { throw new Error("transient"); },
    slow: async () => {
      // Longer than the lease: renewal keeps other claimers away.
      await new Promise(resolve => setTimeout(resolve, 1200));
      assert.equal(queue.claim(["slow"], 1500), null);
      await new Promise(resolve => setTimeout(resolve, 1200));
      assert.equal(queue.claim(["slow"], 1500), null);
      return { status: "done" };
    },
  } });
  assert.deepEqual(summary, { done: 2, waiting: 1, retried: 1, failed: 0, lost: 0 });
  assert.deepEqual(queue.get("ok")!.result, 42);
  assert.equal(queue.get("wait")!.attempts, 0);
  assert.equal(queue.get("nobody")!.state, "pending");
  assert.deepEqual(await drainJobs({ queue, handlers: {} }), { done: 0, waiting: 0, retried: 0, failed: 0, lost: 0 });
});

test("watch policy: owner-only, revisioned, preserved by the configuration form, invalid fails closed", async t => {
  const { accounts, agentId, root } = await fixture(t);
  assert.deepEqual(await accounts.watchPolicy("alice", agentId), { policy: DEFAULT_WATCH_POLICY, revision: null, valid: true, publicConfirmedAt: null });
  await assert.rejects(accounts.watchPolicy("bob", agentId), /introuvable/);
  await assert.rejects(accounts.setWatchPolicy("bob", agentId, { revision: null, policy: enabled }), /introuvable/);
  for (const policy of [{ ...enabled, maxPerDay: 0 }, { ...enabled, minIntervalMinutes: 5 }, { ...enabled, extra: true }, { enabled: true }]) {
    await assert.rejects(accounts.setWatchPolicy("alice", agentId, { revision: null, policy }));
  }
  const saved = await accounts.setWatchPolicy("alice", agentId, { revision: null, policy: { ...enabled, maxPerDay: 5 } });
  await assert.rejects(accounts.setWatchPolicy("alice", agentId, { revision: null, policy: enabled }), /modifiée/);
  assert.deepEqual(await accounts.watchPolicy("alice", agentId), saved);
  // Editing the agent through the configuration form keeps the watch policy.
  const account = await accounts.getOwned("alice", agentId);
  const { editorial } = account;
  await accounts.update("alice", agentId, editorial!.revision, { handle: account.handle, name: "Nouveau nom", description: account.description, primaryTopicId: editorial!.primaryTopicId, secondaryTopicIds: editorial!.secondaryTopicIds, presetId: editorial!.presetId, presetVersion: editorial!.presetVersion, settings: editorial!.settings, active: editorial!.active, modelRef: editorial!.modelRef, validationMode: editorial!.validationMode });
  assert.deepEqual(await accounts.watchPolicy("alice", agentId), saved);
  const [agent] = await accounts.watchAgents();
  assert.deepEqual([agent.id, agent.owner, agent.active, agent.watch], [agentId, "alice", true, saved]);
  // Paused: kept, not planned.
  const paused = await accounts.setWatchPolicy("alice", agentId, { revision: saved.revision, policy: { ...enabled, maxPerDay: 5, paused: true } });
  assert.deepEqual(planAgentJobs((await accounts.watchAgents())[0], new Date()), []);
  // A hand-edited, invalid policy disables the agent instead of breaking the catalogue.
  const file = join(root, "generators", agent.handle, "index.md");
  await writeFile(file, (await readFile(file, "utf8")).replace("maxPerDay: 5", "maxPerDay: -1"));
  assert.deepEqual((await accounts.watchAgents())[0].watch, { policy: DEFAULT_WATCH_POLICY, revision: null, valid: false, publicConfirmedAt: null });
  assert.equal((await accounts.list("alice")).length, 1);
  assert.notEqual(paused.revision, null);
  // The owner can overwrite the unreadable value.
  assert.equal((await accounts.setWatchPolicy("alice", agentId, { revision: null, policy: enabled })).valid, true);
});

test("generated publications: one writer across processes, no duplicate id or folder", { timeout: 60_000 }, async t => {
  const { root, agentId, topicId } = await fixture(t);
  const shared = randomUUID();
  const own = Array.from({ length: 3 }, () => Array.from({ length: 3 }, () => randomUUID()));
  const results = await Promise.all(own.map(ids => child("publish", root, "alice", agentId, topicId, shared, ...ids)));
  assert.ok(results.every(ids => ids[0] === shared));
  const folders = (await readdir(join(root, "posts", "_generators", agentId))).filter(name => !name.startsWith("."));
  assert.equal(folders.length, 10, "one folder per publication id");
  assert.equal(new Set(folders).size, folders.length);
  const indexes = await Promise.all(folders.map(folder => readFile(join(root, "posts", "_generators", agentId, folder, "index.md"), "utf8")));
  assert.equal(indexes.filter(text => text.includes(`id: ${shared}`)).length, 1);
  // The lock lives outside the watched publication tree.
  assert.ok((await readdir(join(root, ".xi-locks"))).includes(".writer-lock.sqlite"));
  assert.ok(!(await readdir(join(root, "posts", "_generators"))).some(name => name.includes("lock")));
});

test("tick: plans windows, runs due jobs with the gate, pause and missed windows, never publishes", async t => {
  const { db, accounts, publications, sources, agentId } = await fixture(t);
  let clock = at("2026-01-15T12:00:00Z");
  const now = () => clock;
  let autoPublish = false;
  const run = () => tick({ db, accounts, now, handlers: windowHandlers({ db, accounts, sources, publications, settings: { autoPublish, allowPublic: false }, now: () => clock.getTime() }) });
  const noJobs = { done: 0, waiting: 0, retried: 0, failed: 0, lost: 0, purged: 0, purgedItems: 0 };
  assert.deepEqual(await run(), { planned: 0, ...noJobs, queue: {} }, "disabled by default");
  const saved = await accounts.setWatchPolicy("alice", agentId, { revision: null, policy: enabled });
  assert.deepEqual(await run(), { planned: 1, ...noJobs, queue: { pending: 1 } });
  assert.deepEqual(await run(), { planned: 0, ...noJobs, queue: { pending: 1 } }, "idempotent planning");
  const queue = createJobQueue(db, () => clock.getTime());
  // Window results carry the measured index reconciliation time.
  const outcome = (key: string) => {
    const { indexMs, ...rest } = queue.get(key)!.result as { indexMs?: number };
    if (key.startsWith("publication-window")) assert.ok(Number.isInteger(indexMs) && indexMs! >= 0);
    return rest;
  };
  const key = `publication-window:${agentId}:2026-01-16`;
  clock = new Date(queue.get(key)!.runAfter);
  assert.deepEqual(await run(), { planned: 0, ...noJobs, done: 1, queue: { done: 1 } });
  assert.deepEqual(outcome(key), { outcome: "skipped", reason: "Publication automatique désactivée par l’opérateur (XI_WATCH_AUTOPUBLISH)." });
  // Next night, operator flag on but the agent's autonomous mode off, then on: nothing drafted to publish.
  autoPublish = true;
  clock = new Date(clock.getTime() + 10 * MIN);
  await run();
  const agentOff = await accounts.watchPolicy("alice", agentId);
  assert.equal(agentOff.policy.autoPublish, false);
  const autonomous = await accounts.setWatchPolicy("alice", agentId, { revision: agentOff.revision, policy: { ...enabled, autoPublish: true } });
  clock = new Date(clock.getTime() + DAY - 5 * MIN);
  await run();
  const next = `publication-window:${agentId}:2026-01-17`;
  clock = new Date(queue.get(next)!.runAfter);
  await run();
  assert.deepEqual(outcome(next), { outcome: "no-candidates" });
  // Saturday → Sunday night also has a weekly review.
  clock = at("2026-01-17T12:00:00Z");
  assert.equal((await run()).planned, 2);
  // Paused after planning: the jobs run and skip.
  void saved;
  await accounts.setWatchPolicy("alice", agentId, { revision: autonomous.revision, policy: { ...enabled, autoPublish: true, paused: true } });
  clock = at("2026-01-18T04:50:00Z");
  await run();
  assert.deepEqual(outcome(`publication-window:${agentId}:2026-01-18`), { outcome: "skipped", reason: "Veille en pause." });
  assert.deepEqual(outcome(`weekly-review:${agentId}:2026-01-18`), { outcome: "skipped", reason: "not-running" });
  // Missed window (worker down): run once, skipped, not retried; a later window is unaffected.
  const resumed = await accounts.watchPolicy("alice", agentId);
  await accounts.setWatchPolicy("alice", agentId, { revision: resumed.revision, policy: { ...enabled, autoPublish: true } });
  clock = at("2026-01-18T12:00:00Z");
  await run();
  clock = at("2026-01-19T09:00:00Z");
  await run();
  assert.deepEqual(outcome(`publication-window:${agentId}:2026-01-19`), { outcome: "skipped", reason: "Hors de la fenêtre 3 h–6 h." });
  assert.equal(queue.get(`publication-window:${agentId}:2026-01-20`)!.state, "pending");
  assert.equal((db.prepare("SELECT count(*) AS n FROM publication").get() as { n: number }).n, 0, "no publication written");
});
