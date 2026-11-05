import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { DEFAULT_WATCH_POLICY, type WatchAgent } from "../src/lib/accounts/types";
import { migrateArbitrations } from "../src/lib/arbiter/arbitration";
import { createJobQueue } from "../src/lib/watch/jobs";
import { finishRun, startRun, type RunStatus } from "../src/lib/watch/orchestrator";
import { migrateWatchDecisions } from "../src/lib/watch/publisher";
import { syncEditorialQueue } from "../src/lib/watch/queue";
import { migrateWatchItems } from "../src/lib/watch/stories";
import { everyDay, type TimeRange } from "../src/lib/xiagents/calendar";
import { defaultSchedule } from "../src/lib/xiagents/schedule";
import { activityState, calendarDay, calendarMonth, diffusionContext, editorialQueue, parseSupervisionQuery, scopeAgents, supervision, supervisionHref } from "../src/lib/xiagents/supervision";
import { HOUR, MIN, world } from "./helpers/publish-world";

const h = (hour: number, minute = 0) => hour * 60 + minute;
function agent(id: string, owner: string, { topic = "t1", watch = [{ start: 0, end: 1440 }], publish = [{ start: h(3), end: h(6) }], timeZone = "Europe/Paris", paused = false }: { topic?: string; watch?: TimeRange[]; publish?: TimeRange[]; timeZone?: string; paused?: boolean } = {}): WatchAgent {
  return {
    id, handle: id, owner, active: true, primaryTopicId: topic, secondaryTopicIds: [], modelRef: null,
    watch: { policy: { ...DEFAULT_WATCH_POLICY, enabled: true, paused }, revision: null, valid: true, publicConfirmedAt: null },
    schedule: { ...defaultSchedule(timeZone), watch: everyDay(watch), publish: everyDay(publish), explicit: true, valid: true, revision: "r1" },
  };
}
async function database(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "xi-supervision-"));
  const db = new Database(join(root, "app.sqlite"));
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  migrateWatchItems(db); migrateWatchDecisions(db); migrateArbitrations(db);
  const queue = createJobQueue(db, () => 0);
  let n = 0;
  return {
    db,
    run(owner: string, agentId: string | null, kind: string, at: number, status: RunStatus, result: unknown = null, storyId?: string) {
      const id = `run-${++n}`;
      let jobId: string | undefined;
      if (storyId) { queue.enqueue({ kind, key: `job-${n}`, payload: { agentId, storyId } }); jobId = queue.get(`job-${n}`)!.id; }
      startRun(db, { id, jobId, agentId, owner, kind, trigger: "calendar", maxAttempts: 3, attempt: status === "retrying" ? 1 : 2 }, at);
      if (status !== "running") finishRun(db, id, status, at + MIN, { result, ...(status === "failed" ? { error: "Error: source injoignable" } : {}) });
      return id;
    },
    decision(owner: string, agentId: string, outcome: string, at: number, storyId: string | null = null) {
      db.prepare("INSERT INTO watch_decision VALUES (?, ?, ?, ?, NULL, 'night', ?, ?, 'private', ?)").run(`d-${++n}`, agentId, owner, storyId, outcome, `Décision ${outcome}.`, at);
    },
    story(owner: string, id: string, title: string, at: number) {
      db.prepare("INSERT INTO watch_story VALUES (?, ?, ?, ?, ?, NULL, 2, 2, 2, '[]', ?)").run(id, owner, title, at, at, at);
    },
  };
}
const JAN = (day: number, hour = 12) => Date.parse(`2026-01-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00Z`);

test("several agents aggregated per day, filtered by agent and Topic; another owner's agents never counted", async t => {
  const { db } = await database(t);
  const agents = [
    agent("a", "alice", { watch: [{ start: h(8), end: h(20) }], publish: [{ start: h(18), end: h(20) }] }),
    agent("b", "alice", { topic: "t2" }),
    agent("x", "bob", { topic: "t2" }),
  ];
  const owned = scopeAgents(agents, "alice", {});
  assert.deepEqual(owned.map(item => item.id), ["a", "b"]);
  const [day] = calendarMonth(db, "alice", owned, { month: "2026-01", timeZone: "Europe/Paris", now: JAN(1) });
  assert.deepEqual([day.watchHours, day.publishHours, day.watchAgents, day.publishAgents], [36, 5, 2, 2]);
  assert.deepEqual(scopeAgents(agents, "alice", { agent: "b" }).map(item => item.id), ["b"]);
  assert.deepEqual(scopeAgents(agents, "alice", { topic: "t2" }).map(item => item.id), ["b"]);
  assert.deepEqual(scopeAgents(agents, "alice", { agent: "x" }), [], "another owner's agent, even asked by id");
  const [onlyB] = calendarMonth(db, "alice", scopeAgents(agents, "alice", { topic: "t2" }), { month: "2026-01", timeZone: "Europe/Paris", now: JAN(1) });
  assert.deepEqual([onlyB.watchHours, onlyB.publishHours], [24, 3]);
});

test("ranges crossing midnight and agents in other time zones fall on the right local dates", async t => {
  const { db } = await database(t);
  const night = agent("n", "alice", { publish: [{ start: h(22), end: h(2) }] });
  const tokyo = agent("k", "alice", { timeZone: "Asia/Tokyo", watch: [{ start: h(9), end: h(10) }], publish: [] });
  const day = calendarDay(db, "alice", [night, tokyo], { date: "2026-01-15", timeZone: "Europe/Paris" });
  const local = (at: number) => new Date(at).toLocaleTimeString("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit" });
  assert.deepEqual(day.lanes[0].publish.map(span => [local(span.start), local(span.end)]), [["00:00", "02:00"], ["22:00", "00:00"]], "the end of the previous evening's range, then the new one");
  assert.deepEqual(day.lanes[1].watch.map(span => [local(span.start), local(span.end)]), [["01:00", "02:00"]], "09:00 in Tokyo is 01:00 in Paris");
  assert.equal(day.hours.length, 24);
  const month = calendarMonth(db, "alice", [night], { month: "2026-01", timeZone: "Europe/Paris", now: JAN(1) });
  assert.ok(month.every(item => item.publishHours === 4), "each date: the end of the previous evening's range (31 December's included) plus its own");
});

test("daylight-saving days: 23 and 25 hours, ranges followed on the wall clock", async t => {
  const { db } = await database(t);
  const early = agent("e", "alice", { watch: [{ start: h(1), end: h(4) }], publish: [{ start: h(22), end: h(2) }] });
  const spring = calendarDay(db, "alice", [early], { date: "2026-03-29", timeZone: "Europe/Paris" });
  const autumn = calendarDay(db, "alice", [early], { date: "2026-10-25", timeZone: "Europe/Paris" });
  assert.deepEqual([spring.hours.length, autumn.hours.length], [23, 25]);
  const span = (lane: typeof spring.lanes[0]) => lane.watch.reduce((total, item) => total + item.end - item.start, 0) / HOUR;
  assert.deepEqual([span(spring.lanes[0]), span(autumn.lanes[0])], [2, 4]);
  const march = calendarMonth(db, "alice", [early], { month: "2026-03", timeZone: "Europe/Paris", now: JAN(1) });
  assert.deepEqual([march[27].watchHours, march[28].watchHours, march[29].watchHours], [3, 2, 3]);
  // The range crossing midnight still splits across both dates on the change night.
  assert.deepEqual([march[27].publishHours, march[28].publishHours], [4, 4]);
});

test("forecast versus execution; nothing relevant is not an error; executions found by news with @arbitre", async t => {
  const w = await database(t);
  const a = agent("a", "alice"), b = agent("b", "alice");
  w.story("alice", "s1", "Le Premier ministre démissionne", JAN(10, 1));
  w.run("alice", "a", "collect-source", JAN(10, 1), "done", { outcome: "ok", new: 0, seen: 12 });
  w.run("alice", "a", "evaluate-story", JAN(10, 2), "done", { outcome: "rejected" });
  w.run("alice", "a", "draft-candidate", JAN(10, 3), "done", { outcome: "drafted" }, "s1");
  w.run("alice", "b", "collect-source", JAN(10, 4), "failed");
  w.run("alice", "b", "evaluate-story", JAN(10, 5), "retrying");
  w.run("alice", "b", "publish-alert", JAN(10, 6), "waiting", null, "s1");
  w.decision("alice", "a", "published", JAN(10, 3), "s1");
  w.db.prepare("INSERT INTO arbiter_request VALUES ('r1', 'alice', 'b', 's1', 2, NULL, 'Le Premier ministre démissionne', '{}', NULL, 'favorable', NULL, ?, NULL, ?, ?, ?)")
    .run(JSON.stringify({ priority: true, justification: "Conséquences immédiates.", criteria: [], model: "m", promptVersion: "arbitre-1.0", decidedAt: "2026-01-10T06:00:00Z" }), JAN(10, 7), JAN(10, 6), JAN(10, 6));
  const month = calendarMonth(w.db, "alice", [a, b], { month: "2026-01", timeZone: "Europe/Paris", now: JAN(15) });
  const past = month[9], future = month[20];
  assert.deepEqual([past.future, past.runs, past.errors, past.empty, past.published], [false, 6, 1, 2, 1]);
  assert.deepEqual([future.future, future.runs, future.watchHours > 0], [true, 0, true], "configured windows ahead, no execution invented");
  const day = calendarDay(w.db, "alice", [a, b], { date: "2026-01-10", timeZone: "Europe/Paris" });
  const states = Object.fromEntries(day.activity.filter(item => item.type === "run").map(item => [`${item.agentId}:${item.kind}`, item.state]));
  assert.deepEqual(states, { "a:collect-source": "empty", "a:evaluate-story": "empty", "a:draft-candidate": "done", "b:collect-source": "error", "b:evaluate-story": "retrying", "b:publish-alert": "waiting" });
  assert.equal(day.activity.find(item => item.state === "error")!.reason, "Error: source injoignable");
  assert.equal(activityState("interrupted", null), "error");
  assert.equal(activityState("done", { outcome: "no-candidates" }), "empty");
  // Everything about one news: its runs, its publication decision and @arbitre's decision.
  const story = supervision(w.db, "alice", [a, b], { view: "activity", story: "s1", from: "2026-01-01", to: "2026-01-31" }, JAN(15));
  assert.equal(story.view, "activity");
  if (story.view !== "activity") return;
  assert.deepEqual(story.items.map(item => item.type).sort(), ["arbitration", "decision", "run", "run"]);
  assert.match(story.items.find(item => item.type === "arbitration")!.reason!, /Prioritaire : oui\. Conséquences immédiates\./);
  const errors = supervision(w.db, "alice", [a, b], { view: "activity", state: "error", from: "2026-01-01", to: "2026-01-31" }, JAN(15));
  assert.ok(errors.view === "activity" && errors.items.length === 1 && errors.items[0].agentId === "b");
  const empties = supervision(w.db, "alice", [a, b], { view: "activity", state: "empty", agent: "a", from: "2026-01-01", to: "2026-01-31" }, JAN(15));
  assert.ok(empties.view === "activity" && empties.items.length === 2);
});

test("user isolation: another owner's runs, decisions, requests and queue rows are never shown", async t => {
  const w = await database(t);
  const a = agent("a", "alice"), x = agent("x", "bob");
  w.run("bob", "x", "collect-source", JAN(10), "failed");
  w.run("bob", "a", "collect-source", JAN(10), "failed"); // even under alice's agent id
  w.decision("bob", "a", "published", JAN(10));
  w.decision("alice", "a", "published", JAN(10, 13));
  const view = supervision(w.db, "alice", [a, x], { view: "activity", from: "2026-01-01", to: "2026-01-31" }, JAN(15));
  assert.ok(view.view === "activity");
  if (view.view !== "activity") return;
  assert.deepEqual(view.items.map(item => item.id), [view.items[0].id]);
  assert.equal(view.items[0].type, "decision");
  assert.deepEqual(view.agents.map(item => item.id), ["a"]);
  const asked = supervision(w.db, "alice", [a, x], { view: "calendar", agent: "x", date: "2026-01-10" }, JAN(15));
  assert.deepEqual(asked.scoped, []);
  assert.ok(asked.view === "calendar" && asked.day.lanes.length === 0 && asked.days.every(day => day.runs === 0));
});

test("projections are read-only and the query is validated", async t => {
  const w = await database(t);
  const a = agent("a", "alice");
  w.run("alice", "a", "collect-source", JAN(10), "done", { outcome: "ok", new: 3 });
  const changes = () => (w.db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
  const before = changes();
  const schedule = JSON.stringify(a.schedule);
  for (const view of ["calendar", "queue", "activity"] as const) supervision(w.db, "alice", [a], { view }, JAN(15));
  assert.equal(changes(), before, "no row written");
  assert.equal(JSON.stringify(a.schedule), schedule);
  assert.equal(parseSupervisionQuery(new URLSearchParams("view=agenda")).success, false);
  assert.equal(parseSupervisionQuery(new URLSearchParams("tz=Mars/Olympus")).success, false);
  assert.equal(parseSupervisionQuery(new URLSearchParams("from=2026-02-10&to=2026-02-01")).success, false);
  assert.equal(parseSupervisionQuery(new URLSearchParams("date=2026-02-30")).success, false);
  assert.ok(parseSupervisionQuery(new URLSearchParams("view=queue&state=ready&agent=a")).success);
  assert.equal(supervisionHref({ view: "activity", before: "5", agent: "a" }, { state: "error" }), "/dashboard/supervision?view=activity&agent=a&state=error");
});

test("the queue projection survives a restart: same rows, same states, same reasons", { timeout: 60_000 }, async t => {
  const w = await world(t, "2026-01-15T22:00:00Z", { diffusion: "queue" });
  await w.policy({ maxPerDay: 3, minIntervalMinutes: 15 });
  const published = await w.drafted({ title: "Le Sénat adopte la loi sur l'eau", fact: "Le Sénat a adopté mardi la loi sur la gestion de l'eau", importance: 0.9 });
  const waiting = await w.drafted({ title: "Le budget de la culture augmente", fact: "Le ministère de la Culture disposera de crédits accrus en 2027", importance: 0.7 });
  const old = await w.drafted({ title: "Accord trouvé sur les retraites", fact: "Les partenaires sociaux ont conclu un accord sur les retraites anticipées", hoursAgo: 37 });
  await w.run();
  w.clock.now = Date.parse("2026-01-16T02:00:00Z");
  await w.run();
  const agents = await w.accounts.watchAgents();
  const first = editorialQueue(w.db, "alice", agents.filter(item => item.owner === "alice"), { now: w.clock.now });
  const states = (rows: typeof first.rows) => Object.fromEntries(rows.map(row => [row.draftId, [row.state, row.reason, row.title]]));
  assert.deepEqual(Object.fromEntries(Object.entries(states(first.rows)).map(([id, [state]]) => [id, state])), { [published.id]: "published", [waiting.id]: "ready", [old.id]: "expired" });
  assert.deepEqual(first.counts, { ready: 1, published: 1, withdrawn: 0, expired: 1 });
  // Restart: a new connection on the same file, a resync, the same projection.
  const path = w.db.name;
  const reopened = new Database(path);
  t.after(() => reopened.close());
  syncEditorialQueue(reopened, w.clock.now + MIN);
  const again = editorialQueue(reopened, "alice", agents.filter(item => item.owner === "alice"), { now: w.clock.now + MIN });
  assert.deepEqual(states(again.rows), states(first.rows));
  assert.deepEqual(again.counts, first.counts);
  assert.ok(again.rows.find(row => row.draftId === waiting.id)!.freshness > 0);
});

test("pagination: hundreds of events at the same instant, with or without a state filter, none lost or repeated", async t => {
  const w = await database(t);
  const a = agent("a", "alice");
  const at = JAN(10);
  for (let i = 0; i < 230; i++) w.run("alice", "a", "evaluate-story", at, "done", { outcome: i % 3 ? "accepted" : "rejected" });
  for (let i = 0; i < 40; i++) w.decision("alice", "a", "published", at);
  // finishRun stamps finished_at; started_at is the shared instant.
  w.db.prepare("UPDATE xiagent_run SET started_at = ?").run(at);
  const all = (state?: "empty" | "done") => {
    const seen: string[] = [];
    let before: string | undefined;
    for (let page = 0; page < 20; page++) {
      const view = supervision(w.db, "alice", [a], { view: "activity", from: "2026-01-01", to: "2026-01-31", ...(state ? { state } : {}), ...(before ? { before } : {}) }, JAN(15));
      assert.ok(view.view === "activity");
      if (view.view !== "activity") break;
      seen.push(...view.items.map(item => `${item.type}:${item.id}`));
      if (!view.more) break;
      before = view.more;
    }
    return seen;
  };
  const everything = all();
  assert.equal(everything.length, 270);
  assert.equal(new Set(everything).size, 270, "no repetition");
  const empty = all("empty");
  assert.equal(empty.length, Math.ceil(230 / 3), "only the rejected evaluations, across pages");
  assert.equal(all("done").length, 230 - Math.ceil(230 / 3) + 40);
  assert.equal(parseSupervisionQuery(new URLSearchParams("before=12")).success, false, "an unreadable cursor is refused");
});

test("the diffuser's waits are observable per content, with the rule the diffuser applies", { timeout: 60_000 }, async t => {
  const w = await world(t, "2026-01-15T22:00:00Z", { diffusion: "queue" });
  const SAFE = { maxPerDay: 2, minIntervalMinutes: 15 };
  await w.policy(SAFE);
  const policyOf = async (id: string, changes: Record<string, unknown>) => w.accounts.setWatchPolicy("alice", id, { revision: null, policy: { ...DEFAULT_WATCH_POLICY, enabled: true, autoPublish: true, ...SAFE, ...changes } });
  const paused = await w.agent("alice"); await policyOf(paused, { paused: true });
  const other = await w.agent("alice"); await policyOf(other, {});
  const worth = await w.drafted({ title: "Le Sénat adopte la loi sur l'eau", fact: "Le Sénat a adopté mardi la loi sur la gestion de l'eau", importance: 0.9 });
  const minor = await w.drafted({ title: "Une vidéo virale d'un député", fact: "La vidéo d'un député a été vue des millions de fois", importance: 0.3 });
  const held = await w.drafted({ title: "La Cour des comptes publie son rapport", fact: "La Cour des comptes a publié son rapport annuel sur les finances locales", agent: paused });
  await w.run();
  const waits = async () => {
    const agents = (await w.accounts.watchAgents()).filter(item => item.owner === "alice");
    const { rows } = editorialQueue(w.db, "alice", agents, { now: w.clock.now, diffusion: diffusionContext(w.publications, w.settings) });
    return Object.fromEntries(rows.filter(row => row.state === "ready").map(row => [row.draftId, row.wait]));
  };
  const opening = Date.parse("2026-01-16T02:00:00Z");
  let current = await waits();
  assert.deepEqual([current[worth.id]?.code, current[worth.id]?.retryAt], ["outside-window", opening], "window closed, with its next opening");
  assert.equal(current[minor.id]?.code, "threshold", "not relevant enough: never published, not an error");
  assert.equal(current[held.id]?.code, "agent");
  assert.match(current[held.id]!.reason, /pause/);
  w.clock.now = opening;
  await w.run();
  const next = await w.drafted({ title: "Le budget de la culture augmente", fact: "Le ministère de la Culture disposera de crédits accrus en 2027", importance: 0.8, agent: other });
  w.clock.now = opening + MIN;
  await w.run();
  current = await waits();
  assert.deepEqual([current[next.id]?.code, current[next.id]?.retryAt], ["spacing", opening + 10 * MIN], "another agent: the feed's pace");
  assert.equal(current[worth.id], undefined, "published, no longer waiting");
  const job = w.db.prepare("SELECT state, last_error FROM watch_job WHERE kind = 'editorial-diffusion' ORDER BY created_at DESC LIMIT 1").get() as { state: string; last_error: string };
  assert.match(job.last_error, /en attente : .*threshold 1/, "the diffusion job records why the others wait");
  w.settings.autoPublish = false;
  assert.equal((await waits())[next.id]?.code, "operator");
  w.settings.autoPublish = true; w.settings.diffusion = "legacy";
  assert.equal((await waits())[next.id]?.code, "legacy");
  w.settings.diffusion = "queue";
  w.clock.now = opening + 10 * MIN;
  assert.equal((await waits())[next.id], null, "eligible: the diffuser will try it");
  await w.run();
  assert.equal(w.db.prepare("SELECT state FROM editorial_queue WHERE draft_id = ?").pluck().get(next.id), "published");
});
