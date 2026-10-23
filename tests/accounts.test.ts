import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import Database from "better-sqlite3";
import { Document } from "yaml";
import { openVault, writeAtomic } from "../src/lib/publications/vault";
import { readGenerators } from "../src/lib/publications/social";
import { serializeGenerator } from "../src/lib/graph/format";
import { createTopicStore } from "../src/lib/topics/store";
import { createAccountStore } from "../src/lib/accounts/store";
import { BUILTIN_PRESETS, type AccountDraft } from "../src/lib/accounts/types";

async function setup(t: TestContext, beforeStep?: (n: number) => void) {
  const root = await mkdtemp(join(tmpdir(), "xi-accounts-")); const vault = await openVault(root); const db = new Database(":memory:");
  const topics = createTopicStore({ vault, db }); const store = createAccountStore({ vault, db, topics, beforeStep });
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  async function topic(tag: string) { const run = await topics.propose("alice", "Science et société"); const completed = await topics.confirm("alice", run.id, { tag, name: tag, description: "Description", scope: `Scope ${tag}`, parentId: null, relatedIds: [] }, true); assert.equal(completed.state, "completed"); return (await topics.list()).find(t => t.id === run.topicId)!; }
  const primary = await topic("science"); const secondary = await topic("societe");
  async function proposal() { const allocated = await store.propose("alice", primary.id); return store.resume("alice", allocated.id); }
  return { root, vault, db, topics, store, primary, secondary, proposal };
}

test("accounts: create, edit, scope reference, independent rename, activation, legacy readers and rebuild", async t => {
  const { root, vault, db, topics, store, primary, secondary, proposal } = await setup(t);
  const run = await proposal(); assert.equal(run.state, "waiting"); assert.equal((await store.list("alice")).length, 0);
  await assert.rejects(store.confirm("alice", run.id, run.draft, false), /humaine/);
  const draft = { ...run.draft!, secondaryTopicIds: [secondary.id] };
  assert.equal((await store.confirm("alice", run.id, draft, true)).state, "completed");
  let account = (await store.list("alice"))[0]; assert.equal(account.id, run.accountId);
  assert.equal((await readGenerators(vault, { id: "alice" }))[0].id, account.id);
  const content = await readFile(join(root, "generators/science/index.md"), "utf8"); assert.ok(!content.includes(primary.scope));
  const changedTopic = await topics.update("alice", primary.id, primary.revision, { ...primary, tag: "recherche", scope: "Nouveau scope validé" }, true);
  assert.equal((await store.list("alice"))[0].handle, "science");
  assert.equal((await topics.list()).find(t => t.id === account.editorial!.primaryTopicId)?.scope, changedTopic.scope);
  account = await store.update("alice", account.id, account.editorial!.revision, { ...draft, handle: "nouveau.compte", name: "Nouveau nom", active: false });
  assert.equal(account.editorial!.active, false); assert.equal((await topics.list()).find(t => t.id === primary.id)?.tag, "recherche");
  assert.equal((await readGenerators(vault, { id: "alice" }))[0].handle, "nouveau.compte");
  await assert.rejects(store.update("alice", account.id, randomUUID(), draft), /modifié/);
  await assert.rejects(store.update("bob", account.id, account.editorial!.revision, draft), /propriétaire/);
  db.exec("DELETE FROM editorial_account_index"); await store.list("alice"); assert.equal((db.prepare("SELECT count(*) AS n FROM editorial_account_index").get() as { n: number }).n, 1);
  account = await store.update("alice", account.id, account.editorial!.revision, { ...draft, handle: "nouveau.compte", active: true }); assert.equal(account.editorial!.active, true);
});

test("presets: immutable versions, explicit upgrades, reusable custom settings and authorization", async t => {
  const { store, proposal } = await setup(t);
  const p1 = await store.savePreset("alice", { expectedVersion: 0, name: "Mon style", settings: BUILTIN_PRESETS[1].settings });
  const run = await proposal(); const draft: AccountDraft = { ...run.draft!, presetId: p1.id, presetVersion: 1, settings: p1.settings };
  await store.confirm("alice", run.id, draft, true);
  const p2 = await store.savePreset("alice", { id: p1.id, expectedVersion: 1, name: "Mon style", settings: { ...p1.settings, tone: "Nouveau ton" } });
  let account = (await store.list("alice"))[0]; assert.equal(account.editorial!.presetVersion, 1); assert.deepEqual(account.editorial!.settings, p1.settings);
  assert.equal((await store.listPresets("alice")).filter(p => p.id === p1.id).length, 2);
  await assert.rejects(store.savePreset("alice", { id: p1.id, expectedVersion: 1, name: "Conflit", settings: p1.settings }), /périmée/);
  await assert.rejects(store.savePreset("bob", { id: p1.id, expectedVersion: 2, name: "Vol", settings: p1.settings }), /modifiable/);
  assert.equal((await store.listPresets("bob")).length, 4);
  account = await store.update("alice", account.id, account.editorial!.revision, { ...draft, presetVersion: p2.version, settings: p2.settings }); assert.equal(account.editorial!.presetVersion, 2);
});

test("pipeline: durable failures, restart, owner isolation, idempotence and concurrent uniqueness", async t => {
  let fail = true;
  const { store, topics, vault, db, proposal } = await setup(t, n => { if (n === 7 && fail) throw new Error("index unavailable"); });
  const run = await proposal(); await assert.rejects(store.getRun("bob", run.id), /introuvable/);
  const failed = await store.confirm("alice", run.id, run.draft, true); assert.equal(failed.state, "failed"); assert.equal(failed.steps[7].status, "failed");
  fail = false;
  const restarted = createAccountStore({ vault, db, topics });
  assert.equal((await restarted.resume("alice", run.id)).state, "completed");
  assert.equal((await restarted.confirm("alice", run.id, run.draft, true)).state, "completed");
  await assert.rejects(store.confirm("alice", run.id, { ...run.draft!, name: "Different" }, true), /différente/);
  assert.equal((await store.list("alice")).length, 1);
  const a = await proposal(), b = await proposal(); assert.equal(a.draft!.handle, "science-2");
  const results = await Promise.all([store.confirm("alice", a.id, a.draft, true), restarted.confirm("alice", b.id, b.draft, true)]);
  assert.deepEqual(results.map(r => r.state).sort(), ["completed", "failed"]); assert.equal((await store.list("alice")).length, 2);
});

test("validation and failed proposal never bypass human confirmation", async t => {
  let fail = true;
  const { store, primary, secondary, proposal } = await setup(t, n => { if (n === 2 && fail) throw new Error("fail"); });
  const run = await proposal(); assert.equal(run.state, "failed"); fail = false;
  const ready = await store.resume("alice", run.id); assert.equal(ready.state, "waiting");
  for (const patch of [{ primaryTopicId: randomUUID() }, { secondaryTopicIds: [primary.id] }, { secondaryTopicIds: [secondary.id, secondary.id] }, { presetVersion: 99 }, { handle: "../../escape" }, { validationMode: "automatic" }]) await assert.rejects(store.confirm("alice", run.id, { ...ready.draft!, ...patch }, true));
  assert.equal((await store.list("alice")).length, 0);
});

test("legacy generator adoption preserves UUID, visibility, unknown frontmatter and flat storage", async t => {
  const { store, root, primary } = await setup(t);
  const id = randomUUID(); const dir = join(root, "generators/legacy.france"); await mkdir(dir, { recursive: true });
  await writeAtomic(join(dir, "index.md"), serializeGenerator({ id, slug: "legacy.france", title: "Legacy", ownerId: "alice", visibility: "private", createdAt: null }, "Description existante", new Document({ custom: "keep" })));
  assert.equal((await store.list("bob")).length, 0);
  assert.equal((await store.list("alice"))[0].editorial, null);
  const preset = BUILTIN_PRESETS[0];
  await store.update("alice", id, null, { handle: "legacy.france", name: "Legacy", description: "Description existante", primaryTopicId: primary.id, secondaryTopicIds: [], presetId: preset.id, presetVersion: 1, settings: preset.settings, active: true, modelRef: null, validationMode: "human" });
  const content = await readFile(join(dir, "index.md"), "utf8"); assert.match(content, /custom: keep/); assert.match(content, /visibility: private/); assert.equal((await store.list("alice"))[0].id, id);
});
