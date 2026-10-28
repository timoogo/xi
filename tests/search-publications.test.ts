import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import Database from "better-sqlite3";
import { dropIndexTables, INDEX_SCHEMA_VERSION } from "../src/lib/publications/index-db";
import { createPublicationStore } from "../src/lib/publications/store";
import { openVault } from "../src/lib/publications/vault";
import { ftsDocument, ftsQuery, stem } from "../src/lib/search/text";

const alice = { id: "alice" }, bob = { id: "bob" };

async function setup(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "xi-search-pub-"));
  const vault = await openVault(root);
  const db = new Database(":memory:");
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  const store = createPublicationStore({ vault, db });
  async function publish(body: string, visibility: "public" | "private" = "public", summary = "") {
    const id = await store.create(alice);
    const draft = await store.getEditable(alice, id);
    const saved = await store.save(alice, id, { baseRevision: draft.revision, summary, visibility, messages: [{ key: "a", file: null, body }] });
    assert.ok(saved.ok);
    await store.publish(alice, id, saved.snapshot.revision);
    return id;
  }
  /** Declares topics in the frontmatter, as an external (Obsidian) edit would. */
  async function declare(id: string, topics: string[], primary?: string) {
    const { path } = db.prepare<[string], { path: string }>("SELECT path FROM publication WHERE id = ?").get(id)!;
    const file = join(root, path, "index.md");
    const text = await readFile(file, "utf8");
    const lines = [`topics: [${topics.join(", ")}]`, ...(primary ? [`primary_topic: ${primary}`] : [])].join("\n");
    await writeFile(file, text.replace(/^---\n/, `---\n${lines}\n`));
    await store.reconcileAll();
  }
  const search = async (viewer: { id: string }, text?: string, topicIds?: string[]) => (await store.page(viewer, { kind: "search", text, topicIds })).items.map(item => item.id);
  return { root, vault, db, store, publish, declare, search };
}

test("normalization: case, accents, common plurals, stop words and no FTS syntax injection", () => {
  assert.equal(ftsDocument("Les TRANSPORTS ferroviaires — Électricité, journaux, bateaux"), "les transport ferroviaire electricite journal bateau");
  assert.deepEqual(["bus", "gaz", "classes", "process", "2026"].map(stem), ["bus", "gaz", "classe", "process", "2026"]);
  assert.equal(ftsQuery("les Journaux de la région"), "\"journal\" \"region\"");
  assert.equal(ftsQuery("le la les"), null);
  assert.equal(ftsQuery("\"x\" OR y* NEAR(z)"), "\"x\" \"y\" \"near\" \"z\"");
});

test("full-text search: whole message bodies, accents, case, plurals, relevance and permissions", async t => {
  const { search, publish } = await setup(t);
  const filler = "Introduction générale sans rapport. ".repeat(12);
  const deep = await publish(`${filler}\n\nLes **transports** ferroviaires à Lyon et l’électricité.`);
  const relevant = await publish("Climat, climat et climat : le climat change.");
  const marginal = await publish(`${filler} Une mention du climat parmi beaucoup d’autres mots ${filler}`);
  const secret = await publish("Mot confidentiel : zanzibar", "private");

  // Beyond the 200-character excerpt, folded and singularized.
  assert.deepEqual(await search(bob, "TRANSPORT ferroviaire"), [deep]);
  assert.deepEqual(await search(bob, "electricite lyon"), [deep]);
  assert.deepEqual(await search(bob, "transport marseille"), []);
  assert.deepEqual(await search(bob, "les"), []);
  // Relevance before chronology: the denser publication first although it is older.
  assert.deepEqual(await search(bob, "climats"), [relevant, marginal]);
  // Private publications stay with their author.
  assert.deepEqual(await search(bob, "zanzibar"), []);
  assert.deepEqual(await search(alice, "zanzibar"), [secret]);
});

test("topic associations from frontmatter: declared roles, crossed search, combination with text", async t => {
  const { db, search, publish, declare } = await setup(t);
  const transport = randomUUID(), energy = randomUUID();
  const both = await publish("Le train électrique et le réseau.");
  const one = await publish("Le train à vapeur.");
  const hidden = await publish("Le train privé.", "private");
  await publish("Aucun topic déclaré : le train.");
  await declare(both, [transport, energy], transport);
  await declare(one, [transport]);
  await declare(hidden, [transport, energy]);

  assert.deepEqual(db.prepare("SELECT topic_id, role, origin FROM publication_topic WHERE publication_id = ? ORDER BY role").all(both),
    [{ topic_id: transport, role: "primary", origin: "declared" }, { topic_id: energy, role: "secondary", origin: "declared" }]);
  assert.deepEqual(new Set(await search(bob, undefined, [transport])), new Set([both, one]));
  assert.deepEqual(await search(bob, undefined, [transport, energy]), [both]);
  assert.deepEqual(await search(alice, undefined, [energy]).then(ids => new Set(ids)), new Set([both, hidden]));
  assert.deepEqual(await search(bob, "vapeur", [transport]), [one]);
  assert.deepEqual(await search(bob, "vapeur", [energy]), []);
  assert.deepEqual(await search(bob, undefined, ["not-a-uuid"]), []);
  assert.deepEqual(await search(bob), []);
});

test("index rebuild, upgrade from an older schema, external edits and trash keep search consistent with files", async t => {
  const { root, vault, db, store, search, publish, declare } = await setup(t);
  const topic = randomUUID();
  const id = await publish("Observation des comètes.");
  await declare(id, [topic]);

  // Full rebuild from the vault.
  dropIndexTables(db);
  await createPublicationStore({ vault, db }).reconcileAll();
  assert.deepEqual(await search(bob, "comete"), [id]);
  assert.deepEqual(await search(bob, undefined, [topic]), [id]);

  // Existing installation on schema 6 (no search tables): opening the store migrates it, files untouched.
  db.exec("DROP TABLE publication_fts; DROP TABLE publication_topic; UPDATE xi_index_meta SET value = '6' WHERE key = 'schema_version'");
  const upgraded = createPublicationStore({ vault, db });
  assert.equal(db.prepare<[], { value: string }>("SELECT value FROM xi_index_meta WHERE key = 'schema_version'").get()!.value, INDEX_SCHEMA_VERSION);
  await upgraded.reconcileAll();
  assert.deepEqual((await upgraded.page(bob, { kind: "search", text: "comètes" })).items.map(item => item.id), [id]);

  // An external edit of the message replaces the indexed text.
  const { path } = db.prepare<[string], { path: string }>("SELECT path FROM publication WHERE id = ?").get(id)!;
  const { file } = db.prepare<[string], { file: string }>("SELECT file FROM publication_message WHERE publication_id = ?").get(id)!;
  const message = join(root, path, file);
  await writeFile(message, (await readFile(message, "utf8")).replace("comètes", "astéroïdes"));
  await store.reconcileAll();
  assert.deepEqual(await search(bob, "comete"), []);
  assert.deepEqual(await search(bob, "asteroide"), [id]);

  await store.trash(alice, id);
  assert.deepEqual(await search(alice, "asteroide"), []);
  assert.deepEqual(await search(alice, undefined, [topic]), []);
});
