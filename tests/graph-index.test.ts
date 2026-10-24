import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { parseGenerator, parseRelation, serializeGenerator, serializeRelation, type RelationRecord } from "../src/lib/graph/format";
import { createRelationWriter, RelationError, type HumanActor } from "../src/lib/graph/relations";
import { createGraphRepository } from "../src/lib/graph/repository";
import type { AuthorizedGraph } from "../src/lib/graph/types";
import { createIndex, readablePublicationSql, type IndexRow } from "../src/lib/publications/index-db";
import { canRead } from "../src/lib/publications/permissions";
import { createPublicationStore } from "../src/lib/publications/store";
import { openVault } from "../src/lib/publications/vault";

const alice = { id: "aliceAAAAAAAAAAAAAAAAAAAAAAAAAAA" };
const bob = { id: "bobBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" };
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const G = { politiks: uuid(1), france: uuid(2), elections: uuid(3), sciencia: uuid(4), mercatus: uuid(5) };

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "xi-graph-"));
  const vault = await openVault(root);
  const db = new Database(":memory:");
  let clock = Date.parse("2026-10-19T10:00:00.000Z");
  const now = () => new Date(clock += 1000);
  const store = createPublicationStore({ vault, db, now });
  const repo = createGraphRepository({ vault, db, publications: store });
  const writer = createRelationWriter({ vault, db, repository: repo, now });
  return { root, vault, db, store, repo, writer, now, cleanup: () => rm(root, { recursive: true, force: true }) };
}

async function generator(root: string, folder: string, fields: { id: string; slug?: string; owner?: string; visibility?: string; extra?: string }) {
  await mkdir(join(root, "generators", folder), { recursive: true });
  const yaml = `id: ${fields.id}\nslug: ${fields.slug ?? folder}\ntitle: ${folder}\nowner_id: ${fields.owner ?? alice.id}\nvisibility: ${fields.visibility ?? "public"}\n${fields.extra ?? ""}`;
  await writeFile(join(root, "generators", folder, "index.md"), `---\n${yaml}---\nDescription.\n`);
}

let folderSeq = 0;
/** A publication written as Obsidian would: index.md with embeds, numbered message files. */
async function publication(root: string, options: {
  author?: string; id: string; status?: "draft" | "published"; visibility?: string; generator?: string; files?: string[];
}) {
  const author = options.author ?? alice.id;
  const files = options.files ?? ["1_un.md", "2_deux.md"];
  const folder = `${files.length > 1 ? "thread" : "post"}_20261019_${String(++folderSeq).padStart(3, "0")}`;
  const dir = join(root, "posts", "_users", author, folder);
  await mkdir(dir, { recursive: true });
  for (const file of files) await writeFile(join(dir, file), `Message ${file}\n`);
  const status = options.status ?? "published";
  const yaml = [
    `id: ${options.id}`, `type: ${files.length > 1 ? "thread" : "post"}`, "author_type: human", `author_id: ${author}`, `status: ${status}`,
    `visibility: ${options.visibility ?? "public"}`, "created_at: 2026-10-19T10:00:00.000Z", "updated_at: 2026-10-19T10:00:00.000Z",
    ...(status === "published" ? [`published_at: 2026-10-19T10:0${folderSeq % 10}:00.000Z`] : []),
    ...(options.generator ? [`generator: ${options.generator}`] : []),
  ].join("\n");
  const embeds = files.map((file) => `![[posts/_users/${author}/${folder}/${file.replace(/\.md$/, "")}]]`).join("\n");
  await writeFile(join(dir, "index.md"), `---\n${yaml}\n---\n\nRésumé ${options.id}\n\n${embeds}\n`);
  return { dir, folder };
}

function relationRecord(id: string, source: string, target: string, overrides: Partial<RelationRecord> = {}): RelationRecord {
  return {
    id, type: "supports", source, target, status: "validated", needsReview: false, origin: "human", createdBy: alice.id,
    createdAt: "2026-10-19T10:00:00.000Z", validatedBy: alice.id, validatedAt: "2026-10-19T10:00:00.000Z", ...overrides,
  };
}

async function relationFile(root: string, record: RelationRecord, name = `${record.id}.md`) {
  await mkdir(join(root, "relations"), { recursive: true });
  await writeFile(join(root, "relations", name), serializeRelation(record));
}

const sorted = (graph: AuthorizedGraph) => ({
  generators: [...graph.generators].sort((a, b) => a.id.localeCompare(b.id)),
  publications: [...graph.publications].sort((a, b) => a.id.localeCompare(b.id)),
  relations: [...graph.relations].sort((a, b) => a.id.localeCompare(b.id)),
});

async function snapshotFiles(dir: string, prefix = ""): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) for (const [key, value] of await snapshotFiles(path, `${prefix}${entry.name}/`)) result.set(key, value);
    else result.set(`${prefix}${entry.name}`, await readFile(path, "latin1"));
  }
  return result;
}

const code = (expected: RelationError["code"]) => (error: unknown) => error instanceof RelationError && error.code === expected;

test("format: generator and relation parse, round trip keeps unknown keys, invalid files are null", () => {
  const text = `---\n# commentaire\nid: ${G.politiks}\nslug: politiks.france\ntitle: Politiks · France\nowner_id: ${alice.id}\nvisibility: followers\ntags: [a]\n---\nDescription libre.\n`;
  const parsed = parseGenerator(text)!;
  assert.deepEqual(parsed.generator, { id: G.politiks, slug: "politiks.france", title: "Politiks · France", ownerId: alice.id, visibility: "followers", createdAt: null });
  assert.equal(parsed.description, "Description libre.");
  const output = serializeGenerator({ ...parsed.generator, title: "Autre" }, parsed.description, parsed.doc);
  assert.match(output, /# commentaire/);
  assert.match(output, /tags:/);
  assert.equal(parseGenerator(output)!.generator.title, "Autre");
  for (const bad of [
    text.replace("slug: politiks.france", "slug: Politiks/France"), text.replace("visibility: followers", "visibility: secret"),
    text.replace(`owner_id: ${alice.id}`, "owner_id: a b"), text.replace(`id: ${G.politiks}`, "id: 12"), "---\nid: [\n---\n", "pas de frontmatter",
  ]) assert.equal(parseGenerator(bad), null);
  assert.equal(parseGenerator(text.replace("title: Politiks · France\n", ""))!.generator.title, "politiks.france");

  const record = relationRecord(uuid(9), `${uuid(10)}/1`, `${uuid(11)}/2`, { needsReview: true });
  const relationText = serializeRelation(record, "Une note.");
  const back = parseRelation(relationText)!;
  assert.deepEqual(back.relation, record);
  assert.equal(back.note, "Une note.");
  const withExtra = relationText.replace("needs_review: true", "needs_review: true\nconfidence: 0.7 # IA");
  const reparsed = parseRelation(withExtra)!;
  const rewritten = serializeRelation({ ...reparsed.relation, needsReview: false }, reparsed.note, reparsed.doc);
  assert.match(rewritten, /confidence: 0.7 # IA/);
  assert.match(rewritten, /needs_review: false/);
  assert.equal(parseRelation(serializeRelation({ ...record, target: record.source })), null);
  assert.equal(parseRelation(relationText.replace("type: supports", "type: likes")), null);
  assert.equal(parseRelation(relationText.replace(`${uuid(10)}/1`, `${uuid(10)}/0`)), null);
  assert.equal(parseRelation(relationText.replace("status: validated", "status: maybe")), null);
});

test("SQL readability is exactly canRead over every combination", () => {
  const db = new Database(":memory:");
  const index = createIndex(db);
  const cases: { row: IndexRow; expected: boolean }[] = [];
  let n = 0;
  for (const authorType of ["human", "ai"] as const) for (const authorId of [alice.id, bob.id]) for (const status of ["draft", "published"] as const) {
    for (const visibility of ["private", "followers", "public"] as const) for (const trashed of [false, true]) {
      const row: IndexRow = {
        id: uuid(++n), author_type: authorType, author_id: authorId, type: "post", status, visibility, path: `p/${n}`, original_path: null,
        trashed_at: trashed ? "2026-10-19" : null, created_at: "a", updated_at: "b", published_at: null, score: null, excerpt: "",
        generator_id: null, test_content: 0, index_mtime: 1,
      };
      index.upsert(row, []);
      cases.push({ row, expected: canRead(alice, { authorType, authorId, status, visibility }, trashed) });
    }
  }
  const readable = new Set(db.prepare(`SELECT id FROM publication p WHERE ${readablePublicationSql("p")}`).all({ viewer: alice.id }).map((row) => (row as { id: string }).id));
  assert.equal(cases.length, 48);
  for (const { row, expected } of cases) assert.equal(readable.has(row.id), expected, JSON.stringify(row));
});

test("generators: flat folders, dotted parents, duplicates, invalid and escaping files ignored", async (t) => {
  const { root, repo, cleanup } = await setup();
  t.after(cleanup);
  await generator(root, "politiks", { id: G.politiks });
  await generator(root, "politiks.france.elections", { id: G.elections });
  await generator(root, "sciencia", { id: G.sciencia });
  await generator(root, "zzz-copy", { id: uuid(50), slug: "sciencia" });
  await generator(root, "aaa", { id: G.mercatus, slug: "mercatus" });
  await generator(root, "mercatus", { id: G.mercatus, slug: "mercatus.other" });
  await generator(root, "broken", { id: uuid(51), visibility: "everyone" });
  await mkdir(join(root, "generators", "politiks", "nested"), { recursive: true });
  await writeFile(join(root, "generators", "politiks", "nested", "index.md"), `---\nid: ${uuid(52)}\nslug: nested\nowner_id: ${alice.id}\nvisibility: public\n---\n`);
  const outside = await mkdtemp(join(tmpdir(), "xi-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "index.md"), `---\nid: ${uuid(53)}\nslug: evil\nowner_id: ${alice.id}\nvisibility: public\n---\n`);
  await mkdir(join(root, "generators", "evil"));
  await symlink(join(outside, "index.md"), join(root, "generators", "evil", "index.md"));

  let graph = await repo.authorizedGraph(alice);
  const bySlug = new Map(graph.generators.map((g) => [g.slug, g]));
  assert.deepEqual([...bySlug.keys()].sort(), ["mercatus", "politiks", "politiks.france.elections", "sciencia"]);
  assert.equal(bySlug.get("politiks.france.elections")!.parentId, G.politiks);
  assert.equal(bySlug.get("sciencia")!.id, G.sciencia);
  assert.equal(bySlug.get("mercatus")!.parentId, null);

  // A new intermediate level becomes the nearest parent; removing a duplicate's winner lets the next file take over.
  await generator(root, "politiks.france", { id: G.france });
  await rm(join(root, "generators", "sciencia"), { recursive: true });
  graph = await repo.authorizedGraph(alice);
  const after = new Map(graph.generators.map((g) => [g.slug, g]));
  assert.equal(after.get("politiks.france.elections")!.parentId, G.france);
  assert.equal(after.get("politiks.france")!.parentId, G.politiks);
  assert.equal(after.get("sciencia")!.id, uuid(50));
});

test("generator visibility: owner or public, followers owner-only, unreadable ancestor hides the subtree", async (t) => {
  const { root, repo, cleanup } = await setup();
  t.after(cleanup);
  await generator(root, "politiks", { id: G.politiks, visibility: "private" });
  await generator(root, "politiks.france", { id: G.france });
  await generator(root, "politiks.france.elections", { id: G.elections });
  await generator(root, "sciencia", { id: G.sciencia, visibility: "followers" });
  await generator(root, "mercatus", { id: G.mercatus, owner: bob.id, visibility: "private" });
  const slugs = async (viewer: { id: string }) => (await repo.authorizedGraph(viewer)).generators.map((g) => g.slug).sort();
  assert.deepEqual(await slugs(alice), ["politiks", "politiks.france", "politiks.france.elections", "sciencia"]);
  assert.deepEqual(await slugs(bob), ["mercatus"]);
  await generator(root, "politiks", { id: G.politiks, visibility: "public" });
  assert.deepEqual(await slugs(bob), ["mercatus", "politiks", "politiks.france", "politiks.france.elections"]);
});

test("belongs_to: generator kept only when visible to the viewer and readable by the author", async (t) => {
  const { root, repo, cleanup } = await setup();
  t.after(cleanup);
  await generator(root, "politiks", { id: G.politiks });
  await generator(root, "sciencia", { id: G.sciencia, visibility: "private" });
  await publication(root, { id: uuid(100), generator: G.politiks });
  await publication(root, { id: uuid(101), generator: G.sciencia });
  await publication(root, { id: uuid(102), author: bob.id, generator: G.sciencia });
  await publication(root, { id: uuid(103), generator: uuid(999) });
  await publication(root, { id: uuid(104), generator: "pas-un-uuid" });
  await publication(root, { id: uuid(105) });
  const generatorOf = async (viewer: { id: string }) =>
    Object.fromEntries((await repo.authorizedGraph(viewer)).publications.map((p) => [p.id, p.generatorId]));
  assert.deepEqual(await generatorOf(alice), {
    [uuid(100)]: G.politiks, [uuid(101)]: G.sciencia, [uuid(102)]: null, [uuid(103)]: null, [uuid(104)]: null, [uuid(105)]: null,
  });
  // Bob cannot see sciencia: alice's publication is readable but shown unassigned.
  assert.equal((await generatorOf(bob))[uuid(101)], null);
  const pub = (await repo.authorizedGraph(alice)).publications.find((p) => p.id === uuid(100))!;
  assert.equal(pub.messageCount, 2);
  assert.equal(pub.type, "thread");
  assert.equal(pub.title, `Résumé ${uuid(100).replaceAll("-", " ")}`);
});

test("relations: validated only, both endpoints indexed and readable; trash and visibility changes revoke", async (t) => {
  const { root, repo, store, cleanup } = await setup();
  t.after(cleanup);
  const a = await publication(root, { id: uuid(200) });
  await publication(root, { id: uuid(201), files: ["1_seul.md"] });
  const b = await publication(root, { id: uuid(202), author: bob.id });
  await publication(root, { id: uuid(203), author: bob.id, status: "draft" });
  await relationFile(root, relationRecord(uuid(300), `${uuid(200)}/1`, `${uuid(201)}/1`));
  await relationFile(root, relationRecord(uuid(301), `${uuid(200)}/2`, `${uuid(202)}/1`, { needsReview: true }));
  await relationFile(root, relationRecord(uuid(302), `${uuid(200)}/1`, `${uuid(202)}/2`, { status: "proposed", origin: "ai" }));
  await relationFile(root, relationRecord(uuid(303), `${uuid(200)}/1`, `${uuid(202)}/2`, { status: "rejected" }));
  await relationFile(root, relationRecord(uuid(304), `${uuid(200)}/1`, `${uuid(203)}/1`));
  await relationFile(root, relationRecord(uuid(305), `${uuid(200)}/1`, `${uuid(201)}/7`));
  await relationFile(root, relationRecord(uuid(306), `${uuid(202)}/1`, `${uuid(201)}/1`), "a-first.md");
  await relationFile(root, relationRecord(uuid(306), `${uuid(200)}/1`, `${uuid(201)}/1`, { type: "expands" }), "b-duplicate.md");
  await writeFile(join(root, "relations", "invalid.md"), "---\nid: x\n---\n");
  const ids = async (viewer: { id: string }) => (await repo.authorizedGraph(viewer)).relations.map((r) => r.id).sort();
  assert.deepEqual(await ids(alice), [uuid(300), uuid(301), uuid(306)]);
  // Bob reads his own draft: the relation towards it is his to see, not alice's.
  assert.deepEqual(await ids(bob), [uuid(300), uuid(301), uuid(304), uuid(306)]);
  const flagged = (await repo.authorizedGraph(alice)).relations.find((r) => r.id === uuid(301))!;
  assert.deepEqual(flagged, {
    id: uuid(301), type: "supports", source: `${uuid(200)}/2`, target: `${uuid(202)}/1`, sourcePublication: uuid(200),
    targetPublication: uuid(202), needsReview: true, createdAt: "2026-10-19T10:00:00.000Z",
  });
  assert.equal((await repo.authorizedGraph(alice)).relations.find((r) => r.id === uuid(306))!.target, `${uuid(201)}/1`);
  assert.equal((await repo.authorizedGraph(alice)).relations.find((r) => r.id === uuid(306))!.source, `${uuid(202)}/1`);

  // Bob's publication leaves the graph when trashed; its relation file stays in the vault.
  await store.trash(bob, uuid(202));
  assert.deepEqual(await ids(alice), [uuid(300)]);
  assert.ok((await readdir(join(root, "relations"))).includes(`${uuid(301)}.md`));
  await store.restore(bob, uuid(202));
  assert.deepEqual(await ids(alice), [uuid(300), uuid(301), uuid(306)]);

  // Making a publication private revokes its relations for others only.
  const index = join(a.dir, "index.md");
  await writeFile(index, (await readFile(index, "utf8")).replace("visibility: public", "visibility: private"));
  assert.deepEqual(await ids(bob), [uuid(306)]);
  assert.deepEqual(await ids(alice), [uuid(300), uuid(301), uuid(306)]);
  assert.ok(b.folder);
});

test("messages and describeMessages: thread order, reply_to, unreadable refs absent", async (t) => {
  const { root, repo, cleanup } = await setup();
  t.after(cleanup);
  await publication(root, { id: uuid(400), files: ["3_trois.md", "1_un.md"] });
  await publication(root, { id: uuid(401), author: bob.id, visibility: "private" });
  const list = await repo.messages(alice, uuid(400));
  assert.deepEqual(list!.map((m) => [m.ref, m.position, m.replyTo]), [[`${uuid(400)}/3`, 1, null], [`${uuid(400)}/1`, 2, `${uuid(400)}/3`]]);
  assert.equal(list![0].excerpt, "Message 3 trois.md");
  assert.equal(await repo.messages(alice, uuid(401)), null);
  assert.equal(await repo.messages(alice, uuid(499)), null);
  assert.equal(await repo.messages(alice, "../x"), null);
  assert.ok(await repo.messages(bob, uuid(401)));
  const described = await repo.describeMessages(alice, [`${uuid(400)}/1`, `${uuid(400)}/2`, `${uuid(401)}/1`, "nope"]);
  assert.deepEqual([...described.keys()], [`${uuid(400)}/1`]);
});

test("rebuild and schema version mismatch give identical results; vault files stay byte-identical", async (t) => {
  const { root, vault, db, store, repo, cleanup } = await setup();
  t.after(cleanup);
  await generator(root, "politiks", { id: G.politiks });
  await generator(root, "politiks.france", { id: G.france, extra: "# commentaire\nfoo: bar\n" });
  await publication(root, { id: uuid(500), generator: G.france });
  await publication(root, { id: uuid(501), author: bob.id, generator: G.politiks });
  await relationFile(root, relationRecord(uuid(600), `${uuid(500)}/1`, `${uuid(501)}/2`));
  const before = await snapshotFiles(root);
  const first = sorted(await repo.authorizedGraph(alice));
  assert.equal(first.relations.length, 1);
  await repo.rebuild();
  assert.deepEqual(sorted(await repo.authorizedGraph(alice)), first);
  // The store keeps working on the recreated tables.
  assert.equal((await store.page(alice, { kind: "home" })).items.length, 2);

  db.prepare("UPDATE xi_index_meta SET value = '0' WHERE key = 'schema_version'").run();
  db.prepare("DELETE FROM graph_relation").run();
  const store2 = createPublicationStore({ vault, db });
  const repo2 = createGraphRepository({ vault, db, publications: store2 });
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM publication").get() as { n: number }).n, 0);
  assert.deepEqual(sorted(await repo2.authorizedGraph(alice)), first);

  // A pre-graph database (old publication table, no meta table) is migrated by dropping the index.
  const old = new Database(":memory:");
  old.exec("CREATE TABLE publication (id TEXT PRIMARY KEY, author_id TEXT NOT NULL); CREATE TABLE user (id TEXT PRIMARY KEY); INSERT INTO user VALUES ('u')");
  const repo3 = createGraphRepository({ vault, db: old, publications: createPublicationStore({ vault, db: old }) });
  assert.deepEqual(sorted(await repo3.authorizedGraph(alice)), first);
  assert.equal((old.prepare("SELECT COUNT(*) AS n FROM user").get() as { n: number }).n, 1);

  assert.deepEqual(await snapshotFiles(root), before);
});

test("index follows external edits: removed generator, renamed relation file, cache invalidation", async (t) => {
  const { root, repo, cleanup } = await setup();
  t.after(cleanup);
  await generator(root, "politiks", { id: G.politiks });
  await publication(root, { id: uuid(700), generator: G.politiks });
  await publication(root, { id: uuid(701) });
  await relationFile(root, relationRecord(uuid(800), `${uuid(700)}/1`, `${uuid(701)}/1`));
  const graph = await repo.authorizedGraph(alice);
  graph.relations.length = 0;
  assert.equal((await repo.authorizedGraph(alice)).relations.length, 1);
  await rename(join(root, "relations", `${uuid(800)}.md`), join(root, "relations", "renamed.md"));
  assert.deepEqual((await repo.authorizedGraph(alice)).relations.map((r) => r.id), [uuid(800)]);
  await rm(join(root, "generators", "politiks"), { recursive: true });
  const after = await repo.authorizedGraph(alice);
  assert.equal(after.generators.length, 0);
  assert.equal(after.publications.find((p) => p.id === uuid(700))!.generatorId, null);
});

test("message numbers are never reused, even after removal", async (t) => {
  const { root, store, repo, cleanup } = await setup();
  t.after(cleanup);
  const id = await store.create(alice);
  let draft = await store.getEditable(alice, id);
  const first = await store.save(alice, id, {
    baseRevision: draft.revision, summary: "", visibility: "public",
    messages: [{ key: "a", file: null, body: "Premier" }, { key: "b", file: null, body: "Second" }],
  });
  assert.ok(first.ok);
  draft = first.snapshot;
  const second = await store.save(alice, id, { baseRevision: draft.revision, summary: "", visibility: "public", messages: [{ key: "a", file: "1_premier.md", body: "Premier" }] });
  assert.ok(second.ok);
  const third = await store.save(alice, id, {
    baseRevision: second.snapshot.revision, summary: "", visibility: "public",
    messages: [{ key: "a", file: "1_premier.md", body: "Premier" }, { key: "c", file: null, body: "Troisième" }],
  });
  assert.ok(third.ok);
  assert.equal(third.files.c, "3_troisieme.md");
  assert.deepEqual((await repo.messages(alice, id))!.map((m) => m.ref), [`${id}/1`, `${id}/3`]);
  assert.ok((await readdir(join(root, "posts", ".trash", alice.id, id, "removed-messages")))[0].endsWith("_2_second.md"));
});

test("relation writes: human authorship rule, AI proposals only, no change to validated relations", async (t) => {
  const { root, repo, writer, cleanup } = await setup();
  t.after(cleanup);
  await generator(root, "mercatus", { id: G.mercatus });
  await generator(root, "sciencia", { id: G.sciencia, owner: bob.id, visibility: "private" });
  await publication(root, { id: uuid(900) });
  await publication(root, { id: uuid(901), author: bob.id });
  await publication(root, { id: uuid(902), author: bob.id, visibility: "private" });
  const human = (user: { id: string }): HumanActor => ({ kind: "human", userId: user.id });
  const ai = { kind: "ai" as const, generatorId: G.mercatus };
  const s = `${uuid(900)}/1`;
  const target = `${uuid(901)}/2`;

  await assert.rejects(writer.createRelation(human(bob), { type: "supports", source: s, target }), code("forbidden"));
  await assert.rejects(writer.createRelation(human(alice), { type: "supports", source: s, target: `${uuid(902)}/1` }), code("not_found"));
  await assert.rejects(writer.createRelation(human(alice), { type: "supports", source: s, target: `${uuid(901)}/9` }), code("not_found"));
  await assert.rejects(writer.createRelation(human(alice), { type: "supports", source: s, target: s }), code("invalid"));
  await assert.rejects(writer.createRelation(human(alice), { type: "likes" as "supports", source: s, target }), code("invalid"));

  const validated = await writer.createRelation(human(alice), { type: "supports", source: s, target, note: "Note." });
  assert.equal(validated.status, "validated");
  assert.equal(validated.validatedBy, alice.id);
  await assert.rejects(writer.createRelation(human(alice), { type: "supports", source: s, target }), code("invalid"));
  assert.deepEqual((await repo.authorizedGraph(bob)).relations.map((r) => r.id), [validated.id]);

  const proposal = await writer.createRelation(ai, { type: "expands", source: target, target: s });
  assert.equal(proposal.status, "proposed");
  assert.equal(proposal.origin, "ai");
  assert.equal(proposal.createdBy, G.mercatus);
  assert.equal((await repo.authorizedGraph(alice)).relations.length, 1);
  // An AI never reads beyond its generator's owner, and needs an existing generator.
  await assert.rejects(writer.createRelation(ai, { type: "expands", source: s, target: `${uuid(902)}/1` }), code("not_found"));
  await assert.rejects(writer.createRelation({ kind: "ai", generatorId: uuid(12345) }, { type: "expands", source: s, target }), code("not_found"));

  // AI: may flag needs_review on a validated relation (status untouched), never clear it nor review.
  const flagged = await writer.setNeedsReview(ai, validated.id, true);
  assert.equal(flagged.status, "validated");
  assert.equal(flagged.needsReview, true);
  await assert.rejects(writer.setNeedsReview(ai, validated.id, false), code("forbidden"));
  await assert.rejects(writer.reviewRelation(ai as unknown as HumanActor, proposal.id, "rejected"), code("forbidden"));
  assert.equal((await repo.authorizedGraph(alice)).relations[0].needsReview, true);
  await assert.rejects(writer.setNeedsReview(human(bob), validated.id, false), code("forbidden"));
  assert.equal((await writer.setNeedsReview(human(alice), validated.id, false)).needsReview, false);

  // Review: only the source's author, only proposals; unknown keys and the note survive.
  const file = join(root, "relations", `${proposal.id}.md`);
  await writeFile(file, (await readFile(file, "utf8")).replace("status: proposed", "status: proposed\nconfidence: 0.4"));
  await assert.rejects(writer.reviewRelation(human(alice), proposal.id, "validated"), code("forbidden"));
  const accepted = await writer.reviewRelation(human(bob), proposal.id, "validated");
  assert.equal(accepted.status, "validated");
  assert.equal(accepted.validatedBy, bob.id);
  assert.match(await readFile(file, "utf8"), /confidence: 0.4/);
  await assert.rejects(writer.reviewRelation(human(bob), proposal.id, "rejected"), code("invalid"));
  await assert.rejects(writer.reviewRelation(human(bob), validated.id, "rejected"), code("forbidden"));
  assert.equal((await repo.authorizedGraph(alice)).relations.length, 2);
  await assert.rejects(writer.reviewRelation(human(alice), uuid(4242), "validated"), code("not_found"));
  assert.equal("deleteRelation" in writer, false);

  const rejected = await writer.createRelation(ai, { type: "contradicts", source: target, target: s });
  const decided = await writer.reviewRelation(human(bob), rejected.id, "rejected");
  assert.equal(decided.status, "rejected");
  assert.match(await readFile(join(root, "relations", `${rejected.id}.md`), "utf8"), new RegExp(`rejected_by: ${bob.id}`));
  assert.equal((await repo.authorizedGraph(alice)).relations.length, 2);
  assert.equal(validated.id.length, 36);
  assert.deepEqual((await readFile(join(root, "relations", `${validated.id}.md`), "utf8")).trimEnd().split("\n").at(-1), "Note.");
});
