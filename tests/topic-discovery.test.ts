import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import Database from "better-sqlite3";
import { createLLMRuntime } from "../src/lib/llm/server";
import { createPublicationStore } from "../src/lib/publications/store";
import { openVault } from "../src/lib/publications/vault";
import { assess, createTopicDiscovery, DISCOVERY_JOB, explicitConcepts } from "../src/lib/topics/discovery";
import { createTopicRelationStore } from "../src/lib/topics/relations";
import { createTopicStore } from "../src/lib/topics/store";
import { InferenceUnavailableError, type Inference } from "../src/lib/watch/inference";
import { createJobQueue } from "../src/lib/watch/jobs";
import { bindSafely, type LLMBinding } from "../src/lib/watch/llm-binding";
import { drainJobs } from "../src/lib/watch/worker";

type Answer = { concepts: { label: string; quote: string }[]; relations: { from: string; to: string; type: string; justification: string; quote: string; confidence: number }[] };
const INFLUENCE = "Le prix de l’énergie influence fortement les transports et fait monter le coût du rail.";
const JUSTIFICATION = "La phrase affirme que le prix de l’énergie agit sur les transports.";

const draftOf = (topic: { tag: string; name: string; description: string; scope: string; parentId: string | null; relatedIds: string[] }) =>
  ({ tag: topic.tag, name: topic.name, description: topic.description, scope: topic.scope, parentId: topic.parentId, relatedIds: topic.relatedIds });

async function setup(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "xi-discovery-"));
  const vault = await openVault(root);
  const db = new Database(":memory:");
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  const topics = createTopicStore({ vault, db });
  const relations = createTopicRelationStore({ vault, db, topics });
  const publications = createPublicationStore({ vault, db });
  const topic = async (tag: string, name: string, aliases: string[] = []) => {
    const { topic } = await topics.create("alice", randomUUID(), { tag, name, description: "", scope: name, parentId: null, relatedIds: [] });
    if (!aliases.length) return topic;
    let current = topic;
    for (const alias of aliases) current = await topics.update("alice", current.id, current.revision, { ...draftOf(current), tag: alias }, true);
    return topics.update("alice", current.id, current.revision, { ...draftOf(current), tag }, true);
  };
  const transport = await topic("transport", "Transports", ["mobilite"]);
  const energy = await topic("energie", "Énergie");
  const climate = await topic("climat", "Climat");
  async function publish(author: string, body: string, { visibility = "public", sources = 0, host = "example" }: { visibility?: "public" | "private"; sources?: number; host?: string } = {}) {
    const viewer = { id: author };
    const id = await publications.create(viewer);
    const draft = await publications.getEditable(viewer, id);
    const saved = await publications.save(viewer, id, { baseRevision: draft.revision, summary: "", visibility, messages: [{ key: "a", file: null, body }] });
    assert.ok(saved.ok);
    let revision = saved.snapshot.revision;
    for (let i = 0; i < sources; i++) {
      const added = await publications.addSource(viewer, id, revision, { url: `https://media${i}.${host}/article`, title: `Article ${i}`, publisher: `Média ${i}`, facts: [INFLUENCE], reservations: [] });
      assert.ok(added.ok);
      revision = added.revision;
    }
    await publications.publish(viewer, id, revision);
    return id;
  }
  let answer: Answer = { concepts: [], relations: [] };
  let calls = 0;
  let unavailable = false;
  const inference: Inference = { complete: async () => { calls++; if (unavailable) throw new InferenceUnavailableError("Serveur d’inférence injoignable."); return JSON.stringify(answer); } };
  const bound = { ok: true, inference, resolved: { model: "fake-local" } } as unknown as LLMBinding;
  const state = { model: true };
  const discovery = (autoAccept = false) => createTopicDiscovery({
    vault, topics, relations, publications, autoAccept,
    llm: () => state.model ? bound : { ok: false, code: "not-configured", message: "Aucun modèle configuré." },
    ownerOf: async ({ authorId }) => authorId,
  });
  let clock = Date.parse("2026-10-27T10:00:00Z");
  const queue = createJobQueue(db, () => clock);
  const drain = (handler: ReturnType<typeof discovery>["handler"]) => drainJobs({ queue, handlers: { [DISCOVERY_JOB]: handler }, clock: () => clock });
  return {
    root, vault, db, topics, relations, publications, transport, energy, climate, publish, discovery, queue, drain, state,
    setAnswer: (next: Answer) => { answer = next; }, calls: () => calls, setUnavailable: (v: boolean) => { unavailable = v; }, advance: (ms: number) => { clock += ms; },
  };
}
const inferred = (db: Database.Database, id: string) => db.prepare<[string], { topic_id: string; origin: string }>("SELECT topic_id, origin FROM publication_topic WHERE publication_id = ? ORDER BY topic_id").all(id);

test("explicit concepts: tags, former tags, names and hashtags; spelling variants never duplicate a topic", async t => {
  const { transport, energy, climate } = await setup(t);
  const parts = [{ text: "Les TRANSPORTS urbains et la #mobilite changent. Énergies : la facture grimpe ; l'energie reste chère.", from: "publication:x", source: false }];
  const concepts = explicitConcepts(parts, [transport, energy, climate]);
  assert.deepEqual(concepts.map(c => [c.topicId, c.match, c.via]).sort(), [[transport.id, "explicit", "hashtag"], [energy.id, "explicit", "tag"]].sort());
  assert.match(concepts.find(c => c.topicId === transport.id)!.excerpt, /TRANSPORTS urbains/);
  assert.equal(explicitConcepts([{ text: "Rien sur #mobilite ici.", from: "x", source: false }], [transport])[0].via, "hashtag");
  assert.deepEqual(explicitConcepts([{ text: "Le transporteur et l’énergétique.", from: "x", source: false }], [transport, energy]), [], "whole terms only");
});

test("confidence calibration: positive, negative and ambiguous examples, each component assessed separately", () => {
  const keys: [string[], string[]] = [["energie"], ["transport"]];
  const positive = assess({ quote: INFLUENCE, fromSource: true, sourceCount: 2, keys, type: "influences", modelConfidence: 0.95 });
  assert.deepEqual(positive, { assessment: { sources: 0.9, evidence: 1, inference: 0.9, type: 1 }, confidence: 0.9 });
  // Mere co-occurrence: both named, no wording of influence, no source.
  const negative = assess({ quote: "L’énergie et les transports sont au programme du salon.", fromSource: false, sourceCount: 0, keys, type: "influences", modelConfidence: 0.9 });
  assert.equal(negative.assessment.type, 0.3);
  assert.equal(negative.confidence, 0.3);
  // Ambiguous: plausible wording but one topic only, one source; a confident model cannot compensate.
  const ambiguous = assess({ quote: "La hausse des prix pèse sur les transports.", fromSource: false, sourceCount: 1, keys, type: "influences", modelConfidence: 1 });
  assert.deepEqual([ambiguous.assessment.evidence, ambiguous.assessment.inference, ambiguous.confidence], [0.6, 0.9, 0.6]);
  assert.equal(assess({ quote: INFLUENCE, fromSource: false, sourceCount: 2, keys, type: "related_to", modelConfidence: 0.9 }).confidence, 0.7);
});

test("pipeline: idempotent jobs, inferred associations, justified relations only, kept proposed until calibrated", async t => {
  const { db, root, topics, relations, publications, publish, discovery, queue, drain, setAnswer, calls, transport, energy, climate } = await setup(t);
  const id = await publish("dave", `${INFLUENCE} Le climat préoccupe aussi. L’hydrogène vert arrive.`, { sources: 2 });
  const hidden = await publish("dave", "Note privée sur le climat et l’énergie.", { visibility: "private" });
  setAnswer({
    concepts: [{ label: "énergie", quote: INFLUENCE }, { label: "Hydrogène vert", quote: "L’hydrogène vert arrive." }, { label: "Licorne", quote: "Phrase absente du texte." }],
    relations: [
      { from: "Énergie", to: "transport", type: "influences", justification: JUSTIFICATION, quote: INFLUENCE, confidence: 0.95 },
      // Invented quote: never recorded.
      { from: "climat", to: "transport", type: "related_to", justification: "Le climat et les transports sont liés selon le texte.", quote: "Le climat détermine les transports.", confidence: 0.9 },
      // Too short a justification: refused by propose(), the refusal is recorded.
      { from: "climat", to: "énergie", type: "related_to", justification: "Liés.", quote: "Le climat préoccupe aussi.", confidence: 0.9 },
    ],
  });
  const store = discovery();
  assert.equal(await store.plan(queue), 1, "public content only");
  assert.equal(await store.plan(queue), 0, "idempotent planning");
  assert.deepEqual(await drain(store.handler), { done: 1, waiting: 0, retried: 0, failed: 0, lost: 0, interrupted: 0, deferred: 0 });
  assert.equal(calls(), 1);

  const record = (await store.read(id))!;
  assert.deepEqual([record.mode, record.model, record.pendingInference, record.author], ["model", "fake-local", false, "dave"]);
  const byLabel = Object.fromEntries(record.concepts.map(c => [c.label, c]));
  assert.deepEqual([byLabel["Énergie"].match, byLabel["Climat"].match, byLabel["Hydrogène vert"].topicId], ["explicit", "explicit", null]);
  assert.equal(byLabel.Licorne, undefined, "a concept needs a verbatim quote");
  assert.equal(record.concepts.filter(c => c.topicId === energy.id).length, 1, "no duplicate for the model's spelling");
  assert.deepEqual(record.relations.map(r => r.outcome), ["proposed", "refused"]);
  assert.deepEqual(inferred(db, id).map(r => r.origin), ["inferred", "inferred", "inferred"]);
  assert.equal(await store.read(hidden), null);
  assert.deepEqual(inferred(db, hidden), []);
  assert.ok((await readFile(join(root, "topic-discovery", `${id}.md`), "utf8")).includes("xi-discovery-v1"));

  // Score ≥ 0.8 but uncalibrated: proposed, with its four components and its evidence.
  const proposal = (await relations.relationsOf("alice", energy.id)).proposed[0];
  assert.deepEqual([proposal.type, proposal.origin, proposal.createdBy, proposal.confidence], ["influences", "inference", "local-model:fake-local", 0.9]);
  assert.deepEqual(proposal.assessment, { sources: 0.9, evidence: 1, inference: 0.9, type: 1 });
  assert.deepEqual(proposal.evidence.map(e => e.kind), ["source", "cooccurrence"]);
  assert.equal((await relations.relationsOf("bob", energy.id)).visible.filter(v => v.kind === "recorded").length, 0);

  // Topic page reads: inferred associations with evidence; declared feed unchanged.
  assert.deepEqual((await store.associationsOf(transport.id)).map(a => a.publicationId), [id]);
  assert.equal((await publications.page({ id: "bob" }, { kind: "search", topicIds: [climate.id], origin: "inferred" })).items.length, 1);
  assert.equal((await publications.page({ id: "bob" }, { kind: "search", topicIds: [climate.id], origin: "declared" })).items.length, 0);

  // Re-running the same content never calls the model again; no topic was created.
  await queue.enqueue({ kind: DISCOVERY_JOB, key: "again", payload: { publicationId: id } });
  await drain(store.handler);
  assert.equal(calls(), 1);
  assert.equal((await topics.list()).length, 3);
});

test("calibrated operator switch accepts only above the threshold; exclusions and corrections are respected", async t => {
  const { relations, publish, discovery, queue, drain, setAnswer, energy, transport } = await setup(t);
  setAnswer({ concepts: [], relations: [
    { from: "énergie", to: "transport", type: "influences", justification: JUSTIFICATION, quote: INFLUENCE, confidence: 0.95 },
    { from: "énergie", to: "transport", type: "similar_to", justification: "Le texte rapproche ces deux sujets dans la même phrase.", quote: INFLUENCE, confidence: 0.95 },
  ] });
  const store = discovery(true);
  const first = await publish("dave", INFLUENCE, { sources: 2 });
  await store.plan(queue);
  await drain(store.handler);
  const views = await relations.relationsOf("alice", energy.id);
  assert.deepEqual(views.visible.filter(v => v.kind === "recorded").map(v => v.type), ["influences"], "0.9 accepted");
  assert.deepEqual(views.proposed.map(v => v.type), ["similar_to"], "type incoherent: 0.3, proposed");

  // The topic creator excludes one and corrects the other; re-analysis of the same evidence changes nothing.
  const accepted = views.visible.find(v => v.kind === "recorded")!;
  await relations.correct("alice", accepted.id, { status: "excluded", reason: "Lien non établi." });
  await relations.correct("alice", views.proposed[0].id, { type: "related_to" });
  const again = await store.handler({ id: "x", kind: DISCOVERY_JOB, key: "x", payload: { publicationId: first }, state: "running", runAfter: 0, attempts: 1, maxAttempts: 3, leaseToken: null, leaseUntil: null, lastError: null, result: null, createdAt: 0, updatedAt: 0 });
  assert.deepEqual(again, { status: "done", result: { outcome: "already" } });
  // Another publication citing the same sources for the same quote brings nothing new: refused.
  const second = await publish("erin", INFLUENCE, { sources: 2 });
  await store.plan(queue);
  await drain(store.handler);
  assert.deepEqual((await store.read(second))!.relations.map(r => [r.type, r.outcome]), [["influences", "refused"], ["similar_to", "refused"]]);
  // New sources are new evidence: reopened as proposals only, never accepted again automatically.
  const third = await publish("erin", INFLUENCE, { sources: 2, host: "other.example" });
  await store.plan(queue);
  await drain(store.handler);
  assert.deepEqual((await store.read(third))!.relations.map(r => [r.type, r.outcome]), [["influences", "proposed"], ["similar_to", "proposed"]]);
  const after = await relations.relationsOf("alice", transport.id);
  assert.equal(after.visible.filter(v => v.kind === "recorded" && v.type === "influences").length, 0);
  assert.equal(after.proposed.find(v => v.type === "influences")!.history[0].action, "reproposed");
  assert.equal(after.proposed.find(v => v.type === "similar_to")!.history[0].action, "reproposed", "a corrected type is not reintroduced as is");
});

test("model unavailable: explicit terms only, nothing invented, work kept for later; resumes after a crash", async t => {
  const { db, publish, discovery, queue, drain, setAnswer, setUnavailable, state, relations, energy, advance } = await setup(t);
  setAnswer({ concepts: [], relations: [{ from: "énergie", to: "transport", type: "influences", justification: JUSTIFICATION, quote: INFLUENCE, confidence: 0.95 }] });
  const id = await publish("dave", INFLUENCE, { sources: 2 });
  const store = discovery();

  // Not configured: deterministic record, pending inference, no relation, no confidence.
  state.model = false;
  await store.plan(queue);
  await drain(store.handler);
  let record = (await store.read(id))!;
  assert.deepEqual([record.mode, record.pendingInference, record.relations, record.concepts.every(c => c.match === "explicit")], ["deterministic", true, [], true]);
  assert.equal(inferred(db, id).length, 2);
  assert.equal((await relations.relationsOf("alice", energy.id)).proposed.length, 0);
  assert.equal(await store.plan(queue), 0, "nothing to do until a model exists");

  // Configured but unreachable: the job waits without consuming an attempt.
  state.model = true;
  setUnavailable(true);
  assert.equal(await store.plan(queue), 1);
  assert.equal((await drain(store.handler)).waiting, 1);
  const waiting = queue.get(`enrich:${id}:${record.revision}:model`)!;
  assert.deepEqual([waiting.state, waiting.attempts], ["pending", 0]);

  // Back, then a crash mid-job: the expired lease lets another pass finish it once.
  setUnavailable(false);
  advance(16 * 60_000);
  const claimed = queue.claim([DISCOVERY_JOB], 60_000)!;
  assert.equal(claimed.key, waiting.key);
  advance(61_000);
  assert.equal((await drain(store.handler)).done, 1);
  record = (await store.read(id))!;
  assert.deepEqual([record.mode, record.pendingInference], ["model", false]);
  assert.equal((await relations.relationsOf("alice", energy.id)).proposed.length, 1);
});

test("no cloud: a non-local inference server is refused before any request; deterministic only", async t => {
  const { db, publish, vault, topics, relations, publications, queue, drain } = await setup(t);
  const runtime = createLLMRuntime({ db, env: { XI_INFERENCE_URL: "http://8.8.8.8:11434", XI_INFERENCE_MODEL: "cloud-model" } });
  const store = createTopicDiscovery({ vault, topics, relations, publications, llm: owner => bindSafely(() => runtime.bind(owner, null), null), ownerOf: async ({ authorId }) => authorId });
  const id = await publish("dave", INFLUENCE);
  await store.plan(queue);
  await drain(store.handler);
  const record = (await store.read(id))!;
  assert.deepEqual([record.mode, record.model, record.relations], ["deterministic", null, []]);
});

test("candidates: recurrent concepts merged across spellings, never created; personal topics untouched; rebuild", async t => {
  const { db, vault, topics, publish, discovery, queue, drain, setAnswer } = await setup(t);
  const { topic: personal } = await topics.openPersonal("bob", "hydrogene");
  const texts = [["dave", "L’hydrogène vert progresse. #hydrogene"], ["dave", "Les hydrogènes verts coûtent cher."], ["erin", "Hydrogene vert : un pari."]];
  const ids: string[] = [];
  for (const [author, text] of texts) ids.push(await publish(author, text));
  const store = discovery();
  const labels = ["Hydrogène vert", "hydrogènes verts", "Hydrogene vert"];
  for (const [i, id] of ids.entries()) {
    setAnswer({ concepts: [{ label: labels[i], quote: texts[i][1].replace(" #hydrogene", "") }], relations: [] });
    await queue.enqueue({ kind: DISCOVERY_JOB, key: `c${i}`, payload: { publicationId: id } });
    await drain(store.handler);
  }
  const [candidate, ...rest] = await store.candidates();
  assert.deepEqual([candidate.key, candidate.status, candidate.publications, candidate.authors, rest.length], ["hydrogene vert", "candidate", 3, 2, 0]);
  assert.equal(candidate.labels.length, 3);
  assert.equal((await topics.list()).length, 3, "never created automatically");
  for (const id of ids) assert.ok(!JSON.stringify(await store.read(id)).includes(personal.id), "personal topics are never matched");
  assert.equal((await topics.visible("bob")).personal.length, 1);

  // Once a shared topic carries the concept, it is no longer a candidate.
  await topics.create("alice", randomUUID(), { tag: "hydrogene-vert", name: "Hydrogène vert", description: "", scope: "H2", parentId: null, relatedIds: [] });
  assert.deepEqual(await store.candidates(), []);

  // Index rebuild: inferred associations come back from the Markdown records, in a fresh database too.
  setAnswer({ concepts: [], relations: [] });
  const energyPub = await publish("dave", "L’énergie solaire avance.");
  await store.plan(queue);
  await drain(store.handler);
  assert.equal(inferred(db, energyPub).length, 1);
  db.exec("DELETE FROM publication_topic WHERE origin = 'inferred'");
  await store.project();
  assert.equal(inferred(db, energyPub).length, 1);
  const db2 = new Database(":memory:");
  t.after(() => db2.close());
  const topics2 = createTopicStore({ vault, db: db2 });
  const publications2 = createPublicationStore({ vault, db: db2 });
  const fresh = createTopicDiscovery({ vault, topics: topics2, publications: publications2, relations: createTopicRelationStore({ vault, db: db2, topics: topics2 }), llm: () => ({ ok: false, code: "not-configured", message: "" }), ownerOf: async () => null });
  await fresh.project();
  assert.equal(inferred(db2, energyPub).length, 1);
  assert.ok((await readdir(join(vault.root, "topic-discovery"))).length >= 4);
});

test("subscribing plans nothing", async t => {
  const { publications, discovery, queue, energy } = await setup(t);
  await publications.setTopicSubscription({ id: "bob" }, energy.id, true);
  assert.equal(await discovery().plan(queue), 0);
  assert.deepEqual(queue.counts(), {});
});
