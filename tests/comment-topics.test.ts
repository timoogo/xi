import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { openVault } from "../src/lib/publications/vault";
import { createTopicStore } from "../src/lib/topics/store";
import { addCommentTopics, migrateCommentTopics } from "../src/lib/comments/topics";
import { systemTask } from "../src/lib/system-agents/tasks";

test("Konstruktor résout les hashtags publiés, sans doublons et avec héritage", async t => {
  const root = await mkdtemp(join(tmpdir(), "xi-comment-topics-"));
  const db = new Database(":memory:");
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  const topics = createTopicStore({ vault: await openVault(root), db });
  db.exec("CREATE TABLE xi_comment (id TEXT PRIMARY KEY, owner TEXT NOT NULL, agent TEXT)");
  migrateCommentTopics(db);
  const a = randomUUID(), b = randomUUID(), child = randomUUID();
  db.prepare("INSERT INTO xi_comment VALUES (?, 'alice', NULL), (?, 'alice', NULL)").run(a, b);
  addCommentTopics(db, a, null, "alice", "#X-59 #x-59 https://example.test/#ignore");
  addCommentTopics(db, b, null, "alice", "#x-59");
  addCommentTopics(db, child, a, "alice", null);
  const task = systemTask("konstruktor", "comment-topic"); assert.ok(task);
  const rows = db.prepare("SELECT * FROM xi_comment_topic WHERE comment_id = source_id").all() as { source_id: string; tag: string; request_id: string }[];
  assert.equal(rows.length, 2);
  await Promise.all(rows.map(row => task.run({ owner: "alice", input: { commentId: row.source_id, tag: row.tag, requestId: row.request_id }, services: { db, topics } } as never)));
  const links = db.prepare("SELECT * FROM xi_comment_topic").all() as { topic_id: string; state: string }[];
  assert.equal(links.length, 3);
  assert.ok(links.every(link => link.state === "done" && link.topic_id === links[0].topic_id));
  assert.equal((await topics.visible("alice")).personal.length, 1);
});

test("un échec de Konstruktor conserve la demande et l’héritage en erreur", async t => {
  const db = new Database(":memory:"); t.after(() => db.close());
  db.exec("CREATE TABLE xi_comment (id TEXT PRIMARY KEY, owner TEXT NOT NULL, agent TEXT)");
  migrateCommentTopics(db);
  const id = randomUUID(), child = randomUUID();
  db.prepare("INSERT INTO xi_comment VALUES (?, 'alice', NULL)").run(id);
  addCommentTopics(db, id, null, "alice", "#nouveau");
  addCommentTopics(db, child, id, "alice", null);
  const row = db.prepare("SELECT * FROM xi_comment_topic WHERE comment_id = ?").get(id) as { tag: string; request_id: string };
  const task = systemTask("konstruktor", "comment-topic"); assert.ok(task);
  await assert.rejects(task.run({ owner: "alice", input: { commentId: id, tag: row.tag, requestId: row.request_id }, services: { db, topics: { openPersonal: async () => { throw new Error("échec"); } } } } as never));
  assert.deepEqual(db.prepare("SELECT state FROM xi_comment_topic ORDER BY comment_id").all(), [{ state: "error" }, { state: "error" }]);
});
