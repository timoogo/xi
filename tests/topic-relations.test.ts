import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import Database from "better-sqlite3";
import { openVault } from "../src/lib/publications/vault";
import { AUTO_ACCEPT_CONFIDENCE, createTopicRelationStore, type TopicRelations } from "../src/lib/topics/relations";
import { createTopicStore } from "../src/lib/topics/store";

async function setup(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "xi-topic-relations-"));
  const vault = await openVault(root);
  const db = new Database(":memory:");
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  const topics = createTopicStore({ vault, db });
  const relations = createTopicRelationStore({ vault, db, topics });
  const topic = async (owner: string, tag: string, extra: { parentId?: string; relatedIds?: string[] } = {}) =>
    (await topics.create(owner, randomUUID(), { tag, name: tag, description: "", scope: `Scope ${tag}`, parentId: extra.parentId ?? null, relatedIds: extra.relatedIds ?? [] })).topic;
  const transport = await topic("alice", "transport");
  const energy = await topic("alice", "energie");
  const climate = await topic("carol", "climat");
  const rail = await topic("carol", "transport.rail", { parentId: transport.id });
  const urban = await topic("alice", "urbanisme", { relatedIds: [transport.id] });
  return { root, vault, db, topics, relations, transport, energy, climate, rail, urban };
}
const others = (r: TopicRelations, key: keyof TopicRelations = "visible") => r[key].map(v => `${v.kind}:${v.type}:${v.direction}:${v.other.tag}`).sort();
const evidence = (ref: string) => [{ kind: "publication" as const, ref, excerpt: "Le report modal vers le rail réduit la consommation d’énergie." }];

test("existing hierarchy and declared relations are read as relations, both ways, without copying them", async t => {
  const { root, relations, transport, urban, rail } = await setup(t);
  assert.deepEqual(others(await relations.relationsOf("bob", transport.id)), [
    "declared:related_to:symmetric:urbanisme", "hierarchy:parent:incoming:transport.rail",
  ]);
  const fromUrban = await relations.relationsOf("bob", urban.id);
  assert.deepEqual(others(fromUrban), ["declared:related_to:symmetric:transport"]);
  assert.equal(fromUrban.visible[0].origin, "declared");
  assert.match(fromUrban.visible[0].justification, /créateur/);
  assert.deepEqual(others(await relations.relationsOf("bob", rail.id)), ["hierarchy:parent:outgoing:transport"]);
  await assert.rejects(readdir(join(root, "topic-relations")).then(names => names.length ? names : Promise.reject(new Error("empty"))));
});

test("human relations: shared for an endpoint's creator, private otherwise; symmetric types deduplicated", async t => {
  const { root, relations, transport, energy, climate } = await setup(t);
  const shared = await relations.create("alice", { source: transport.id, target: energy.id, type: "part_of", justification: "L’énergie des transports." });
  assert.equal(shared.owner, undefined);
  assert.deepEqual(await readdir(join(root, "topic-relations")).then(n => n.filter(x => x.endsWith(".md"))), [`${shared.id}.md`]);
  const forBob = await relations.relationsOf("bob", energy.id);
  assert.deepEqual(others(forBob), ["recorded:part_of:incoming:transport"]);
  assert.deepEqual([forBob.visible[0].origin, forBob.visible[0].createdBy, forBob.visible[0].canManage], ["human", "alice", false]);

  const a = await relations.create("alice", { source: energy.id, target: transport.id, type: "related_to", justification: "Lien." });
  const b = await relations.create("alice", { source: transport.id, target: energy.id, type: "related_to", justification: "Lien." });
  assert.equal(a.id, b.id);

  // Bob created neither topic: his relation is his own.
  const mine = await relations.create("bob", { source: climate.id, target: transport.id, type: "influences", justification: "Avis personnel." });
  assert.equal(mine.owner, "bob");
  assert.ok((await readdir(join(root, ".xi-personal-topics", "bob", "relations"))).includes(`${mine.id}.md`));
  assert.deepEqual(others(await relations.relationsOf("bob", climate.id)), ["recorded:influences:outgoing:transport"]);
  assert.deepEqual(others(await relations.relationsOf("alice", climate.id)), []);
  assert.equal((await relations.relationsOf("bob", climate.id)).visible[0].scope, "personal");
  await assert.rejects(relations.create("bob", { source: climate.id, target: climate.id, type: "related_to", justification: "Soi." }), /distincts/);
  await assert.rejects(relations.create("bob", { source: climate.id, target: transport.id, type: "causes", justification: "x" }));
});

test("automatic relations need substantive provenance; indices alone never establish one", async t => {
  const { relations, topics, transport, energy, climate } = await setup(t);
  const base = { source: transport.id, target: energy.id, type: "influences", origin: "inference", createdBy: "local-model:qwen", justification: "Plusieurs publications relient explicitement le rail et l’énergie." } as const;
  await assert.rejects(relations.propose({ ...base, confidence: 0.95, evidence: [{ kind: "cooccurrence", ref: "publication-x" }, { kind: "shared_word", ref: "transport" }, { kind: "shared_agent", ref: randomUUID() }] }), /substantielle/);
  await assert.rejects(relations.propose({ ...base, confidence: 0.95, justification: "Trop court.", evidence: evidence("p1") }), /courte/);
  await assert.rejects(relations.propose({ ...base, confidence: 0.95, evidence: [{ kind: "publication", ref: "p1" }] }), /substantielle/);

  const accepted = await relations.propose({ ...base, confidence: AUTO_ACCEPT_CONFIDENCE, evidence: evidence("p1") });
  assert.deepEqual([accepted.status, accepted.origin, accepted.createdBy], ["accepted", "inference", "local-model:qwen"]);
  assert.equal((await relations.propose({ ...base, confidence: 0.99, evidence: evidence("p9") })).id, accepted.id, "idempotent");
  const proposed = await relations.propose({ ...base, target: climate.id, type: "related_to", origin: "agent", createdBy: randomUUID(), confidence: 0.5, evidence: evidence("p2") });
  assert.equal(proposed.status, "proposed");
  // Proposals are only shown to those who can validate them (creators of an endpoint).
  assert.equal((await relations.relationsOf("bob", climate.id)).proposed.length, 0);
  assert.equal((await relations.relationsOf("carol", climate.id)).proposed.length, 1);
  assert.equal((await relations.relationsOf("alice", transport.id)).proposed[0].confidence, 0.5);

  const { topic: personal } = await topics.openPersonal("alice", "essence");
  await assert.rejects(relations.propose({ ...base, target: personal.id, confidence: 0.9, evidence: evidence("p3") }), /introuvable/);
});

test("corrections and exclusions: global by endpoint creators, personal for anyone, traced and durable", async t => {
  const { root, vault, relations, transport, energy, urban } = await setup(t);
  const base = { source: transport.id, target: energy.id, type: "influences", origin: "inference", createdBy: "local-model", confidence: 0.9, justification: "Plusieurs publications relient explicitement le rail et l’énergie." } as const;
  const relation = await relations.propose({ ...base, evidence: evidence("p1") });

  await assert.rejects(relations.correct("bob", relation.id, { status: "excluded" }), /créateur/);
  const corrected = await relations.correct("alice", relation.id, { type: "related_to", reason: "Pas de causalité établie." });
  assert.deepEqual([corrected.type, corrected.source < corrected.target], ["related_to", true]);
  assert.deepEqual(corrected.history.at(-1), { at: corrected.updatedAt, by: "alice", action: "type_changed", from: "influences", to: "related_to", reason: "Pas de causalité établie." });
  const excluded = await relations.correct("alice", relation.id, { status: "excluded", reason: "Hors sujet." });
  assert.equal(excluded.status, "excluded");
  assert.deepEqual(others(await relations.relationsOf("bob", energy.id)), []);
  assert.equal((await relations.relationsOf("alice", energy.id)).excluded.length, 1);

  // Never reintroduced from the same evidence; new evidence only reopens a proposal, never an accepted relation.
  await assert.rejects(relations.propose({ ...base, confidence: 0.99, evidence: evidence("p1") }), /exclue/);
  await assert.rejects(relations.propose({ ...base, type: "related_to", confidence: 0.99, evidence: [...evidence("p1"), { kind: "cooccurrence", ref: "p7" }] }), /exclue/);
  const reopened = await relations.propose({ ...base, confidence: 0.99, evidence: evidence("p2") });
  assert.equal(reopened.status, "proposed");
  assert.equal(reopened.history[0].action, "reproposed");

  // Personal exclusion of a declared relation: hidden for bob only, restorable, history kept on disk.
  const declared = (await relations.relationsOf("bob", urban.id)).visible[0];
  await relations.hide("bob", declared.id, true);
  await relations.hide("bob", declared.id, true);
  assert.deepEqual([(await relations.relationsOf("bob", urban.id)).visible.length, (await relations.relationsOf("bob", urban.id)).hidden.length], [0, 1]);
  assert.equal((await relations.relationsOf("carol", urban.id)).visible.length, 1);
  await relations.hide("bob", declared.id, false);
  assert.equal((await relations.relationsOf("bob", urban.id)).visible.length, 1);
  const trace = await readFile(join(root, ".xi-personal-topics", "bob", "relation-exclusions.md"), "utf8");
  assert.match(trace, /restoredAt/);
  await assert.rejects(relations.hide("bob", randomUUID(), true), /introuvable/);
  await assert.rejects(relations.hide("bob", relation.id, true), /introuvable/, "an excluded relation is already invisible to bob");

  // Durable across a full index rebuild and a fresh process.
  const db2 = new Database(":memory:");
  t.after(() => db2.close());
  const fresh = createTopicRelationStore({ vault, db: db2, topics: createTopicStore({ vault, db: db2 }) });
  await fresh.hide("bob", declared.id, true);
  assert.deepEqual([(await fresh.relationsOf("bob", urban.id)).hidden.length, (await fresh.relationsOf("alice", energy.id)).excluded.length], [1, 1]);
  assert.equal((db2.prepare("SELECT COUNT(*) AS n FROM topic_relation").get() as { n: number }).n, 2);
  db2.exec("DELETE FROM topic_relation");
  assert.equal((await fresh.relationsOf("alice", energy.id)).excluded.length, 1);
  assert.equal((await fresh.relationsOf("alice", energy.id)).proposed.length, 1);
});

test("relations touching a personal topic never reveal it to anyone else", async t => {
  const { root, db, topics, relations, transport } = await setup(t);
  const { topic: personal } = await topics.openPersonal("alice", "essence");
  // Alice created `transport`, but a relation to her personal topic can only be personal.
  const relation = await relations.create("alice", { source: transport.id, target: personal.id, type: "related_to", justification: "Mon usage." });
  assert.equal(relation.owner, "alice");
  assert.deepEqual(others(await relations.relationsOf("alice", transport.id)).filter(x => x.startsWith("recorded")), ["recorded:related_to:symmetric:essence"]);
  assert.deepEqual(others(await relations.relationsOf("bob", transport.id)).filter(x => x.startsWith("recorded")), []);
  await assert.rejects(relations.relationsOf("bob", personal.id), /introuvable/);
  await assert.rejects(relations.hide("bob", relation.id, true), /introuvable/);
  await assert.rejects(relations.correct("bob", relation.id, { status: "excluded" }), /introuvable/);
  await assert.rejects(relations.create("bob", { source: transport.id, target: personal.id, type: "related_to", justification: "Essai." }), /introuvable/);
  const sharedFiles = await readdir(join(root, "topic-relations")).catch(() => [] as string[]);
  for (const name of sharedFiles.filter(n => n.endsWith(".md"))) assert.ok(!(await readFile(join(root, "topic-relations", name), "utf8")).includes(personal.id));
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM topic_relation WHERE source = ? OR target = ?").get(personal.id, personal.id) as { n: number }).n, 0);
  assert.deepEqual((await topics.list()).map(t => t.tag).includes("essence"), false, "never promoted");
});
