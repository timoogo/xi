import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import Database from "better-sqlite3";
import { createAccountStore } from "../src/lib/accounts/store";
import { openVault } from "../src/lib/publications/vault";
import { instanceOwner } from "../src/lib/system-agents/owner";
import { SYSTEM_AGENTS } from "../src/lib/system-agents/registry";
import { createSystemAgentStore } from "../src/lib/system-agents/store";
import { createSystemTasks, MAX_OPEN_REQUESTS, systemTaskHandler } from "../src/lib/system-agents/tasks";
import { createTopicStore } from "../src/lib/topics/store";
import { InferenceUnavailableError, type ChatRequest } from "../src/lib/watch/inference";
import { createJobQueue, PRIORITY } from "../src/lib/watch/jobs";
import type { LLMBinding } from "../src/lib/watch/llm-binding";
import { drainLimits, listRuns, SYSTEM_TASK_KIND } from "../src/lib/watch/orchestrator";
import { drainJobs, tick } from "../src/lib/watch/worker";
import { busyAgents } from "../src/lib/xiagents/avatar";

const konstruktor = SYSTEM_AGENTS.find(agent => agent.kind === "konstruktor")!;
const probe = () => ({ requestId: randomUUID(), task: "probe-model" });

async function setup(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "xi-system-tasks-"));
  const vault = await openVault(root);
  const path = join(root, "app.sqlite");
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  const store = createSystemAgentStore({ vault, db });
  await store.list();
  const topics = createTopicStore({ vault, db });
  const accounts = createAccountStore({ vault, db, topics });
  const services = { db, accounts, topics };
  const clock = { at: Date.now() };
  const now = () => clock.at;
  const running: { close(): Promise<void> }[] = [];
  const tasks = (llm: (owner: string) => LLMBinding, options: { autorun?: boolean } = {}) => {
    const service = createSystemTasks({ db, store, llm, services, now, ...options });
    running.push(service);
    return service;
  };
  t.after(async () => { await Promise.all(running.map(service => service.close())); db.close(); await rm(root, { recursive: true, force: true }); });
  return { root, vault, path, db, store, clock, now, tasks, services, accounts };
}

/** A local model double: `answer` decides each completion; `calls` records the requesters' models. */
function model(answer: (request: ChatRequest) => Promise<string> = async () => "OK") {
  const calls: string[] = [];
  const llm = (owner: string): LLMBinding => ({
    ok: true,
    inference: { complete: async request => { calls.push(owner); return answer(request); } },
    resolved: { model: `modele-${owner}`, instance: { name: "Ollama local" }, instanceSource: "global", modelSource: "global" } as never,
  });
  return { llm, calls };
}

test("system tasks: run at once after admission, Bloub working meanwhile, result persisted for the requester", { timeout: 20_000 }, async t => {
  const { db, now, tasks } = await setup(t);
  let release!: () => void;
  const started = Promise.withResolvers<void>();
  const { llm, calls } = model(async () => { started.resolve(); await new Promise<void>(resolve => { release = resolve; }); return " OK \n"; });
  const service = tasks(llm);
  const input = probe();
  const before = performance.now();
  const { request, created } = await service.request("alice", "konstruktor", input);
  assert.ok(created);
  assert.equal(request.state, "pending");
  // No worker pass: the request itself starts the task.
  await started.promise;
  assert.ok(performance.now() - before < 2_000, "started within the request's own drain");
  assert.ok(busyAgents(db, [konstruktor.id], now()).has(konstruktor.id), "Bloub working while the lease is held");
  assert.equal(service.get("alice", "konstruktor", input.requestId).state, "running");
  release();
  await service.close();
  assert.equal(busyAgents(db, [konstruktor.id], now()).size, 0, "idle again once done");
  const done = service.get("alice", "konstruktor", input.requestId);
  assert.equal(done.state, "done");
  assert.deepEqual(done.result, { model: "modele-alice sur Ollama local (configuration globale)", latencyMs: 0, reply: "OK" });
  assert.deepEqual(done.runs.map(run => [run.status, run.attempt]), [["done", 1]]);
  assert.deepEqual(calls, ["alice"], "the requester's own model configuration");
  assert.equal(listRuns(db, "alice", { agentId: konstruktor.id })[0].trigger, "manual");
});

test("system tasks: idempotent requests, one execution across concurrent drains, at most one system task at once", { timeout: 20_000 }, async t => {
  const { path, db, store, now, tasks, services } = await setup(t);
  const service = tasks(model().llm, { autorun: false });
  const first = probe();
  const created = await service.request("alice", "konstruktor", first);
  const again = await service.request("alice", "konstruktor", first);
  assert.ok(created.created && !again.created);
  assert.equal(db.prepare("SELECT count(*) AS n FROM watch_job WHERE kind = ?").pluck().get(SYSTEM_TASK_KIND), 1);
  for (let i = 0; i < 3; i++) await service.request("alice", i % 2 ? "konstruktor" : "priority-arbiter", probe());

  // Two "processes" (connections) drain the same queue: each task runs once, never two at once.
  let running = 0, peak = 0;
  const { llm, calls } = model(async () => { running++; peak = Math.max(peak, running); await new Promise(resolve => setTimeout(resolve, 30)); running--; return "OK"; });
  const other = new Database(path); t.after(() => other.close());
  other.pragma("busy_timeout = 5000");
  const handler = systemTaskHandler({ store, llm, services, now });
  const drains = await Promise.all([db, other].map(connection => drainJobs({ queue: createJobQueue(connection, now), handlers: { [SYSTEM_TASK_KIND]: handler }, concurrency: 2, limits: drainLimits(4), clock: now })));
  assert.equal(drains.reduce((total, drain) => total + drain.done, 0), 4);
  assert.equal(calls.length, 4, "each task executed exactly once");
  assert.equal(peak, 1, "SYSTEM_CONCURRENCY holds across connections, even with free inference slots");
  assert.ok(service.list("alice", "konstruktor").every(view => view.state === "done" && view.attempts === 1));
});

test("system tasks: a crashed holder's task resumes after its lease expires, through the web runner or a worker pass", { timeout: 20_000 }, async t => {
  const { db, store, clock, now, tasks, services, accounts } = await setup(t);
  const { llm, calls } = model();
  const service = tasks(llm);
  const queued = tasks(llm, { autorun: false });
  for (const resume of ["runner", "worker"] as const) {
    const input = probe();
    await queued.request("alice", "konstruktor", input);
    // A worker claims it, then dies without finishing.
    const crashed = createJobQueue(db, now);
    const lease = crashed.claim([SYSTEM_TASK_KIND], 60_000)!;
    assert.ok(lease);
    await service.kick();
    assert.equal(queued.get("alice", "konstruktor", input.requestId).state, "running", "a live lease is never taken over");
    clock.at += 61_000;
    if (resume === "runner") await service.kick();
    else {
      const summary = await tick({ db, accounts, handlers: { [SYSTEM_TASK_KIND]: systemTaskHandler({ store, llm, services, now }) }, now: () => new Date(now()) });
      assert.equal(summary.done, 1);
    }
    const view = queued.get("alice", "konstruktor", input.requestId);
    assert.equal(view.state, "done", resume);
    assert.equal(view.attempts, 2);
    assert.equal(crashed.complete(lease, "late"), false, "the crashed holder can no longer finish it (fencing)");
    assert.equal((view.result as { reply: string }).reply, "OK");
  }
  assert.equal(calls.length, 2);
});

test("system tasks: unavailable model waits without using attempts; missing configuration and disabled agent fail visibly", { timeout: 20_000 }, async t => {
  const { db, store, clock, now, tasks } = await setup(t);
  let up = false;
  const service = tasks(model(async () => { if (!up) throw new InferenceUnavailableError("Serveur de modèles injoignable.", now() + 5 * 60_000); return "OK"; }).llm);
  const input = probe();
  await service.request("alice", "konstruktor", input);
  await service.close();
  const waiting = service.get("alice", "konstruktor", input.requestId);
  assert.deepEqual([waiting.state, waiting.attempts, waiting.runAfter], ["pending", 0, now() + 5 * 60_000]);
  assert.match(waiting.message!, /injoignable/);
  assert.deepEqual(waiting.runs.map(run => run.status), ["waiting"]);
  up = true;
  clock.at += 5 * 60_000;
  await service.kick();
  assert.equal(service.get("alice", "konstruktor", input.requestId).state, "done");

  // No local model configured: no cloud fallback, a permanent failure the requester can read.
  const none = tasks(() => ({ ok: false, code: "not-configured", message: "Aucune instance IA : ajoutez une instance Ollama." }));
  const missing = probe();
  await none.request("bob", "konstruktor", missing);
  await none.close();
  const failed = none.get("bob", "konstruktor", missing.requestId);
  assert.deepEqual([failed.state, failed.attempts], ["failed", 1]);
  assert.match(failed.message!, /Aucune instance IA/);
  assert.equal(failed.runs[0].status, "failed");

  // A task queued before the agent was disabled is dropped when it starts; new requests are refused.
  db.exec(`CREATE TABLE IF NOT EXISTS "user" (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, createdAt DATE NOT NULL)`);
  db.prepare(`INSERT INTO "user" VALUES ('alice', 'alice@example.test', '2026-01-01')`).run();
  instanceOwner(db);
  const queued = tasks(model().llm, { autorun: false });
  const late = probe();
  await queued.request("alice", "konstruktor", late);
  await store.configure("alice", "konstruktor", { revision: (await store.get("konstruktor")).revision, enabled: false });
  await service.kick();
  const dropped = queued.get("alice", "konstruktor", late.requestId);
  assert.deepEqual([dropped.state, dropped.attempts], ["failed", 1]);
  assert.match(dropped.message!, /désactivé/);
  await assert.rejects(queued.request("alice", "konstruktor", probe()), { status: 409 });
  assert.equal((await queued.request("alice", "konstruktor", late)).created, false, "the same request id still reads its task");
});

test("system tasks: requests and results are private to their requester; validation and open-request limit", { timeout: 20_000 }, async t => {
  const { db, tasks } = await setup(t);
  const service = tasks(model().llm, { autorun: false });
  const mine = probe();
  await service.request("alice", "konstruktor", mine);
  assert.throws(() => service.get("bob", "konstruktor", mine.requestId), { status: 404 });
  assert.throws(() => service.get("alice", "priority-arbiter", mine.requestId), { status: 404 }, "scoped to the agent");
  assert.throws(() => service.get("alice", "konstruktor", "pas-un-uuid"), { status: 404 });
  assert.throws(() => service.list("alice", "inconnu"), { status: 404 });
  assert.deepEqual(service.list("bob", "konstruktor"), []);
  assert.equal(service.list("alice", "konstruktor").length, 1);
  // Bob reusing Alice's request id creates his own task: ids never collide across users.
  assert.ok((await service.request("bob", "konstruktor", mine)).created);
  assert.equal(service.get("bob", "konstruktor", mine.requestId).runs.length, 0);
  assert.equal(listRuns(db, "bob").length, 0);

  await assert.rejects(service.request("alice", "inconnu", probe()), { status: 404 });
  await assert.rejects(service.request("alice", "konstruktor", { ...probe(), task: "converse" }), { status: 400 });
  for (const invalid of [{ task: "probe-model" }, { ...probe(), input: { prompt: "x" } }, { ...probe(), extra: true }, { requestId: "x", task: "probe-model" }]) {
    await assert.rejects(service.request("alice", "konstruktor", invalid), { name: "ZodError" }, JSON.stringify(invalid));
  }
  for (let i = 1; i < MAX_OPEN_REQUESTS; i++) await service.request("alice", "priority-arbiter", probe());
  await assert.rejects(service.request("alice", "konstruktor", probe()), { status: 429 });
  assert.ok((await service.request("bob", "konstruktor", probe())).created, "the limit is per requester");
});

test("system tasks never starve editorial jobs: aging, the system share of inference, non-inference work unaffected", async t => {
  const { db, now, tasks } = await setup(t);
  const service = tasks(model().llm, { autorun: false });
  const queue = createJobQueue(db, now);
  queue.enqueue({ kind: "evaluate-story", key: "evaluate:old", payload: { agentId: "editorial" }, runAfter: now() - 40 * 60_000 });
  for (let i = 0; i < 3; i++) await service.request(`user-${i}`, "konstruktor", probe());
  const inference = ["evaluate-story", SYSTEM_TASK_KIND];
  // An editorial evaluation waiting 40 minutes ranks above fresh interactive requests.
  assert.equal(queue.claim(inference, 60_000, drainLimits(1))!.kind, "evaluate-story");
  assert.equal(queue.claim(inference, 60_000, drainLimits(1)), null, "one inference slot, taken");
  // With more slots, system tasks still take one at most: the rest stays for editorial work.
  queue.enqueue({ kind: "evaluate-story", key: "evaluate:new", payload: { agentId: "editorial" }, priority: PRIORITY.ordinary });
  assert.equal(queue.claim(inference, 60_000, drainLimits(3))!.kind, SYSTEM_TASK_KIND);
  assert.equal(queue.claim(inference, 60_000, drainLimits(3))!.key, "evaluate:new");
  assert.equal(queue.claim(inference, 60_000, drainLimits(4)), null, "a second system task waits for the first");
  queue.enqueue({ kind: "collect-source", key: "collect:a", payload: { sourceId: "a" } });
  assert.equal(queue.claim(["collect-source", ...inference], 60_000, drainLimits(1))!.kind, "collect-source", "collection never waits for the model");
});
