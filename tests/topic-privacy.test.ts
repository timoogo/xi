import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import Database from "better-sqlite3";
import { createPublicationStore } from "../src/lib/publications/store";
import { openVault } from "../src/lib/publications/vault";
import { createTopicDiscovery, DISCOVERY_JOB } from "../src/lib/topics/discovery";
import { createTopicRelationStore, WITHHELD_JUSTIFICATION } from "../src/lib/topics/relations";
import { createTopicStore } from "../src/lib/topics/store";
import type { Inference } from "../src/lib/watch/inference";
import { createJobQueue } from "../src/lib/watch/jobs";
import type { LLMBinding } from "../src/lib/watch/llm-binding";
import { drainJobs } from "../src/lib/watch/worker";

// Lot 5 privacy fix: evidence and excerpts follow the publication's current permissions, everywhere they surface.
const QUOTE = "Le prix de l’énergie influence fortement les transports et fait monter le coût du rail.";
const SECRET = "Le stockage par hydrogène vert change la donne.";
const JUSTIFICATION = "La phrase affirme que le prix de l’énergie agit sur les transports.";

async function setup(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "xi-topic-privacy-"));
  const vault = await openVault(root);
  const db = new Database(":memory:");
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  const topics = createTopicStore({ vault, db });
  const publications = createPublicationStore({ vault, db });
  const relations = createTopicRelationStore({ vault, db, topics, readable: publications.readableIds });
  const make = async (tag: string, name: string) => (await topics.create("alice", randomUUID(), { tag, name, description: "", scope: name, parentId: null, relatedIds: [] })).topic;
  const energy = await make("energie", "Énergie");
  const transport = await make("transport", "Transports");
  const inference: Inference = { complete: async () => JSON.stringify({
    concepts: [{ label: "Hydrogène vert", quote: SECRET }],
    relations: [{ from: "énergie", to: "transport", type: "influences", justification: JUSTIFICATION, quote: QUOTE, confidence: 0.95 }],
  }) };
  const discovery = createTopicDiscovery({
    vault, topics, relations, publications, autoAccept: true, ownerOf: async ({ authorId }) => authorId,
    llm: () => ({ ok: true, inference, resolved: { model: "fake-local" } }) as unknown as LLMBinding,
  });
  const queue = createJobQueue(db);
  async function analysed(author: string, host: string) {
    const viewer = { id: author };
    const id = await publications.create(viewer);
    const draft = await publications.getEditable(viewer, id);
    const saved = await publications.save(viewer, id, { baseRevision: draft.revision, summary: "", visibility: "public", messages: [{ key: "a", file: null, body: `${QUOTE} ${SECRET}` }] });
    assert.ok(saved.ok);
    let revision = saved.snapshot.revision;
    for (const i of [1, 2]) {
      const added = await publications.addSource(viewer, id, revision, { url: `https://media${i}.${host}/a`, title: `Article ${i}`, publisher: `Média ${i}`, facts: [QUOTE], reservations: [] });
      assert.ok(added.ok);
      revision = added.revision;
    }
    await publications.publish(viewer, id, revision);
    await discovery.plan(queue);
    await drainJobs({ queue, handlers: { [DISCOVERY_JOB]: discovery.handler } });
    return id;
  }
  return { root, vault, db, topics, publications, relations, discovery, queue, energy, transport, analysed };
}

/** Everything a viewer can be served about the topics, as one string, to check that no protected text leaks. */
async function served(viewer: string, s: Awaited<ReturnType<typeof setup>>) {
  return JSON.stringify([
    await s.relations.relationsOf(viewer, s.energy.id), await s.relations.relationsOf(viewer, s.transport.id),
    await s.relations.readableStructure(viewer), await s.discovery.associationsOf(s.transport.id), await s.discovery.candidates(),
  ]);
}
const recorded = (views: Awaited<ReturnType<ReturnType<typeof createTopicRelationStore>["relationsOf"]>>) => [...views.visible, ...views.proposed, ...views.excluded].filter(v => v.kind === "recorded");
const inferredRows = (db: Database.Database, id: string) => (db.prepare("SELECT COUNT(*) AS n FROM publication_topic WHERE publication_id = ? AND origin = 'inferred'").get(id) as { n: number }).n;

test("public → private: evidence, justification, associations and candidates disappear for other accounts", async t => {
  const s = await setup(t);
  const id = await s.analysed("dave", "example");
  // While public: another account sees the relation, its justification, its evidence and the concept.
  const before = await served("bob", s);
  for (const text of [QUOTE, SECRET, JUSTIFICATION]) assert.ok(before.includes(text), text);
  const [relation] = recorded(await s.relations.relationsOf("bob", s.energy.id));
  assert.equal(relation.status, "accepted");
  assert.equal((await s.relations.readableStructure("bob")).length, 1);
  assert.equal(inferredRows(s.db, id), 2);

  // The author makes it private: the next display checks permissions, before any worker pass.
  const viewer = { id: "dave" };
  const current = await s.publications.getEditable(viewer, id);
  const saved = await s.publications.save(viewer, id, { baseRevision: current.revision, summary: current.summary, visibility: "private", messages: current.messages.map((m, i) => ({ key: String(i), file: m.file, body: m.body })) });
  assert.ok(saved.ok);
  assert.equal(inferredRows(s.db, id), 0, "projection removed at once");
  const after = await served("bob", s);
  for (const text of [QUOTE, SECRET, JUSTIFICATION, "media1.example"]) assert.ok(!after.includes(text), text);
  assert.deepEqual(recorded(await s.relations.relationsOf("bob", s.energy.id)), []);
  assert.deepEqual(await s.relations.readableStructure("bob"), []);
  await assert.rejects(s.relations.hide("bob", relation.id, true), /introuvable/);
  await assert.rejects(s.relations.correct("bob", relation.id, { status: "excluded" }), /introuvable/, "not even a 403 revealing it");

  // The author can still read it, so it still backs the relation for them.
  assert.equal(recorded(await s.relations.relationsOf("dave", s.energy.id))[0].justification, JUSTIFICATION);

  // The topic creator keeps what history and corrections need, without the content.
  const [managed] = recorded(await s.relations.relationsOf("alice", s.energy.id));
  assert.deepEqual([managed.withheld, managed.justification, managed.type, managed.confidence], [true, WITHHELD_JUSTIFICATION, "influences", 0.9]);
  assert.ok(managed.evidence.every(e => e.withheld && e.ref === "" && !("excerpt" in e)));
  assert.ok(!JSON.stringify(managed).includes(QUOTE));
  const excluded = await s.relations.correct("alice", relation.id, { status: "excluded", reason: "Source devenue privée." });
  assert.deepEqual(excluded.history.map(h => h.action), ["created", "excluded"]);

  // The worker's next pass forgets the discovery record; nothing is re-derived from private content.
  await s.discovery.plan(s.queue);
  assert.equal(await s.discovery.read(id), null);
  assert.deepEqual(await readdir(join(s.root, "topic-discovery")), []);
  assert.equal(s.queue.counts().pending ?? 0, 0);
});

test("trash: same protection, also after a full index rebuild in a fresh database", async t => {
  const s = await setup(t);
  const id = await s.analysed("erin", "example");
  await s.publications.trash({ id: "erin" }, id);
  assert.equal(inferredRows(s.db, id), 0);
  for (const viewer of ["bob", "erin"]) {
    const out = await served(viewer, s);
    for (const text of [QUOTE, SECRET, JUSTIFICATION]) assert.ok(!out.includes(text), `${viewer}: ${text}`);
  }
  assert.equal(recorded(await s.relations.relationsOf("alice", s.energy.id))[0].withheld, true);

  // Rebuild: nothing comes back from Markdown, and the projection holds structure only.
  const db2 = new Database(":memory:");
  t.after(() => db2.close());
  const topics2 = createTopicStore({ vault: s.vault, db: db2 });
  const publications2 = createPublicationStore({ vault: s.vault, db: db2 });
  const relations2 = createTopicRelationStore({ vault: s.vault, db: db2, topics: topics2, readable: publications2.readableIds });
  const discovery2 = createTopicDiscovery({ vault: s.vault, topics: topics2, relations: relations2, publications: publications2, llm: () => ({ ok: false, code: "not-configured", message: "" }), ownerOf: async () => null });
  await discovery2.project();
  assert.equal(inferredRows(db2, id), 0);
  assert.deepEqual(recorded(await relations2.relationsOf("bob", s.energy.id)), []);
  assert.deepEqual(await relations2.readableStructure("bob"), []);
  assert.deepEqual(await discovery2.candidates(), []);
  const columns = db2.prepare<[], { name: string }>("SELECT name FROM pragma_table_info('topic_relation')").all().map(c => c.name);
  assert.deepEqual(columns, ["id", "type", "source", "target", "status", "origin", "confidence"]);
  assert.deepEqual(db2.prepare("SELECT publication_id FROM topic_relation_basis").all(), [{ publication_id: id }]);

  // Restored from the trash: public again, readable again.
  await s.publications.restore({ id: "erin" }, id);
  assert.ok((await served("bob", s)).includes(JUSTIFICATION));
});

test("each relation follows its own publications: one withheld, a later proposal from a public one readable", async t => {
  const s = await setup(t);
  const first = await s.analysed("dave", "example");
  const [relation] = recorded(await s.relations.relationsOf("bob", s.energy.id));
  // Excluded, then reproposed from a second, independent publication with new sources: a distinct relation with its own evidence.
  await s.relations.correct("alice", relation.id, { status: "excluded" });
  const second = await s.analysed("erin", "other.example");
  await s.publications.trash({ id: "dave" }, first);
  const views = recorded(await s.relations.relationsOf("alice", s.energy.id));
  const reproposed = views.find(v => v.status === "proposed")!;
  assert.deepEqual([reproposed.withheld, reproposed.justification], [false, JUSTIFICATION], "backed by the public one");
  assert.ok(reproposed.evidence.every(e => !e.withheld));
  assert.equal(views.find(v => v.status === "excluded")!.withheld, true);
  assert.ok(reproposed.evidence.some(e => e.publication === second));
});
