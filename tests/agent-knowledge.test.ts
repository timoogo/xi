import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { openVault } from "../src/lib/publications/vault";
import { createTopicStore } from "../src/lib/topics/store";
import { createTopicRelationStore } from "../src/lib/topics/relations";
import { createJobQueue } from "../src/lib/watch/jobs";
import { KNOWLEDGE_TASK } from "../src/lib/konstruktor/knowledge";
import { createKnowledgePipelines } from "../src/lib/konstruktor/pipelines";
import { systemTask } from "../src/lib/system-agents/tasks";

test("Konstruktor enrichit les topics privés à partir de citations, sans doublons ni fuite", async t => {
  const path = await mkdtemp(join(tmpdir(), "xi-knowledge-"));
  const db = new Database(":memory:");
  t.after(async () => { db.close(); await rm(path, { recursive: true, force: true }); });
  const vault = await openVault(path);
  const topics = createTopicStore({ vault, db });
  const id = randomUUID(), agent = randomUUID();
  const quote = "La mission Perseverance observe la région Tinga.";
  const publication = { id, authorId: agent, status: "published", revision: "revision-1", contentRevision: "revision-1", summary: "", messages: [{ body: quote }], sources: [] };
  const publications = { ensureIndexed: async () => {}, agentPublications: () => [{ id, test: false }], get: async () => publication };
  const accounts = { watchAgents: async () => [{ id: agent, owner: "alice" }] };
  const relations = createTopicRelationStore({ vault, db, topics, readable: async viewer => viewer === "alice" ? new Set([id]) : new Set() });
  const answer = { concepts: [{ name: "Perseverance" }, { name: "Tinga" }, { name: "Imaginaire" }], relations: [{ from: "Perseverance", link: "observe la région", to: "Tinga", type: "related_to", confidence: 0.8 }] };
  const llm = () => ({ ok: true, resolved: { model: "local" }, inference: { complete: async () => JSON.stringify(answer) } });
  const services = { db, topics, accounts, publications, relations };
  const queue = createJobQueue(db);
  assert.equal(systemTask("konstruktor", "publication-knowledge"), KNOWLEDGE_TASK);
  const pipelines = createKnowledgePipelines({ db, accounts: accounts as never, publications: publications as never, systemAgents: { get: async () => ({ enabled: true }) } as never, queue });
  assert.equal(await pipelines.planAutomatic(), 1);
  assert.equal(await pipelines.planAutomatic(), 0);
  const context = { owner: "alice", input: { publication: id, agent, revision: publication.contentRevision }, services, llm, log: () => {} } as never;
  await KNOWLEDGE_TASK.run(context);
  await KNOWLEDGE_TASK.run(context);
  const mine = await topics.visible("alice"), other = await topics.visible("bob");
  assert.equal(mine.personal.length, 2);
  assert.equal(other.personal.length, 0);
  assert.equal((db.prepare("SELECT count(*) AS n FROM xi_agent_knowledge").get() as { n: number }).n, 2);
  assert.ok((db.prepare("SELECT excerpt FROM xi_agent_knowledge").all() as { excerpt: string }[]).every(row => row.excerpt === quote));
  const proposals = await relations.relationsOf("alice", mine.personal[0].id);
  assert.equal(proposals.proposed.length, 1);
  assert.equal(proposals.proposed[0].evidence[0].publication, id);
  assert.equal(proposals.proposed[0].status, "proposed");
  await assert.rejects(relations.relationsOf("bob", mine.personal[0].id));
  const different = { ...publication, id: randomUUID(), revision: "revision-2", contentRevision: "revision-2", messages: [{ body: "Perseverance, Tinga." }] };
  const weakServices = { ...services, publications: { ...publications, get: async () => different } };
  const weakAnswer = { concepts: [{ name: "Perseverance" }, { name: "Tinga" }], relations: [{ from: "Perseverance", link: ",", to: "Tinga", type: "influences", confidence: 0.9 }] };
  await KNOWLEDGE_TASK.run({ owner: "alice", input: { publication: different.id, agent, revision: different.contentRevision }, services: weakServices, llm: () => ({ ok: true, resolved: { model: "local" }, inference: { complete: async () => JSON.stringify(weakAnswer) } }), log: () => {} } as never);
  assert.equal((await relations.relationsOf("alice", mine.personal[0].id)).proposed.length, 1);
});

test("les contributions et citations privées ne sont lisibles que par le propriétaire", async t => {
  const { createAccountStore } = await import("../src/lib/accounts/store");
  const { createPublicationStore } = await import("../src/lib/publications/store");
  const path = await mkdtemp(join(tmpdir(), "xi-knowledge-private-"));
  const db = new Database(":memory:");
  t.after(async () => { db.close(); await rm(path, { recursive: true, force: true }); });
  const vault = await openVault(path), topics = createTopicStore({ vault, db });
  const accounts = createAccountStore({ vault, db, topics });
  const publications = createPublicationStore({ vault, db });
  const run = await topics.propose("alice", "Astronomie");
  await topics.confirm("alice", run.id, { tag: "astronomie", name: "Astronomie", description: "", scope: "Astronomie", parentId: null, relatedIds: [] }, true);
  const proposed = await accounts.propose("alice", run.topicId), ready = await accounts.resume("alice", proposed.id);
  await accounts.confirm("alice", ready.id, ready.draft, true);
  const agent = ready.accountId, id = randomUUID();
  const draft = await publications.saveWatchDraft("alice", agent, { id, summary: "La mission Perseverance observe Tinga.", topicIds: [run.topicId], messages: [{ body: "La mission Perseverance observe Tinga.", sources: [0] }], sources: [{ url: "https://nasa.example/article", title: "NASA", publisher: "NASA", accessedAt: "2026-01-01", facts: ["Mission"], reservations: [] }], watch: {} });
  const result = await publications.reviewWatchDraft({ id: "alice" }, agent, id, { action: "approve", revision: draft.revision });
  assert.ok(result.ok);
  const privateTopic = await topics.openPersonal("alice", "perseverance");
  const { migrateAgentKnowledge } = await import("../src/lib/konstruktor/knowledge");
  migrateAgentKnowledge(db);
  db.prepare("INSERT INTO xi_agent_knowledge VALUES (?, ?, ?, ?, ?, ?)").run("alice", agent, id, result.snapshot.contentRevision, privateTopic.topic.id, "La mission Perseverance observe Tinga.");
  assert.equal((await publications.agentContributions("alice", [agent])).find(row => row.topic_id === privateTopic.topic.id)?.count, 1);
  assert.equal((await publications.agentContributions("bob", [agent])).length, 0);
  assert.equal((await publications.agentKnowledgeSources("alice", privateTopic.topic.id))[0].publication, id);
  assert.equal((await publications.agentKnowledgeSources("bob", privateTopic.topic.id)).length, 0);
});

test("concepts existants réutilisés, relations exclues ou corrigées jamais reproposées, aucune tâche pour autrui", async t => {
  const path = await mkdtemp(join(tmpdir(), "xi-knowledge-dedup-"));
  const db = new Database(":memory:");
  t.after(async () => { db.close(); await rm(path, { recursive: true, force: true }); });
  const vault = await openVault(path);
  const topics = createTopicStore({ vault, db });
  const existing = (await topics.openPersonal("alice", "perseverance")).topic;
  const agent = randomUUID();
  const quote = "La mission Perseverance a capturé une image de la région Tinga en mars, selon NASA.";
  let current = { id: randomUUID(), authorId: agent, status: "published", revision: "r1", contentRevision: "r1", summary: "", messages: [{ body: quote }], sources: [{ url: "https://nasa.example" }] };
  const publications = { ensureIndexed: async () => {}, agentPublications: () => [], get: async (viewer: { id: string }) => { if (viewer.id !== "alice") throw new Error("Publication indisponible."); return current; } };
  const accounts = { watchAgents: async () => [{ id: agent, owner: "alice" }] };
  const relations = createTopicRelationStore({ vault, db, topics, readable: async viewer => viewer === "alice" ? new Set([current.id]) : new Set() });
  const services = { db, topics, accounts, publications, relations };
  const relation = (type: string) => ({ from: "PERSEVERANCE", link: "a capturé une image de la région", to: "Tinga", type, confidence: 0.8 });
  const answer = (type: string) => ({ concepts: [{ name: "PERSEVERANCE" }, { name: "perseverance" }, { name: "Tinga" }, { name: "NASA" }], relations: [relation(type)] });
  const run = (type: string, owner = "alice") => KNOWLEDGE_TASK.run({ owner, input: { publication: current.id, agent, revision: current.contentRevision }, services, llm: () => ({ ok: true, resolved: { model: "local" }, inference: { complete: async () => JSON.stringify(answer(type)) } }), log: () => {} } as never);

  assert.deepEqual(await run("related_to"), { outcome: "done", concepts: 3, reused: 1, created: 2, ignored: 0, relations: 1, kept: 0 });
  const mine = await topics.visible("alice");
  assert.deepEqual(mine.personal.map(topic => topic.tag).sort(), ["nasa", "perseverance", "tinga"]);
  assert.ok(mine.personal.some(topic => topic.id === existing.id), "le topic existant est réutilisé, sans doublon de casse");
  const [proposed] = (await relations.relationsOf("alice", existing.id)).proposed;
  assert.equal(proposed.type, "related_to");

  // Human decisions: exclusion of the pair, then a later publication proposing it again, with any type.
  await relations.correct("alice", proposed.id, { status: "excluded", reason: "Pas pertinent." });
  current = { ...current, id: randomUUID(), revision: "r2", contentRevision: "r2" };
  await run("related_to"); await run("part_of");
  let view = await relations.relationsOf("alice", existing.id);
  assert.equal(view.proposed.length, 0);
  assert.equal(view.excluded.length, 1);
  assert.equal(view.excluded[0].evidence.length, 1, "une exclusion n’absorbe pas silencieusement de nouvelles preuves");

  // A type correction is not undone by a later analysis proposing the original type.
  await relations.correct("alice", proposed.id, { status: "accepted", type: "influences" });
  current = { ...current, id: randomUUID(), revision: "r3", contentRevision: "r3" };
  await run("related_to");
  view = await relations.relationsOf("alice", existing.id);
  assert.equal(view.proposed.length, 0);
  assert.deepEqual([...view.visible, ...view.hidden].map(item => item.type), ["influences"]);

  // A task for another user's agent or publication creates nothing for anyone.
  await assert.rejects(run("related_to", "bob"), /ΞAgent indisponible/);
  assert.equal((await topics.visible("bob")).personal.length, 0);
  assert.equal((db.prepare("SELECT count(*) AS n FROM xi_agent_knowledge WHERE owner != 'alice'").get() as { n: number }).n, 0);
});
