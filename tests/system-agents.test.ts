import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import Database from "better-sqlite3";
import { createAccountStore } from "../src/lib/accounts/store";
import { GENERATOR_SLUG } from "../src/lib/graph/types";
import { openVault } from "../src/lib/publications/vault";
import { assertInstanceOwner, instanceOwner, isInstanceOwner, recoverInstanceOwner } from "../src/lib/system-agents/owner";
import { isReservedHandle, SYSTEM_AGENT_KINDS, SYSTEM_AGENTS } from "../src/lib/system-agents/registry";
import { createSystemAgentStore } from "../src/lib/system-agents/store";
import { createTopicStore } from "../src/lib/topics/store";

/** The Better Auth `user` columns the owner logic reads. */
function users(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS "user" (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, createdAt DATE NOT NULL)`);
  return (id: string, createdAt: string) => db.prepare(`INSERT INTO "user" (id, email, createdAt) VALUES (?, ?, ?)`).run(id, `${id}@example.test`, createdAt);
}

async function setup(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "xi-system-agents-"));
  const vault = await openVault(root);
  const db = new Database(join(root, "app.sqlite"));
  db.pragma("journal_mode = WAL");
  const addUser = users(db);
  const store = createSystemAgentStore({ vault, db });
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  return { root, vault, db, store, addUser };
}

test("registry: kinds, ids and handles are unique, handles valid and reserved", () => {
  assert.equal(new Set(SYSTEM_AGENT_KINDS).size, SYSTEM_AGENTS.length);
  assert.equal(new Set(SYSTEM_AGENTS.map(agent => agent.id)).size, SYSTEM_AGENTS.length);
  assert.equal(new Set(SYSTEM_AGENTS.map(agent => agent.handle)).size, SYSTEM_AGENTS.length);
  for (const agent of SYSTEM_AGENTS) {
    assert.ok(GENERATOR_SLUG.test(agent.handle), agent.handle);
    assert.ok(isReservedHandle(agent.handle) && isReservedHandle(`@${agent.handle.toUpperCase()}`));
  }
  assert.equal(isReservedHandle("konstruktor-2"), false);
});

test("store: idempotent initialisation, one file and one row per kind, projection rebuilt from Markdown", async t => {
  const { root, db, store } = await setup(t);
  const first = await store.list();
  assert.deepEqual(first.map(agent => agent.kind), SYSTEM_AGENT_KINDS);
  assert.ok(first.every(agent => agent.enabled));
  const files = async () => (await readdir(join(root, "system-agents"))).filter(name => name.endsWith(".md")).sort();
  const before = await Promise.all((await files()).map(name => readFile(join(root, "system-agents", name), "utf8")));
  const again = await store.list();
  assert.deepEqual(again.map(agent => agent.revision), first.map(agent => agent.revision), "a second read rewrites nothing");
  assert.deepEqual(await Promise.all((await files()).map(name => readFile(join(root, "system-agents", name), "utf8"))), before);
  assert.deepEqual(await files(), SYSTEM_AGENT_KINDS.map(kind => `${kind}.md`).sort());

  db.exec("DELETE FROM system_agent");
  await store.list();
  assert.equal((db.prepare("SELECT count(*) AS n FROM system_agent").get() as { n: number }).n, SYSTEM_AGENTS.length);
  assert.throws(() => db.prepare("INSERT INTO system_agent (kind, id, handle, data) VALUES ('konstruktor', ?, 'autre', '{}')").run(randomUUID()), /UNIQUE/);
  assert.throws(() => db.prepare("INSERT INTO system_agent (kind, id, handle, data) VALUES ('autre', ?, 'konstruktor', '{}')").run(randomUUID()), /UNIQUE/);
});

test("store: concurrent initialisations from separate connections create each agent once", async t => {
  const { root, vault, store } = await setup(t);
  const others = Array.from({ length: 3 }, () => new Database(join(root, "app.sqlite")));
  t.after(() => others.forEach(db => db.close()));
  const stores = [store, ...others.map(db => createSystemAgentStore({ vault, db }))];
  const results = await Promise.all(stores.map(item => item.list()));
  const revisions = results.map(agents => agents.map(agent => `${agent.kind}:${agent.revision}`).join());
  assert.equal(new Set(revisions).size, 1, "every connection sees the same, single initialisation");
  assert.equal((await readdir(join(root, "system-agents"))).filter(name => name.endsWith(".md")).length, SYSTEM_AGENTS.length);
});

test("store: invalid files and an editorial generator holding a reserved handle block without overwriting", async t => {
  const { root, store } = await setup(t);
  await mkdir(join(root, "generators", "arbitre"), { recursive: true });
  await assert.rejects(store.list(), (error: Error & { status?: number }) => error.status === 409 && /@arbitre/.test(error.message));
  assert.deepEqual((await readdir(join(root, "system-agents"))).filter(name => name.endsWith(".md")), [], "nothing written");
  await rm(join(root, "generators", "arbitre"), { recursive: true });

  await store.list();
  const path = join(root, "system-agents", "konstruktor.md");
  await writeFile(path, "---\nid: pas-un-uuid\n---\n");
  await assert.rejects(store.list(), /invalide/);
  assert.equal(await readFile(path, "utf8"), "---\nid: pas-un-uuid\n---\n", "an invalid file is never repaired");

  const stored = SYSTEM_AGENTS[0];
  await writeFile(path, `---\nid: ${randomUUID()}\nkind: ${stored.kind}\nhandle: ${stored.handle}\nenabled: true\nbloub: { version: 1, shape: cercle, expression: neutre, color: encre }\nrevision: ${randomUUID()}\nupdatedAt: 2026-01-01T00:00:00.000Z\nupdatedBy: system\n---\n`);
  await assert.rejects(store.list(), /incohérente/, "identity is fixed by the registry");
});

test("owner: chosen once from the first account, kept, never inherited, recovered only explicitly", async t => {
  const { db, addUser } = await setup(t);
  assert.deepEqual(instanceOwner(db), { status: "uninitialized" });
  assert.throws(() => assertInstanceOwner(db, "alice"), (error: Error & { status?: number }) => error.status === 404);

  addUser("bob", "2026-02-01T00:00:00.000Z");
  addUser("alice", "2026-01-01T00:00:00.000Z");
  const recorded = instanceOwner(db);
  assert.ok(recorded.status === "ok" && recorded.ownerId === "alice", "the oldest account at initialisation");
  addUser("zoe", "2025-01-01T00:00:00.000Z");
  assert.ok(isInstanceOwner(db, "alice"), "a later, older-dated account never takes over");
  assert.equal(isInstanceOwner(db, "zoe"), false);
  assert.throws(() => recoverInstanceOwner(db, "bob@example.test"), /existe toujours/);

  db.prepare(`DELETE FROM "user" WHERE id = 'alice'`).run();
  const missing = instanceOwner(db);
  assert.equal(missing.status, "missing");
  for (const id of ["alice", "bob", "zoe"]) assert.equal(isInstanceOwner(db, id), false, `${id} inherits nothing`);
  assert.throws(() => recoverInstanceOwner(db, "inconnu@example.test"), /Aucun compte/);

  const recovery = recoverInstanceOwner(db, "BOB@example.test");
  assert.deepEqual(recovery, { ownerId: "bob", previousOwnerId: "alice" });
  const recovered = instanceOwner(db);
  assert.ok(recovered.status === "ok" && recovered.ownerId === "bob" && recovered.source === "recovery");
  assert.doesNotThrow(() => assertInstanceOwner(db, "bob"));
});

test("configuration: instance owner only, optimistic, persisted in Markdown", async t => {
  const { root, db, store, addUser } = await setup(t);
  addUser("alice", "2026-01-01T00:00:00.000Z");
  addUser("bob", "2026-02-01T00:00:00.000Z");
  const agent = await store.get("konstruktor");
  await assert.rejects(store.configure("bob", "konstruktor", { revision: agent.revision, enabled: false }), (error: Error & { status?: number }) => error.status === 404);
  await assert.rejects(store.configure("alice", "inconnu", { revision: agent.revision, enabled: false }), (error: Error & { status?: number }) => error.status === 404);
  await assert.rejects(store.configure("alice", "konstruktor", { revision: agent.revision }), /modification/);
  await assert.rejects(store.configure("alice", "konstruktor", { revision: agent.revision, enabled: false, handle: "autre" }));

  const disabled = await store.configure("alice", "konstruktor", { revision: agent.revision, enabled: false, bloub: { version: 1, shape: "nuage", expression: "heureux", color: "vert" } });
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.bloub.shape, "nuage");
  assert.notEqual(disabled.revision, agent.revision);
  assert.match(await readFile(join(root, "system-agents", "konstruktor.md"), "utf8"), /updatedBy: alice/);
  await assert.rejects(store.configure("alice", "konstruktor", { revision: agent.revision, enabled: true }), (error: Error & { status?: number }) => error.status === 409);
  assert.equal((await store.get("konstruktor")).enabled, false, "survives a reread from Markdown");

  db.prepare(`DELETE FROM "user" WHERE id = 'alice'`).run();
  await assert.rejects(store.configure("bob", "konstruktor", { revision: disabled.revision, enabled: true }), (error: Error & { status?: number }) => error.status === 404, "a missing owner blocks configuration for everyone");
});

test("editorial ΞAgents: reserved handles are refused, also by the deterministic proposal", async t => {
  const { vault, db } = await setup(t);
  const topics = createTopicStore({ vault, db });
  const accounts = createAccountStore({ vault, db, topics });
  for (const { handle } of SYSTEM_AGENTS) assert.equal(await accounts.handleAvailable(handle), false, handle);
  assert.equal(await accounts.handleAvailable("konstruktor-2"), true);

  const run = await topics.propose("alice", "Arbitrage sportif");
  await topics.confirm("alice", run.id, { tag: "arbitre", name: "Arbitrage", description: "", scope: "Scope arbitrage", parentId: null, relatedIds: [] }, true);
  const allocated = await accounts.propose("alice", run.topicId);
  const proposal = await accounts.resume("alice", allocated.id);
  assert.equal(proposal.draft!.handle, "arbitre-2", "the deterministic proposal skips a reserved topic tag");
  await assert.rejects(accounts.confirm("alice", proposal.id, { ...proposal.draft!, handle: "konstruktor" }, true), /système/);
  const completed = await accounts.confirm("alice", proposal.id, proposal.draft!, true);
  assert.equal(completed.state, "completed");
  const account = (await accounts.list("alice"))[0];
  await assert.rejects(accounts.update("alice", account.id, account.editorial!.revision, { ...proposal.draft!, handle: "arbitre" }), /système/);
  assert.equal((await accounts.update("alice", account.id, account.editorial!.revision, { ...proposal.draft!, name: "Renommé" })).handle, "arbitre-2");
});
