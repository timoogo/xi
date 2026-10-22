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
  return { store, publish };
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
