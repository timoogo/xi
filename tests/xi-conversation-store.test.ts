import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createPublicationStore } from "../src/lib/publications/store";
import { openVault } from "../src/lib/publications/vault";

const alice = { id: "alice" }, bob = { id: "bob" };
async function fixture(t: { after(fn: () => Promise<void>): unknown }) {
  const root = await mkdtemp(join(tmpdir(), "xi-conversation-"));
  const vault = await openVault(root);
  const db = new Database(":memory:");
  const store = createPublicationStore({ vault, db, now: () => new Date("2026-10-20T12:00:00Z") });
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  async function publish(body: string, replyTo?: string, visibility: "public" | "followers" | "private" = "public") {
    const id = await store.create(alice, replyTo);
    const draft = await store.getEditable(alice, id);
    const saved = await store.save(alice, id, { baseRevision: draft.revision, summary: "", visibility, messages: [{ key: "new", file: null, body: replyTo ? `---\nreply_to: ${replyTo}\n---\n${body}` : body }] });
    assert.ok(saved.ok);
    await store.publish(alice, id, saved.snapshot.revision);
    return `${id}/1`;
  }
  async function publishThread(bodies: string[], visibility: "public" | "private" = "public") {
    const id = await store.create(alice);
    const draft = await store.getEditable(alice, id);
    const saved = await store.save(alice, id, { baseRevision: draft.revision, summary: "", visibility, messages: bodies.map((body, i) => ({ key: `k${i}`, file: null, body })) });
    assert.ok(saved.ok);
    await store.publish(alice, id, saved.snapshot.revision);
    return bodies.map((_, i) => `${id}/${i + 1}`);
  }
  return { store, publish, publishThread };
}

test("conversation cursor appends batches of ten in stable chronological/ref order without duplicates", async t => {
  const { store, publish } = await fixture(t);
  const parent = await publish("Parent");
  const expected = [];
  for (let n = 0; n < 23; n++) expected.push(await publish(`Réponse ${n}`, parent));
  const first = await store.conversation(bob, parent);
  assert.equal(first.children.length, 10);
  assert.ok(first.nextCursor);
  const second = await store.conversation(bob, parent, first.nextCursor!);
  assert.equal(second.children.length, 10);
  assert.ok(second.nextCursor);
  const last = await store.conversation(bob, parent, second.nextCursor!);
  assert.equal(last.children.length, 3);
  assert.equal(last.nextCursor, null);
  const refs = [...first.children, ...second.children, ...last.children].map(entry => entry.ref);
  assert.deepEqual(refs, expected.sort());
  assert.equal(new Set(refs).size, 23);
});

test("deep conversation returns complete parent and ordered ancestry without copying messages", async t => {
  const { store, publish } = await fixture(t);
  const root = await publish("Origine");
  const one = await publish("Un", root);
  const two = await publish("Deux", one);
  const three = await publish("Trois", two);
  const four = await publish("Quatre", three);
  const result = await store.conversation(bob, three);
  assert.equal(result.parent.ref, three);
  assert.ok(result.parent.message?.body.includes("Trois"));
  assert.deepEqual(result.ancestors.map(entry => entry.ref), [root, one, two]);
  assert.deepEqual(result.children.map(entry => entry.ref), [four]);
});

test("conversation excludes private branches and withdraws followers access on unfollow", async t => {
  const { store, publish } = await fixture(t);
  const root = await publish("Origine");
  const visible = await publish("Public", root);
  const followers = await publish("Abonnés", root, "followers");
  const secret = await publish("Secret", root, "private");
  assert.deepEqual((await store.conversation(bob, root)).children.map(entry => entry.ref), [visible]);
  await store.setSocial(bob, alice.id, { following: true });
  assert.deepEqual(new Set((await store.conversation(bob, root)).children.map(entry => entry.ref)), new Set([visible, followers]));
  await assert.rejects(store.conversation(bob, secret));
  await store.setSocial(bob, alice.id, { following: false });
  await assert.rejects(store.conversation(bob, followers));
  assert.deepEqual((await store.conversation(bob, root)).children.map(entry => entry.ref), [visible]);
});

test("deleted parent exposes only neutral structure while allowed replies survive", async t => {
  const { store, publish } = await fixture(t);
  const root = await publish("Sensitive original body");
  const reply = await publish("Réponse conservée", root);
  const id = root.split("/")[0];
  const before = await store.getEditable(alice, id);
  const removed = await store.save(alice, id, { baseRevision: before.revision, summary: "", visibility: "public", messages: [] });
  assert.ok(removed.ok);
  const result = await store.conversation(bob, root);
  assert.equal(result.parent.deleted, true);
  assert.equal(result.parent.message, null);
  assert.equal(result.parent.publication, null);
  assert.equal(JSON.stringify(result.parent).includes("Sensitive original body"), false);
  assert.equal(JSON.stringify(result.parent).includes("alice"), false);
  assert.deepEqual(result.children.map(entry => entry.ref), [reply]);
});

test("a single post has no thread", async t => {
  const { store, publish } = await fixture(t);
  const root = await publish("Seul");
  const reply = await publish("Réponse", root);
  const result = await store.conversation(bob, root);
  assert.deepEqual(result.thread, []);
  assert.deepEqual(result.children.map(entry => entry.ref), [reply]);
});

test("every thread message stays central over the whole ordered thread", async t => {
  const { store, publishThread } = await fixture(t);
  const short = await publishThread(["Un", "Deux", "Trois"]);
  const first = await store.conversation(bob, short[0]);
  assert.equal(first.parent.ref, short[0]);
  assert.deepEqual(first.thread.map(entry => entry.ref), short);
  const long = await publishThread(Array.from({ length: 10 }, (_, i) => `Message ${i + 1}`));
  for (const ref of [long[2], long[9]]) {
    const result = await store.conversation(bob, ref);
    assert.equal(result.parent.ref, ref);
    assert.deepEqual(result.thread.map(entry => entry.ref), long);
    assert.deepEqual([result.ancestors.length, result.children.length], [0, 0]);
  }
});

test("thread replies belong to their own message and sub-conversations stay distinct", async t => {
  const { store, publish, publishThread } = await fixture(t);
  const origin = await publish("Origine");
  const thread = await publishThread(["Un", "Deux", "Trois"]);
  const id = thread[0].split("/")[0];
  // The thread itself answers another publication: that context precedes the thread.
  const draft = await store.getEditable(alice, id);
  const saved = await store.save(alice, id, { baseRevision: draft.revision, summary: "", visibility: "public", messages: draft.messages.map((message, i) => ({ key: `k${i}`, file: message.file, body: i === 0 ? `---\nreply_to: ${origin}\n---\n${message.body}` : message.body })) });
  assert.ok(saved.ok);
  const reply = await publish("Réponse au 2", thread[1]);
  const nested = await publish("Sous-réponse", reply);
  const second = await store.conversation(bob, thread[1]);
  assert.deepEqual(second.ancestors.map(entry => entry.ref), [origin]);
  assert.deepEqual(second.thread.map(entry => entry.ref), thread);
  assert.deepEqual(second.children.map(entry => entry.ref), [reply]);
  assert.deepEqual(second.thread.map(entry => entry.replyCount), [0, 1, 0]);
  assert.deepEqual((await store.conversation(bob, thread[0])).children, []);
  const sub = await store.conversation(bob, reply);
  assert.deepEqual(sub.thread, []);
  assert.deepEqual(sub.ancestors.map(entry => entry.ref), [thread[1]]);
  assert.deepEqual(sub.children.map(entry => entry.ref), [nested]);
});

test("unavailable thread messages are neutral or absent, and private threads stay owner-only", async t => {
  const { store, publish, publishThread } = await fixture(t);
  const thread = await publishThread(["Un", "Deux secret", "Trois"]);
  const id = thread[0].split("/")[0];
  const reply = await publish("Réponse", thread[1]);
  const draft = await store.getEditable(alice, id);
  const saved = await store.save(alice, id, { baseRevision: draft.revision, summary: "", visibility: "public", messages: draft.messages.filter((_, i) => i !== 1).map((message, i) => ({ key: `k${i}`, file: message.file, body: message.body })) });
  assert.ok(saved.ok);
  const result = await store.conversation(bob, thread[2]);
  assert.deepEqual(result.thread.map(entry => [entry.ref, entry.deleted]), [[thread[0], false], [thread[1], true], [thread[2], false]]);
  assert.equal(JSON.stringify(result.thread[1]).includes("secret"), false);
  assert.deepEqual((await store.conversation(bob, thread[1])).children.map(entry => entry.ref), [reply]);
  const secret = await publishThread(["Privé 1", "Privé 2"], "private");
  await assert.rejects(store.conversation(bob, secret[1]), /introuvable/);
  assert.equal((await store.conversation(alice, secret[1])).thread.length, 2);
});
