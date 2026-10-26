import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import Database from "better-sqlite3";
import { z } from "zod";
import { createAccountStore } from "../src/lib/accounts/store";
import { BUILTIN_PRESETS, DEFAULT_WATCH_POLICY, type WatchAgent } from "../src/lib/accounts/types";
import { DEFAULT_BLOUB_CONFIG } from "../src/lib/bloub/config";
import { openVault } from "../src/lib/publications/vault";
import { createTopicStore } from "../src/lib/topics/store";
import { createJobQueue, PRIORITY } from "../src/lib/watch/jobs";
import { activeGrants, admit, catchUp, getRun, grant, listRuns, missedWatch, purgeRuns, startRun, finishRun } from "../src/lib/watch/orchestrator";
import { drainJobs } from "../src/lib/watch/worker";
import { createSourceStore } from "../src/lib/watch/sources";
import { control } from "../src/lib/xiagents/control";
import { defaultSchedule, type Schedule } from "../src/lib/xiagents/schedule";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const at = (iso: string) => Date.parse(iso);

function agent(overrides: Partial<Schedule> = {}, extra: Partial<WatchAgent> = {}): WatchAgent {
  return {
    id: extra.id ?? randomUUID(), handle: "a", owner: "alice", active: true, primaryTopicId: "t", secondaryTopicIds: [], modelRef: null,
    watch: { policy: { ...DEFAULT_WATCH_POLICY, enabled: true }, revision: "r", valid: true, publicConfirmedAt: null },
    // Paris, watch 07:00–23:00 every day, 30 min grace, 72 h catch-up.
    schedule: { ...defaultSchedule("Europe/Paris"), ...overrides, explicit: true, valid: true, revision: "s" },
    pause: null, profile: null, createdAt: "2020-01-01T00:00:00.000Z", ...extra,
  };
}
const job = (kind: string, payload: Record<string, unknown> = {}) => ({ kind, payload });

test("queue: major events first, manual next, aging prevents starvation", () => {
  const db = new Database(":memory:");
  let clock = at("2026-03-02T10:00:00Z");
  const queue = createJobQueue(db, () => clock);
  queue.enqueue({ kind: "evaluate-story", key: "ordinary", payload: null });
  queue.enqueue({ kind: "evaluate-story", key: "manual", payload: null, priority: PRIORITY.manual });
  queue.enqueue({ kind: "evaluate-story", key: "major", payload: null, priority: PRIORITY.major });
  assert.deepEqual([0, 1, 2].map(() => queue.claim(["evaluate-story"], 60_000)!.key), ["major", "manual", "ordinary"]);
  // An ordinary job waiting for 2 h outranks a fresh major event: never starved.
  queue.enqueue({ kind: "evaluate-story", key: "old", payload: null, runAfter: clock - 2 * HOUR });
  queue.enqueue({ kind: "evaluate-story", key: "fresh-major", payload: null, priority: PRIORITY.major });
  assert.equal(queue.claim(["evaluate-story"], 60_000)!.key, "old");
  // Re-planning a pending ordinary job as a major event raises it.
  queue.enqueue({ kind: "evaluate-story", key: "raised", payload: null });
  queue.enqueue({ kind: "evaluate-story", key: "raised", payload: null, priority: PRIORITY.major });
  assert.equal(queue.get("raised")!.priority, PRIORITY.major);
  clock += 1;
  db.close();
});

test("queue: a mass re-evaluation never holds back drafting; major events, aging and the inference limit still apply", () => {
  const db = new Database(":memory:");
  let clock = at("2026-03-02T10:00:00Z");
  const queue = createJobQueue(db, () => clock);
  const limits = [{ kinds: ["evaluate-story", "draft-candidate"], max: 1 }];
  const kinds = ["evaluate-story", "draft-candidate", "collect-source"];
  // A backlog of 10 re-evaluations (a bulk relaunch: ordinary priority) queued 30 min before an accepted candidate's draft.
  for (let i = 0; i < 10; i++) queue.enqueue({ kind: "evaluate-story", key: `bulk-${i}`, payload: null, runAfter: clock - 30 * 60_000 });
  queue.enqueue({ kind: "draft-candidate", key: "draft", payload: null });
  // One evaluation is already running: never interrupted, and no second model job beside it.
  const running = queue.claim(["evaluate-story"], 60_000, limits)!;
  assert.equal(running.kind, "evaluate-story");
  assert.equal(queue.claim(kinds, 60_000, limits), null, "the inference limit holds: the draft waits, nothing is preempted");
  queue.complete(running);
  assert.equal(queue.claim(kinds, 60_000, limits)!.key, "draft", "next model slot: the draft, before the backlog");
  // A fresh major event still passes before an ordinary draft.
  db.exec("UPDATE watch_job SET state = 'done' WHERE state = 'running'");
  queue.enqueue({ kind: "draft-candidate", key: "draft-2", payload: null });
  queue.enqueue({ kind: "evaluate-story", key: "major", payload: null, priority: PRIORITY.major });
  assert.equal(queue.claim(kinds, 60_000)!.key, "major");
  // Anti-starvation: evaluations waiting well over an hour longer than a draft pass first.
  queue.enqueue({ kind: "evaluate-story", key: "starving", payload: null, runAfter: clock - 2 * HOUR });
  assert.equal(queue.claim(kinds, 60_000)!.key, "starving");
  assert.equal(queue.claim(kinds, 60_000)!.key, "draft-2");
  clock += 1;
  db.close();
});

test("queue: the inference limit is shared by every claimer; other kinds still run", () => {
  const db = new Database(":memory:");
  const queue = createJobQueue(db, () => at("2026-03-02T10:00:00Z"));
  const limits = [{ kinds: ["evaluate-story", "draft-candidate"], max: 1 }];
  for (const key of ["e1", "e2"]) queue.enqueue({ kind: "evaluate-story", key, payload: null });
  queue.enqueue({ kind: "collect-source", key: "c1", payload: null });
  const kinds = ["evaluate-story", "draft-candidate", "collect-source"];
  assert.equal(queue.claim(kinds, 60_000, limits)!.kind, "evaluate-story");
  assert.equal(queue.claim(kinds, 60_000, limits)!.key, "c1", "the second model job waits for the first");
  assert.equal(queue.claim(kinds, 60_000, limits), null);
  db.close();
});

test("admission: calendars, grace deadline, grants, manual runs, major events, pause", () => {
  const noGrants = new Map();
  const running = agent();
  // 12:00 Paris (CET, +1): open until 23:00 local = 22:00Z, plus 30 min grace.
  const noon = at("2026-03-02T11:00:00Z");
  assert.deepEqual(admit(job("evaluate-story"), running, noGrants, noon), { allowed: true, deadline: at("2026-03-02T22:30:00Z"), trigger: "calendar" });
  // 03:00 Paris: closed until 07:00 local.
  const night = at("2026-03-03T02:00:00Z");
  const closed = admit(job("evaluate-story"), running, noGrants, night);
  assert.equal(closed.allowed, false);
  assert.equal(!closed.allowed && closed.until, at("2026-03-03T06:00:00Z"));
  // Collection and publication kinds are not gated here (collection is planned per calendar; publication checks its own).
  assert.equal(admit(job("collect-source"), running, noGrants, night).allowed, true);
  assert.equal(admit(job("publication-window"), running, noGrants, night).allowed, true);
  // A manual command and a catch-up grant both open the watch.
  assert.equal(admit(job("evaluate-story", { trigger: "manual" }), running, noGrants, night).allowed, true);
  const grants = new Map([[running.id, { id: "g", agentId: running.id, kind: "catch-up" as const, from: night - HOUR, until: night + HOUR, reason: "" }]]);
  assert.deepEqual(admit(job("evaluate-story"), running, grants, night), { allowed: true, deadline: night + HOUR + 30 * 60_000, trigger: "catch-up" });
  // Major event: only with the exception enabled.
  assert.equal(admit(job("evaluate-story", { trigger: "major-event" }), running, noGrants, night).allowed, false);
  const exceptional = agent({ majorEvents: { enabled: true } });
  assert.equal(admit(job("evaluate-story", { trigger: "major-event" }), exceptional, noGrants, night).allowed, true);
  // An explicit pause blocks everything, exceptions and publications included, until its end.
  const paused = agent({ majorEvents: { enabled: true } }, { watch: { ...running.watch, policy: { ...running.watch.policy, paused: true } }, pause: { since: "2026-03-01T00:00:00Z", resumeAt: "2026-03-05T08:00:00Z", resumeWith: "now" } });
  for (const kind of ["evaluate-story", "publication-window", "collect-source"]) {
    const result = admit(job(kind, { trigger: "major-event" }), paused, grants, noon);
    assert.equal(result.allowed, false);
    assert.equal(!result.allowed && result.until, at("2026-03-05T08:00:00Z"));
  }
});

test("drain: end of window interrupts cleanly; permanent errors are final; transient ones retried", async () => {
  const db = new Database(":memory:");
  const queue = createJobQueue(db);
  const owner = async () => "alice";
  queue.enqueue({ kind: "evaluate-story", key: "slow", payload: { agentId: "a1" } });
  const summary = await drainJobs({
    queue, handlers: { "evaluate-story": () => new Promise(() => {}) },
    control: { db, owner, admit: async () => ({ allowed: true, deadline: Date.now() + 50, trigger: "calendar" }) },
  });
  assert.equal(summary.interrupted, 1);
  const slow = queue.get("slow")!;
  assert.equal(slow.state, "pending"); assert.equal(slow.attempts, 0, "no attempt consumed");
  assert.equal(listRuns(db, "alice")[0].status, "interrupted");

  queue.enqueue({ kind: "draft-candidate", key: "invalid", payload: { agentId: "a1" } });
  queue.enqueue({ kind: "discover-sources", key: "flaky", payload: { agentId: "a1" } });
  const result = await drainJobs({
    queue,
    handlers: { "draft-candidate": async () => { z.object({ x: z.string() }).parse({}); return { status: "done" }; }, "discover-sources": async () => { throw new Error("ECONNRESET"); } },
    control: { db, owner, admit: async () => ({ allowed: true, deadline: null, trigger: "calendar" }) },
  });
  assert.equal(result.failed, 1); assert.equal(result.retried, 1);
  assert.equal(queue.get("invalid")!.state, "failed"); assert.equal(queue.get("invalid")!.attempts, 1, "a permanent error is never retried");
  assert.equal(queue.get("flaky")!.state, "pending");
  const runs = listRuns(db, "alice");
  assert.match(runs.find(run => run.kind === "draft-candidate")!.logs.at(-1)!.message, /erreur permanente/);
  assert.equal(runs.find(run => run.kind === "discover-sources")!.status, "retrying");
  // Owner isolation of the history.
  assert.deepEqual(listRuns(db, "bob"), []);
  assert.equal(getRun(db, "bob", runs[0].id), null);
  db.close();
});

test("catch-up: bounded by the agent limit and creation, idempotent, isolated per agent", () => {
  const db = new Database(":memory:");
  const now = at("2026-03-06T12:00:00Z");
  const a = agent();
  // Worker down for 4 days: only the last 72 h count, and only watch hours (16 h/day).
  const missed = missedWatch(a, now - 4 * DAY, now)!;
  assert.equal(missed.limited, true);
  assert.ok(missed.missedMs <= 72 * HOUR && missed.missedMs >= 3 * 15 * HOUR, String(missed.missedMs / HOUR));
  const first = catchUp(db, a, now - 4 * DAY, now, "Test.")!;
  assert.ok(first.until - now <= 6 * HOUR);
  assert.equal(catchUp(db, a, now - 4 * DAY, now, "Test."), null, "no duplicate catch-up");
  assert.equal(listRuns(db, "alice").filter(run => run.trigger === "catch-up").length, 1);
  // Disabled, or the agent did not exist yet.
  assert.equal(missedWatch(agent({ catchUpHours: 0 }), now - DAY, now), null);
  assert.equal(missedWatch(agent({}, { createdAt: new Date(now - 10 * 60_000).toISOString() }), now - DAY, now)!.missedMs, 10 * 60_000);
  // Closed calendar during the gap: nothing to catch up.
  assert.equal(missedWatch(a, at("2026-03-06T00:00:00Z"), at("2026-03-06T04:00:00Z")), null);
  // Grants belong to one agent.
  const other = agent();
  assert.ok(activeGrants(db, now).has(a.id));
  assert.ok(!activeGrants(db, now).has(other.id));
  db.close();
});

test("retention: agent setting wins over the global one; running rows are kept", () => {
  const db = new Database(":memory:");
  const now = at("2026-03-30T00:00:00Z");
  const short = agent({ retentionDays: 5 });
  const regular = agent();
  const row = (id: string, agentId: string | null, daysAgo: number, done = true) => {
    startRun(db, { id, agentId, owner: "alice", kind: "evaluate-story", trigger: "calendar" }, now - daysAgo * DAY);
    if (done) finishRun(db, id, "done", now - daysAgo * DAY);
  };
  row("short-old", short.id, 10); row("short-new", short.id, 2);
  row("regular-mid", regular.id, 10); row("regular-old", regular.id, 40); row("owner-old", null, 40);
  row("running", short.id, 50, false);
  grant(db, { id: "g-old", agentId: short.id, owner: "alice", kind: "manual", from: now - 60 * DAY, until: now - 59 * DAY, reason: "" }, now - 60 * DAY);
  assert.equal(purgeRuns(db, [short, regular], now, 30), 4);
  assert.deepEqual(listRuns(db, "alice").map(run => run.id).sort(), ["regular-mid", "running", "short-new"]);
  db.close();
});

async function stores(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "xi-control-"));
  const vault = await openVault(root);
  const db = new Database(":memory:");
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  const topics = createTopicStore({ vault, db });
  const accounts = createAccountStore({ vault, db, topics });
  const sources = createSourceStore({ vault, topics });
  const topic = (await topics.create("alice", randomUUID(), { tag: "climat", name: "Climat", description: "", scope: "Climat", parentId: null, relatedIds: [] })).topic;
  const id = randomUUID();
  const preset = BUILTIN_PRESETS[0];
  await accounts.createAgent("alice", id, { draft: { handle: "climat", name: "Climat", description: "", primaryTopicId: topic.id, secondaryTopicIds: [], presetId: preset.id, presetVersion: preset.version, settings: preset.settings, active: true, modelRef: null, validationMode: "human" }, profile: { perimeter: "", charter: "" }, bloub: DEFAULT_BLOUB_CONFIG });
  return { db, accounts, sources, id };
}

test("control: pause until a date with recorded resume choice, resume with catch-up, manual run never changes the mode", async t => {
  const { db, accounts, sources, id } = await stores(t);
  // The store stamps agents with the real time: simulated dates follow it (nothing is missed before creation).
  const base = Date.now() + DAY;
  let clock = new Date(base);
  const deps = { db, accounts, sources, now: () => clock };
  // Not activated yet: manual runs are refused.
  await assert.rejects(control(deps, "alice", id, { action: "run", task: "watch" }), /Veille inactive/);
  const policy = await accounts.watchPolicy("alice", id);
  await accounts.setWatchPolicy("alice", id, { revision: policy.revision, policy: { ...policy.policy, enabled: true } });
  await accounts.setSchedule("alice", id, { revision: (await accounts.schedule("alice", id)).revision, schedule: defaultSchedule("Europe/Paris") });

  const run = await control(deps, "alice", id, { action: "run", task: "watch" });
  assert.equal(run.planned, 0, "no approved source: nothing is pretended");
  assert.ok(activeGrants(db, clock.getTime()).has(id));
  assert.equal((await accounts.watchPolicy("alice", id)).policy.enabled, true);

  await assert.rejects(control(deps, "bob", id, { action: "pause", resumeAt: null, resumeWith: "now" }), /introuvable/);
  await control(deps, "alice", id, { action: "pause", resumeAt: new Date(base + 2 * DAY).toISOString(), resumeWith: "catch-up" });
  assert.equal((await accounts.pauseState("alice", id))!.resumeWith, "catch-up");
  await assert.rejects(control(deps, "alice", id, { action: "run", task: "watch" }), /en pause/);
  // Scheduled resume is applied by the worker (resumeDue), returning the recorded choice.
  clock = new Date(base + 2 * DAY + HOUR);
  const due = await accounts.resumeDue(clock);
  assert.deepEqual(due.map(item => [item.agentId, item.pause.resumeWith]), [[id, "catch-up"]]);
  assert.equal((await accounts.watchPolicy("alice", id)).policy.paused, false);
  // Manual resume (from a new pause) with catch-up grants the missed watch time.
  await control(deps, "alice", id, { action: "pause", resumeAt: null, resumeWith: "now" });
  clock = new Date(base + 4 * DAY);
  const resumed = await control(deps, "alice", id, { action: "resume", resumeWith: "catch-up" });
  assert.ok(resumed.catchUp, "missed watch hours are caught up");
  await assert.rejects(control(deps, "alice", id, { action: "resume", resumeWith: "now" }), /pas en pause/);
  assert.deepEqual(listRuns(db, "alice", { agentId: id }).map(row => row.kind).filter(kind => !kind.startsWith("catch")).sort(), ["manual-watch", "pause", "pause", "resume"]);
});
