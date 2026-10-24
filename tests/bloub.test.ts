import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import Database from "better-sqlite3";
import { EXPRESSIONS, SHAPES } from "bloub-react";
import { migrateAvatarPreferences, getAvatarPreference } from "../src/lib/avatar-preferences";
import { bloubConfigSchema, DEFAULT_BLOUB_CONFIG } from "../src/lib/bloub/config";
import { bloubFromSeed } from "../src/lib/bloub/presets";
import { bloubFrame, CLOSED_EYES_AT, loadingGaze, OPEN_EYES_AT } from "../src/lib/bloub/state-mapping";
import { BLOUB_ACTIVITIES } from "../src/lib/bloub/types";
import { createAccountStore } from "../src/lib/accounts/store";
import { DEFAULT_WATCH_POLICY } from "../src/lib/accounts/types";
import { createJobQueue, migrateWatchJobs } from "../src/lib/watch/jobs";
import { readGenerators } from "../src/lib/publications/social";
import { openVault } from "../src/lib/publications/vault";
import { createTopicStore } from "../src/lib/topics/store";
import { agentActivity, agentStatus, busyAgents, readAgentBloub, xiAgentBloub } from "../src/lib/xiagents/avatar";

test("Bloub migration preserves photos, is idempotent and supports legacy writers", () => {
  const db = new Database(":memory:");
  try {
    db.pragma("foreign_keys = ON");
    migrateAvatarPreferences(db);
    db.exec(`CREATE TABLE user(id TEXT PRIMARY KEY, image TEXT, name TEXT);
      INSERT INTO user VALUES ('a', NULL, 'A'), ('b', '/portrait.webp', 'B');`);
    migrateAvatarPreferences(db);
    const a = getAvatarPreference(db, "a"), b = getAvatarPreference(db, "b");
    assert.equal(a.mode, "bloub"); assert.equal(b.mode, "photo");
    assert.match(a.seed, /^[0-9a-f]{32}$/); assert.notEqual(a.seed, b.seed);
    migrateAvatarPreferences(db); assert.deepEqual(getAvatarPreference(db, "a"), a);
    assert.deepEqual(db.prepare("SELECT image FROM user WHERE id='b'").get(), { image: "/portrait.webp" });
    db.exec("INSERT INTO user VALUES ('c', NULL, 'C'); UPDATE user SET name='Renamed' WHERE id='a'");
    assert.equal(getAvatarPreference(db, "c").mode, "bloub");
    assert.deepEqual(getAvatarPreference(db, "a"), a);
    db.exec("UPDATE user SET image='/new.webp' WHERE id='a'");
    assert.deepEqual(getAvatarPreference(db, "a"), { ...a, mode: "photo", revision: 1 });
    db.exec("UPDATE user SET image=NULL WHERE id='a'");
    assert.deepEqual(getAvatarPreference(db, "a"), { ...a, revision: 2 });
    assert.throws(() => db.prepare("UPDATE user_avatar SET seed=? WHERE user_id='b'").run(a.seed));
    db.exec("DELETE FROM user WHERE id='c'");
    assert.equal(db.prepare("SELECT * FROM user_avatar WHERE user_id='c'").get(), undefined);
  } finally { db.close(); }
});

test("seeds map deterministically onto library catalogs and keep their previous silhouette byte", () => {
  const seed = "0123456789abcdef0123456789abcdef";
  assert.deepEqual(bloubFromSeed(seed), bloubFromSeed(seed));
  assert.equal(bloubFromSeed(seed).shape, SHAPES[0xcd % SHAPES.length].id);
  assert.deepEqual(bloubFromSeed("invalid"), DEFAULT_BLOUB_CONFIG);
  assert.deepEqual(bloubFromSeed(null), DEFAULT_BLOUB_CONFIG);
  for (let i = 0; i < 64; i++) assert.ok(bloubConfigSchema.safeParse(bloubFromSeed(i.toString(16).padStart(2, "0").repeat(16))).success);
});

test("configuration is validated against the library catalogs and versioned", () => {
  assert.deepEqual(DEFAULT_BLOUB_CONFIG, { version: 1, shape: "cercle", expression: "neutre", color: "encre" });
  for (const shape of SHAPES) assert.ok(bloubConfigSchema.safeParse({ ...DEFAULT_BLOUB_CONFIG, shape: shape.id }).success);
  for (const expression of EXPRESSIONS) assert.ok(bloubConfigSchema.safeParse({ ...DEFAULT_BLOUB_CONFIG, expression: expression.id }).success);
  for (const bad of [{ ...DEFAULT_BLOUB_CONFIG, shape: "carré" }, { ...DEFAULT_BLOUB_CONFIG, version: 2 }, { ...DEFAULT_BLOUB_CONFIG, hat: "top" }, { shape: "cercle" }, "cercle"]) {
    assert.equal(bloubConfigSchema.safeParse(bad).success, false);
  }
  // Agents saved before avatars existed, or a damaged value, read as the default.
  assert.deepEqual(readAgentBloub(undefined), { config: DEFAULT_BLOUB_CONFIG, revision: null });
  assert.deepEqual(readAgentBloub("https://example.org/legacy.png"), { config: DEFAULT_BLOUB_CONFIG, revision: null });
});

test("activities map onto public bloub-react props; the activity always wins", () => {
  const config = { ...DEFAULT_BLOUB_CONFIG, shape: "nuage" as const, expression: "heureux" as const };
  const frames = Object.fromEntries(BLOUB_ACTIVITIES.map(activity => [activity, bloubFrame(config, activity)]));
  for (const frame of Object.values(frames)) { assert.equal(frame.state, "idle"); assert.equal(frame.color, "encre"); }
  assert.deepEqual([frames.idle.shape, frames.idle.frozenAt, frames.idle.animated, frames.idle.gaze], ["nuage", OPEN_EYES_AT, false, null]);
  assert.deepEqual([frames.sleeping.shape, frames.sleeping.expression, frames.sleeping.frozenAt, frames.sleeping.animated], ["nuage", "surpris", CLOSED_EYES_AT, false]);
  assert.deepEqual([frames.unavailable.shape, frames.unavailable.animated], ["triangle", false]);
  assert.equal(frames.working.animated, true); assert.equal(frames.working.gaze, loadingGaze);
  // Loading gaze: three distinct targets, pure, periodic, without drift.
  const targets = [0.45, 0.95, 1.45].map(t => Math.round(loadingGaze(t).yaw));
  assert.equal(new Set(targets).size, 3);
  assert.deepEqual(loadingGaze(0.2), loadingGaze(1.7));
  assert.equal(loadingGaze(3).wander, 0); assert.equal(loadingGaze(3).mix, 1);
});

test("ΞAgent activity: unavailable, working, idle and sleeping from real state", () => {
  assert.equal(agentActivity({ active: false, watching: true, busy: true }), "unavailable");
  assert.equal(agentActivity({ active: true, watching: true, busy: true }), "working");
  assert.equal(agentActivity({ active: true, watching: true, busy: false }), "idle");
  assert.equal(agentActivity({ active: true, watching: false, busy: false }), "sleeping");
  assert.deepEqual(agentStatus({}), { config: DEFAULT_BLOUB_CONFIG, active: false, watching: false });
  assert.equal(agentStatus({ editorial: { active: true }, watch: { enabled: true, paused: false } }).watching, false, "an unreadable policy is disabled");
  const db = new Database(":memory:");
  try {
    assert.deepEqual([...busyAgents(db, ["a"])], [], "no queue table yet");
    migrateWatchJobs(db);
    let now = 1_000;
    const queue = createJobQueue(db, () => now);
    queue.enqueue({ kind: "publication-window", key: "publication-window:a:d", payload: { agentId: "a" }, runAfter: 0, maxAttempts: 3 });
    queue.enqueue({ kind: "publication-window", key: "publication-window:b:d", payload: { agentId: "b" }, runAfter: 0, maxAttempts: 3 });
    assert.deepEqual([...busyAgents(db, ["a", "b"], now)], []);
    assert.ok(queue.claim(["publication-window"], 60_000));
    const busy = busyAgents(db, ["a", "b", "c"], now);
    assert.equal(busy.size, 1);
    assert.deepEqual([...busyAgents(db, ["c"], now)], []);
    now += 120_000;
    assert.deepEqual([...busyAgents(db, ["a", "b"], now)], [], "an expired lease is not activity");
  } finally { db.close(); }
});

async function agent(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "xi-bloub-")); const vault = await openVault(root); const db = new Database(":memory:");
  const topics = createTopicStore({ vault, db }); const store = createAccountStore({ vault, db, topics });
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  const topicRun = await topics.propose("alice", "Science"); await topics.confirm("alice", topicRun.id, { tag: "science", name: "Science", description: "D", scope: "S", parentId: null, relatedIds: [] }, true);
  const run = await store.resume("alice", (await store.propose("alice", topicRun.topicId)).id);
  await store.confirm("alice", run.id, run.draft, true);
  return { root, vault, store, id: run.accountId, draft: run.draft! };
}

test("ΞAgent avatar: save, reload, concurrency, ownership and preservation by other writers", async t => {
  const { root, vault, store, id, draft } = await agent(t);
  assert.deepEqual(await store.avatar("alice", id), { config: DEFAULT_BLOUB_CONFIG, revision: null });
  const config = { ...DEFAULT_BLOUB_CONFIG, shape: "goutte" as const, expression: "curieux" as const };
  const saved = await store.setAvatar("alice", id, { revision: null, config });
  assert.deepEqual(await store.avatar("alice", id), saved);
  assert.match(await readFile(join(root, "generators/science/index.md"), "utf8"), /bloub:\n\s+config:\n\s+version: 1\n\s+shape: goutte/);
  await assert.rejects(store.setAvatar("alice", id, { revision: null, config }), /modifié/);
  await assert.rejects(store.setAvatar("bob", id, { revision: saved.revision, config }), /introuvable/);
  await assert.rejects(store.setAvatar("alice", id, { revision: saved.revision, config: { ...config, shape: "carré" } }));
  await assert.rejects(store.setAvatar("alice", id, { revision: saved.revision, config, extra: true }));
  // Editorial and watch writers keep the avatar; the generator reader exposes appearance and activity inputs.
  const account = (await store.list("alice"))[0];
  await store.update("alice", id, account.editorial!.revision, { ...draft, name: "Renommé" });
  await store.setWatchPolicy("alice", id, { revision: null, policy: { ...DEFAULT_WATCH_POLICY, enabled: true } });
  assert.deepEqual((await store.avatar("alice", id)).config, config);
  const [generator] = await readGenerators(vault, { id: "alice" });
  assert.deepEqual(generator.status, { config, active: true, watching: true });
  assert.deepEqual(xiAgentBloub(generator.status, false), { config, activity: "idle" });
  assert.deepEqual(xiAgentBloub(generator.status, true).activity, "working");
});
