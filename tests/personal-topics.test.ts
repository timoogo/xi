import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import Database from "better-sqlite3";
import { createAccountStore } from "../src/lib/accounts/store";
import { createPublicationStore } from "../src/lib/publications/store";
import { openVault } from "../src/lib/publications/vault";
import { searchCatalog } from "../src/lib/search/resolve";
import { searchData, searchTarget, setSubscription, subscribedTopics } from "../src/lib/search/server";
import { createTopicStore } from "../src/lib/topics/store";
import { isPersonal } from "../src/lib/topics/types";

async function setup(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "xi-personal-"));
  const vault = await openVault(root);
  const db = new Database(":memory:");
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  const topics = createTopicStore({ vault, db });
  const accounts = createAccountStore({ vault, db, topics });
  const publications = createPublicationStore({ vault, db });
  return { root, vault, db, topics, accounts, publications, stores: { topics, accounts }, subStores: { topics, publications } };
}

test("#topic submission creates one private personal topic, idempotently and under concurrency", async t => {
  const { root, db, topics, stores } = await setup(t);
  const hrefs = await Promise.all(Array.from({ length: 6 }, () => searchTarget("alice", "#Essence", stores)));
  assert.deepEqual(new Set(hrefs), new Set(["/dashboard/topics/essence"]));
  const files = await readdir(join(root, ".xi-personal-topics", "alice"));
  assert.equal(files.length, 1, "concurrent submissions share one topic");
  const { personal, shared } = await topics.visible("alice");
  assert.equal(shared.length, 0);
  assert.equal(personal.length, 1);
  const topic = personal[0];
  assert.ok(isPersonal(topic));
  assert.deepEqual([topic.owner, topic.tag, topic.name, topic.parentId, topic.relatedIds, `${topic.id}.md`], ["alice", "essence", "Essence", null, [], files[0]]);
  assert.equal((await topics.openPersonal("alice", "essence")).topic.id, topic.id);
  assert.equal((await topics.openPersonal("alice", "essence")).created, false);

  // Never shared: not in topics/, its index, the catalogue, nor in another user's search.
  assert.deepEqual((await readdir(join(root, "topics"))).filter(name => name.endsWith(".md")), []);
  assert.deepEqual(await topics.list(), []);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM topic_tag").get() as { n: number }).n, 0);
  const forBob = await searchData("bob", stores);
  assert.deepEqual(forBob.topics, []);
  assert.equal(searchCatalog("#essence", forBob.topics, []).topics[0].match, null);
  assert.ok(!(await readFile(join(root, ".xi-personal-topics", "alice", files[0]), "utf8")).includes("bob"));
  // Bob gets his own, distinct topic for the same tag.
  await searchTarget("bob", "#essence", stores);
  const [bobs] = (await topics.visible("bob")).personal;
  assert.notEqual(bobs.id, topic.id);
  assert.equal((await topics.visible("alice")).personal.length, 1);
});

test("creation only on a single unambiguous unknown #tag; shared topics win at creation and are never blocked", async t => {
  const { root, topics, stores } = await setup(t);
  const { topic: transport } = await topics.create("curator", randomUUID(), { tag: "transport", name: "Transport", description: "", scope: "Transport", parentId: null, relatedIds: [] });
  await topics.update("curator", transport.id, transport.revision, { ...transport, tag: "mobilite" }, true);
  await topics.create("curator", randomUUID(), { tag: "sport", name: "Sport", description: "", scope: "Sport", parentId: null, relatedIds: [] });
  const sport = (await topics.list()).find(t => t.tag === "sport")!;
  await topics.create("curator", randomUUID(), { tag: "sport.france", name: "Sport FR", description: "", scope: "s", parentId: sport.id, relatedIds: [] });
  await topics.create("curator", randomUUID(), { tag: "culture", name: "Culture", description: "", scope: "c", parentId: null, relatedIds: [] });
  const culture = (await topics.list()).find(t => t.tag === "culture")!;
  await topics.create("curator", randomUUID(), { tag: "culture.france", name: "Culture FR", description: "", scope: "c", parentId: culture.id, relatedIds: [] });

  // Existing shared topic (current or former tag): opened, nothing created.
  assert.equal(await searchTarget("alice", "#transport", stores), "/dashboard/topics/mobilite");
  assert.equal((await topics.openPersonal("alice", "transport")).topic.id, transport.id);
  // Not a single #tag, or ambiguous: results page, nothing created.
  assert.equal(await searchTarget("alice", "#essence prix", stores), "/dashboard/explore?q=%23essence%20prix");
  assert.equal(await searchTarget("alice", "#essence #diesel", stores), "/dashboard/explore?q=%23essence%20%23diesel");
  assert.equal(await searchTarget("alice", "#france", stores), "/dashboard/explore?q=%23france");
  assert.equal(await searchTarget("alice", "essence", stores), "/dashboard/explore?q=essence");
  await assert.rejects(readdir(join(root, ".xi-personal-topics", "alice")), { code: "ENOENT" });

  // A personal topic reserves nothing: a shared topic may take the same tag later.
  await searchTarget("alice", "#essence", stores);
  const mine = (await topics.visible("alice")).personal[0];
  const { topic: common } = await topics.create("curator", randomUUID(), { tag: "essence", name: "Essence", description: "", scope: "Carburants", parentId: null, relatedIds: [] });
  // Owner: their personal topic answers first. Others: the shared one.
  const forAlice = await searchData("alice", stores);
  assert.equal(searchCatalog("#essence", forAlice.topics, []).topics[0].match?.topic.id, mine.id);
  assert.equal(await searchTarget("bob", "#essence", stores), "/dashboard/topics/essence");
  assert.equal((await topics.openPersonal("bob", "essence")).topic.id, common.id);
  assert.equal((await topics.visible("bob")).personal.length, 0);
});

test("subscriptions: per user, persistent, idempotent, visible topics only, and nothing else is triggered", async t => {
  const { root, vault, db, topics, accounts, publications, subStores } = await setup(t);
  const { topic: shared } = await topics.create("curator", randomUUID(), { tag: "climat", name: "Climat", description: "", scope: "Climat", parentId: null, relatedIds: [] });
  const { topic: mine } = await topics.openPersonal("alice", "essence");
  await publications.setSocial({ id: "alice" }, "someone", { following: true });

  await setSubscription("alice", mine.id, true, subStores);
  await setSubscription("alice", mine.id, true, subStores);
  await setSubscription("alice", shared.id, true, subStores);
  assert.deepEqual((await subscribedTopics("alice", subStores)).map(t => t.id), [mine.id, shared.id]);
  // Author follows and topic subscriptions share the settings file without overwriting each other.
  const settings = await publications.social({ id: "alice" });
  assert.deepEqual([settings.following, settings.topics], [["someone"], [mine.id, shared.id]]);
  await publications.setSocial({ id: "alice" }, "someone", { preference: "less" });
  assert.deepEqual((await publications.social({ id: "alice" })).topics, [mine.id, shared.id]);

  // Another user can neither subscribe to nor see a personal topic.
  await assert.rejects(setSubscription("bob", mine.id, true, subStores), /introuvable/);
  assert.deepEqual(await subscribedTopics("bob", subStores), []);
  await setSubscription("bob", shared.id, true, subStores);
  assert.deepEqual((await subscribedTopics("bob", subStores)).map(t => t.id), [shared.id]);

  // Persistent: a fresh process reads the same subscriptions from Markdown, independently of SQLite indexes.
  db.exec("DROP TABLE topic_index; DROP TABLE topic_tag; DROP TABLE topic_routing;");
  const db2 = new Database(":memory:");
  t.after(() => db2.close());
  const fresh = { topics: createTopicStore({ vault, db: db2 }), publications: createPublicationStore({ vault, db: db2 }) };
  assert.deepEqual((await subscribedTopics("alice", fresh)).map(t => t.id), [mine.id, shared.id]);

  await setSubscription("alice", mine.id, false, fresh);
  await setSubscription("alice", mine.id, false, fresh);
  assert.deepEqual((await subscribedTopics("alice", fresh)).map(t => t.id), [shared.id]);

  // No ΞAgent, no watch, no publication.
  assert.deepEqual(await accounts.list("alice"), []);
  assert.deepEqual((await readdir(join(root, "generators"), { withFileTypes: true })).filter(entry => entry.isDirectory() && !entry.name.startsWith(".")), []);
  assert.deepEqual(await readdir(join(root, "posts", "_users", "alice")), ["feed.md"]);
  for (const handle of [db, db2]) {
    // Tables created when stores open (pins) may exist; none may hold triggered work.
    const tables = handle.prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE 'watch_%' OR name LIKE 'xiagent_%')").all();
    for (const { name } of tables) assert.equal((handle.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get() as { n: number }).n, 0, name);
    assert.equal((handle.prepare("SELECT COUNT(*) AS n FROM publication").get() as { n: number }).n, 0);
  }
});
