import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { canEdit, canRead } from "../src/lib/publications/permissions";
import { parseIndex, serializeIndex, setMeta, splitIndexBody } from "../src/lib/publications/markdown";
import { createPublicationStore, PublicationError, type PublicationStore } from "../src/lib/publications/store";
import { openVault, VaultError } from "../src/lib/publications/vault";

const alice = { id: "aliceAAAAAAAAAAAAAAAAAAAAAAAAAAA" };
const bob = { id: "bobBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" };

const home = async (store: PublicationStore, viewer: { id: string }) => (await store.page(viewer, { kind: "home" })).items;

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "xi-vault-"));
  await writeFile(join(root, "Bienvenue.md"), "Existing note [[créez un lien]]\n");
  const vault = await openVault(root);
  const db = new Database(":memory:");
  let clock = Date.parse("2026-10-19T10:00:00.000Z");
  const store = createPublicationStore({ vault, db, now: () => new Date(clock += 1000) });
  const userDir = (viewer = alice) => join(root, "posts", "_users", viewer.id);
  const folderOf = async (viewer = alice) => (await readdir(userDir(viewer))).filter((name) => !name.startsWith("."));
  return { root, vault, db, store, userDir, folderOf, cleanup: () => rm(root, { recursive: true, force: true }) };
}

const rejects = (promise: Promise<unknown>, code = "not_found") =>
  assert.rejects(promise, (error) => error instanceof PublicationError && error.code === code);

test("permissions: drafts private, followers author-only, public published readable", () => {
  const base = { authorType: "human" as const, authorId: alice.id };
  for (const visibility of ["private", "followers", "public"] as const) {
    assert.equal(canRead(alice, { ...base, status: "draft", visibility }), true);
    assert.equal(canRead(bob, { ...base, status: "draft", visibility }), false);
  }
  assert.equal(canRead(bob, { ...base, status: "published", visibility: "public" }), true);
  assert.equal(canRead(bob, { ...base, status: "published", visibility: "followers" }), false);
  assert.equal(canRead(bob, { ...base, status: "published", visibility: "private" }), false);
  assert.equal(canRead(null, { ...base, status: "published", visibility: "public" }), false);
  assert.equal(canRead(alice, { ...base, status: "published", visibility: "public" }, true), false);
  assert.equal(canEdit(bob, { ...base, status: "published", visibility: "public" }), false);
  assert.equal(canEdit(alice, { ...base, authorType: "ai", status: "draft", visibility: "private" }), false);
});

test("index.md round trip keeps unknown properties, comments and foreign embeds", () => {
  const text = "---\n# Obsidian comment\nid: 7d5c1a8e-1f2b-4c3d-8e9f-0a1b2c3d4e5f\ntype: post\nauthor_type: human\nauthor_id: x\nstatus: draft\nvisibility: private\ncreated_at: a\nupdated_at: b\ntags: [veille]\n---\nRésumé [[Note]]\n![[image.webp]]\n![[posts/_users/x/post_1/1_a]]\n";
  const parsed = parseIndex(text);
  assert.ok(parsed.meta);
  const { summary, order } = splitIndexBody(parsed.body, (file) => file === "1_a.md");
  assert.deepEqual(order, ["1_a.md"]);
  assert.equal(summary, "Résumé [[Note]]\n![[image.webp]]");
  setMeta(parsed.doc, { ...parsed.meta, visibility: "public" });
  const output = serializeIndex(parsed.doc, summary, ["posts/_users/x/post_1/1_a"]);
  assert.match(output, /# Obsidian comment/);
  assert.match(output, /tags: \[ veille \]|tags: \[veille\]/);
  assert.match(output, /visibility: public/);
  assert.ok(output.endsWith("Résumé [[Note]]\n![[image.webp]]\n\n![[posts/_users/x/post_1/1_a]]\n"));
});

test("vault must exist and is never created", async () => {
  await assert.rejects(openVault(join(tmpdir(), "xi-missing-vault-does-not-exist")), VaultError);
});

test("drafts: files, autosave, thread rename, stable IDs and isolation", async (t) => {
  const { root, store, userDir, folderOf, cleanup } = await setup();
  t.after(cleanup);
  const id = await store.create(alice);
  assert.deepEqual(await folderOf(), ["post_20261019_001"]);
  assert.equal(await readFile(join(root, "Bienvenue.md"), "utf8"), "Existing note [[créez un lien]]\n");
  let draft = await store.getEditable(alice, id);
  assert.equal(draft.status, "draft");
  assert.equal(draft.visibility, "private");
  await rejects(store.get(bob, id));
  await rejects(store.getEditable(bob, id));
  await rejects(store.save(bob, id, { baseRevision: draft.revision, summary: "x", visibility: "public", messages: [] }));

  const first = await store.save(alice, id, {
    baseRevision: draft.revision, summary: "Résumé de la **réforme**", visibility: "public",
    messages: [{ key: "a", file: null, body: "# Annonce de la réforme !\n\nTexte [[Lien Obsidian]]\n\n## Sources\n" }, { key: "empty", file: null, body: "\n## Sources\n" }],
  });
  assert.ok(first.ok);
  assert.deepEqual(first.files, { a: "1_annonce_de_la_reforme.md" });
  const postDir = join(userDir(), "post_20261019_001");
  const index = await readFile(join(postDir, "index.md"), "utf8");
  assert.match(index, new RegExp(`^---\\nid: ${id}\\ntype: post\\nauthor_type: human\\nauthor_id: ${alice.id}\\nstatus: draft\\nvisibility: public\\n`));
  assert.ok(index.endsWith(`Résumé de la **réforme**\n\n![[posts/_users/${alice.id}/post_20261019_001/1_annonce_de_la_reforme]]\n`));
  await rejects(store.get(bob, id)); // a draft stays private whatever its future visibility
  assert.deepEqual(await home(store, bob), []);

  draft = first.snapshot;
  const second = await store.save(alice, id, {
    baseRevision: draft.revision, summary: draft.summary, visibility: "public",
    messages: [{ key: "b", file: null, body: "Analyse" }, { key: "a", file: "1_annonce_de_la_reforme.md", body: draft.messages[0].body }],
  });
  assert.ok(second.ok);
  assert.deepEqual(second.relocated, { from: `posts/_users/${alice.id}/post_20261019_001`, to: `posts/_users/${alice.id}/thread_20261019_001` });
  assert.deepEqual(await folderOf(), ["thread_20261019_001"]);
  const threadIndex = await readFile(join(userDir(), "thread_20261019_001", "index.md"), "utf8");
  assert.ok(threadIndex.endsWith(`![[posts/_users/${alice.id}/thread_20261019_001/2_analyse]]\n![[posts/_users/${alice.id}/thread_20261019_001/1_annonce_de_la_reforme]]\n`));
  const reread = await store.getEditable(alice, id);
  assert.equal(reread.type, "thread");
  assert.deepEqual(reread.messages.map((message) => message.file), ["2_analyse.md", "1_annonce_de_la_reforme.md"]);

  // Removing a message keeps its file recoverable in the private trash, and numbers are never reused.
  const third = await store.save(alice, id, { baseRevision: reread.revision, summary: reread.summary, visibility: "public", messages: [{ key: "a", file: "1_annonce_de_la_reforme.md", body: reread.messages[1].body }] });
  assert.ok(third.ok);
  const removed = await readdir(join(root, "posts", ".trash", alice.id, id, "removed-messages"));
  assert.match(removed[0], /^\d+_2_analyse\.md$/);
  await assert.rejects(store.save(alice, id, { baseRevision: third.snapshot.revision, summary: "", visibility: "public", messages: [{ key: "x", file: "../../escape.md", body: "x" }] }), PublicationError);
  await assert.rejects(store.save(alice, id, { baseRevision: third.snapshot.revision, summary: "", visibility: "public", messages: [{ key: "x", file: "9_unknown.md", body: "x" }] }), PublicationError);
});

test("conflicts with Obsidian edits are never overwritten silently", async (t) => {
  const { store, userDir, cleanup } = await setup();
  t.after(cleanup);
  const id = await store.create(alice);
  const draft = await store.getEditable(alice, id);
  const saved = await store.save(alice, id, { baseRevision: draft.revision, summary: "v1", visibility: "private", messages: [{ key: "a", file: null, body: "Premier message" }] });
  assert.ok(saved.ok);
  const indexPath = join(userDir(), "post_20261019_001", "index.md");
  const messagePath = join(userDir(), "post_20261019_001", "1_premier_message.md");
  const external = (await readFile(indexPath, "utf8")).replace("status: draft", "status: draft\ncssclasses: [xi] # ajouté dans Obsidian").replace("v1", "v1 modifié dans Obsidian [[Autre note]]");
  await writeFile(indexPath, external);
  await writeFile(messagePath, "Premier message corrigé dans Obsidian");

  const stale = await store.save(alice, id, { baseRevision: saved.snapshot.revision, summary: "v2 depuis Xi", visibility: "private", messages: [{ key: "a", file: "1_premier_message.md", body: "Écrasement" }] });
  assert.equal(stale.ok, false);
  assert.ok(!stale.ok && stale.conflict.summary.includes("modifié dans Obsidian"));
  assert.equal(await readFile(indexPath, "utf8"), external);
  assert.equal(await readFile(messagePath, "utf8"), "Premier message corrigé dans Obsidian");
  if (stale.ok) return;
  assert.equal((await store.publish(alice, id, saved.snapshot.revision)).ok, false);

  // The author explicitly keeps their version against the revision they were shown.
  const kept = await store.save(alice, id, { baseRevision: stale.conflict.revision, summary: `${stale.conflict.summary} + Xi`, visibility: "private", messages: stale.conflict.messages.map((message) => ({ key: message.file, ...message })) });
  assert.ok(kept.ok);
  const merged = await readFile(indexPath, "utf8");
  assert.match(merged, /cssclasses: \[ xi \] # ajouté dans Obsidian|cssclasses: \[xi\] # ajouté dans Obsidian/);
  assert.match(merged, /v1 modifié dans Obsidian \[\[Autre note\]\] \+ Xi/);
});

test("publish, visibility, external moves and sources", async (t) => {
  const { root, store, userDir, cleanup } = await setup();
  t.after(cleanup);
  const id = await store.create(alice);
  let current = await store.getEditable(alice, id);
  await rejects(store.publish(alice, id, current.revision), "invalid");
  const saved = await store.save(alice, id, { baseRevision: current.revision, summary: "Résumé", visibility: "followers", messages: [{ key: "a", file: null, body: "Contexte\n\n## Sources\n" }] });
  assert.ok(saved.ok);
  await rejects(store.publish(bob, id, saved.snapshot.revision));
  const published = await store.publish(alice, id, saved.snapshot.revision);
  assert.ok(published.ok && published.snapshot.status === "published" && published.snapshot.publishedAt);
  await rejects(store.get(bob, id)); // followers is author-only without a subscription model
  assert.deepEqual(await home(store, bob), []);

  const source = await store.addSource(alice, id, published.snapshot.revision, {
    url: "https://www.lemonde.fr/article", title: "Article | Le Monde", publisher: "Le Monde", publishedAt: "2026-10-18",
    facts: ["Le texte est voté"], reservations: [],
  });
  assert.ok(source.ok);
  assert.equal(source.line, `- [[posts/_users/${alice.id}/post_20261019_001/_sources/1_article_le_monde|Article Le Monde]] — Le Monde`);
  const note = await readFile(join(userDir(), "post_20261019_001", "_sources", "1_article_le_monde.md"), "utf8");
  for (const fact of ["url: https://www.lemonde.fr/article", "publisher: Le Monde", "published_at: 2026-10-18", "accessed_at: 2026-10-19", "- Le texte est voté"]) assert.ok(note.includes(fact), fact);
  await rejects(store.addSource(alice, id, source.revision, { url: "javascript:alert(1)", title: "x", publisher: "y", facts: ["z"], reservations: [] }), "invalid");

  current = await store.getEditable(alice, id);
  const shared = await store.save(alice, id, { baseRevision: current.revision, summary: current.summary, visibility: "public", messages: current.messages.map((message) => ({ key: "a", ...message, body: `${message.body}${source.line}\n` })) });
  assert.ok(shared.ok);
  assert.equal((await store.get(bob, id)).sources[0].url, "https://www.lemonde.fr/article");
  assert.deepEqual((await home(store, bob)).map((item) => item.id), [id]);
  assert.deepEqual((await readdir(userDir())), ["post_20261019_001"]); // published folders keep their name

  // Obsidian rename and an external switch to private are picked up by ID.
  await rename(join(userDir(), "post_20261019_001"), join(userDir(), "post_20261019_009"));
  assert.equal((await store.get(bob, id)).id, id);
  const indexPath = join(userDir(), "post_20261019_009", "index.md");
  await writeFile(indexPath, (await readFile(indexPath, "utf8")).replace("visibility: public", "visibility: private"));
  await rejects(store.get(bob, id));
  assert.deepEqual(await home(store, bob), []);

  // Frontmatter claiming another author, or a symlink out of the vault, is never served.
  await writeFile(indexPath, (await readFile(indexPath, "utf8")).replace("visibility: private", "visibility: public").replace(`author_id: ${alice.id}`, `author_id: ${bob.id}`));
  await rejects(store.get(bob, id));
  const outside = await mkdtemp(join(tmpdir(), "xi-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await mkdir(join(root, "posts", "_users", bob.id), { recursive: true });
  await symlink(join(userDir(), "post_20261019_009"), join(outside, "post_20261019_001"));
  await symlink(join(outside, "post_20261019_001"), join(root, "posts", "_users", bob.id, "post_20261019_001"));
  assert.deepEqual(await home(store, bob), []);
});

test("trash hides immediately, is private, and restores", async (t) => {
  const { root, store, userDir, folderOf, cleanup } = await setup();
  t.after(cleanup);
  const id = await store.create(alice);
  const draft = await store.getEditable(alice, id);
  const saved = await store.save(alice, id, { baseRevision: draft.revision, summary: "Public", visibility: "public", messages: [{ key: "a", file: null, body: "Bonjour" }] });
  assert.ok(saved.ok);
  assert.ok((await store.publish(alice, id, saved.snapshot.revision)).ok);
  assert.equal((await store.get(bob, id)).id, id);

  await rejects(store.trash(bob, id));
  await store.trash(alice, id);
  await rejects(store.get(bob, id));
  await rejects(store.get(alice, id));
  assert.deepEqual(await home(store, bob), []);
  assert.deepEqual((await store.page(alice, { kind: "own" })).items, []);
  assert.deepEqual(await folderOf(), []);
  const trashed = join(root, "posts", ".trash", alice.id, id);
  assert.deepEqual((await readdir(trashed)).sort(), ["post_20261019_001", "trash.json"]);
  assert.deepEqual((await store.listTrash(alice)).map((item) => item.id), [id]);
  assert.deepEqual(await store.listTrash(bob), []);
  await rejects(store.restore(bob, id));

  // A new publication never reuses the trashed folder's number; the original slot is reused on restore.
  const other = await store.create(alice);
  assert.deepEqual(await folderOf(), ["post_20261019_002"]);
  assert.deepEqual(await store.restore(alice, id), { id, folder: "post_20261019_001", renamed: false });
  assert.deepEqual((await folderOf()).sort(), ["post_20261019_001", "post_20261019_002"]);
  assert.equal((await store.get(bob, id)).id, id);
  assert.deepEqual(await store.listTrash(alice), []);

  // Restoring into an occupied slot allocates a new folder and repoints its embeds.
  await store.trash(alice, id);
  await mkdir(join(userDir(), "post_20261019_001"));
  await writeFile(join(userDir(), "post_20261019_001", "notes.md"), "occupé");
  assert.deepEqual(await store.restore(alice, id), { id, folder: "post_20261019_003", renamed: true });
  assert.equal(await readFile(join(userDir(), "post_20261019_001", "notes.md"), "utf8"), "occupé");
  const restored = await store.get(alice, id);
  assert.equal(restored.messages[0].body, "Bonjour");
  const index = await readFile(join(userDir(), "post_20261019_003", "index.md"), "utf8");
  assert.ok(index.includes(`![[posts/_users/${alice.id}/post_20261019_003/1_bonjour]]`));
  assert.ok(other);
});

test("index is rebuildable from files alone", async (t) => {
  const { vault, store, cleanup } = await setup();
  t.after(cleanup);
  const id = await store.create(alice);
  const draft = await store.getEditable(alice, id);
  const saved = await store.save(alice, id, { baseRevision: draft.revision, summary: "Persisté", visibility: "public", messages: [] });
  assert.ok(saved.ok && (await store.publish(alice, id, saved.snapshot.revision)).ok);
  const fresh = createPublicationStore({ vault, db: new Database(":memory:") });
  assert.deepEqual((await home(fresh, bob)).map((item) => [item.id, item.summary]), [[id, "Persisté"]]);
});

test("feed pages: newest publication first, keyset cursor, scopes and permissions", async (t) => {
  const { store, cleanup } = await setup();
  t.after(cleanup);
  async function write(viewer: { id: string }, summary: string, visibility: "private" | "public", publish = true) {
    const id = await store.create(viewer);
    const draft = await store.getEditable(viewer, id);
    const saved = await store.save(viewer, id, { baseRevision: draft.revision, summary, visibility, messages: [] });
    assert.ok(saved.ok);
    if (publish) assert.ok((await store.publish(viewer, id, saved.snapshot.revision)).ok);
    return id;
  }
  const ids = [];
  for (let index = 0; index < 5; index++) ids.push(await write(alice, `Public ${index}`, "public"));
  const hidden = await write(alice, "Privée", "private");
  const draft = await write(alice, "Brouillon", "public", false);
  const own = await write(bob, "Bob privé", "private");

  const first = await store.page(bob, { kind: "home" }, null, 3);
  assert.deepEqual(first.items.map((item) => item.summary), ["Bob privé", "Public 4", "Public 3"]);
  const second = await store.page(bob, { kind: "home" }, first.nextCursor, 3);
  assert.deepEqual(second.items.map((item) => item.summary), ["Public 2", "Public 1", "Public 0"]);
  assert.equal(second.nextCursor, null);
  const seen = [...first.items, ...second.items].map((item) => item.id);
  assert.ok(!seen.includes(hidden) && !seen.includes(draft) && seen.includes(own));
  assert.deepEqual((await store.page(bob, { kind: "home" }, "garbage", 1)).items.map((item) => item.summary), ["Bob privé"]);

  assert.deepEqual((await store.page(alice, { kind: "author", authorId: alice.id })).items.map((item) => item.summary), ["Privée", "Public 4", "Public 3", "Public 2", "Public 1", "Public 0"]);
  assert.deepEqual((await store.page(bob, { kind: "author", authorId: alice.id })).items.length, 5);
  assert.ok((await store.page(alice, { kind: "own" })).items.some((item) => item.id === draft));
  assert.ok(!(await store.page(bob, { kind: "own" })).items.some((item) => item.id === draft));
  assert.ok(ids.length === 5);
});
