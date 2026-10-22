import assert from "node:assert/strict";
import { test } from "node:test";
import { changedPublications, encodeSync } from "../src/lib/publications/events";

test("SSE only reports differences of the authorized projection", () => {
  const initial = { version: "1", publications: [{ id: "public", revision: "1" }] };
  assert.deepEqual(changedPublications(initial, { ...initial, version: "2" }), [], "an unrelated private write is silent");
  assert.deepEqual(changedPublications(initial, { version: "3", publications: [] }), ["public"], "revoke a previously visible item");
  assert.deepEqual(changedPublications(initial, { version: "4", publications: [{ id: "public", revision: "2" }, { id: "new", revision: "1" }] }), ["public", "new"]);
});

test("SSE duplicates do not cause repeated updates; reconnect is an explicit state reset", () => {
  const state = { version: "1", publications: [{ id: "visible", revision: "3" }] };
  assert.deepEqual(changedPublications(state, state), []);
  const wire = encodeSync({ version: "epoch:1", publications: [], reset: true });
  assert.match(wire, /^id: epoch:1\nevent: sync\ndata: /);
  assert.deepEqual(JSON.parse(wire.split("data: ")[1]), { version: "epoch:1", publications: [], reset: true });
});

test("the vault watcher sees direct edits to a file the store replaced atomically", async t => {
  const { mkdtemp, readFile, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const Database = (await import("better-sqlite3")).default;
  const { openVault } = await import("../src/lib/publications/vault");
  const { createPublicationStore } = await import("../src/lib/publications/store");
  const { watchPublications } = await import("../src/lib/publications/runtime");
  const root = await mkdtemp(join(tmpdir(), "xi-watch-"));
  const db = new Database(":memory:");
  const store = createPublicationStore({ vault: await openVault(root), db });
  await store.ensureIndexed();
  const watcher = watchPublications(await openVault(root), store);
  t.after(async () => { await watcher.close(); db.close(); await rm(root, { recursive: true, force: true }); });
  const author = { id: "alice" };
  const id = await store.create(author);
  const draft = await store.getEditable(author, id);
  const saved = await store.save(author, id, { baseRevision: draft.revision, summary: "", visibility: "public", messages: [{ key: "a", file: null, body: "Message" }] });
  assert.ok(saved.ok);
  await store.publish(author, id, saved.snapshot.revision);
  const row = () => db.prepare("SELECT path, visibility FROM publication WHERE id = ?").get(id) as { path: string; visibility: string };
  const index = join(root, row().path, "index.md");
  // Obsidian rewrites the file in place after the store's tmp+rename writes.
  await writeFile(index, (await readFile(index, "utf8")).replace("visibility: public", "visibility: private"));
  for (let attempt = 0; attempt < 50 && row().visibility !== "private"; attempt++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(row().visibility, "private");
});
