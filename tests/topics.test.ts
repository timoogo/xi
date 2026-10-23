import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import Database from "better-sqlite3";
import { stringify } from "yaml";
import { openVault } from "../src/lib/publications/vault";
import { createTopicStore, validateTopics } from "../src/lib/topics/store";
import { encodeRun, eventCursor } from "../src/lib/topics/events";
import type { Draft, Topic } from "../src/lib/topics/types";

async function setup(t: TestContext, beforeStep?: (step: number) => void) {
  const root = await mkdtemp(join(tmpdir(), "xi-topics-"));
  const vault = await openVault(root);
  const db = new Database(":memory:");
  const store = createTopicStore({ vault, db, beforeStep });
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  const draft = (tag: string, parentId: string | null = null, relatedIds: string[] = []): Draft => ({ tag, name: tag.split(".").at(-1)!, description: "", scope: `Périmètre de ${tag}`, parentId, relatedIds });
  async function create(input: Draft) {
    const proposal = await store.propose("alice", "Intention privée originale");
    const run = await store.confirm("alice", proposal.id, input, true);
    assert.equal(run.state, "completed", JSON.stringify(run.steps));
    return (await store.list()).find(topic => topic.id === run.topicId)!;
  }
  return { root, vault, db, store, draft, create };
}

test("global UUID topics: children preserve parent scope; transverse relations and duplicates", async t => {
  const { store, create, draft, root, db } = await setup(t);
  const parent = await create(draft("politiks"));
  const science = await create(draft("science"));
  const child = await create(draft("politiks.france", parent.id, [science.id]));
  assert.deepEqual(child.relatedIds, [science.id]);
  assert.equal((await store.list()).find(t => t.id === parent.id)?.scope, parent.scope);
  assert.deepEqual(db.prepare("SELECT child_id FROM topic_routing WHERE parent_id = ?").all(parent.id), [{ child_id: child.id }]);
  const proposal = await store.propose("bob", "Politique française");
  assert.ok(proposal.matches.includes(child.id));
  assert.equal(proposal.draft.parentId, parent.id);
  assert.equal(proposal.existingTopicId, child.id);
  assert.deepEqual(proposal.draft.relatedIds, [science.id]);
  const duplicate = await store.confirm("bob", proposal.id, draft("politiks.france", parent.id), true);
  assert.equal(duplicate.state, "failed");
  assert.match(duplicate.steps[7].error!, /réservé/);
  const publicText = await readFile(join(root, "topics", `${child.id}.md`), "utf8");
  assert.ok(!publicText.includes("Intention privée originale"));
  assert.deepEqual(await readdir(join(root, "posts")), []);
  assert.ok(!(await readdir(root)).includes("generators"));
});

test("idempotence, explicit validation, owner permissions, cancellation and stale revisions", async t => {
  const { store, draft } = await setup(t);
  const proposal = await store.propose("alice", "Science et recherche");
  await assert.rejects(store.confirm("alice", proposal.id, draft("science"), false), /validation explicite/);
  await assert.rejects(store.getRun("bob", proposal.id), /introuvable/);
  await assert.rejects(store.confirm("bob", proposal.id, draft("science"), true), /introuvable/);
  const run = await store.confirm("alice", proposal.id, draft("science"), true);
  assert.deepEqual(await store.confirm("alice", proposal.id, draft("science"), true), run);
  await assert.rejects(store.confirm("alice", proposal.id, draft("autre"), true), /différent/);
  assert.equal((await store.list()).length, 1);
  const topic = (await store.list())[0];
  await assert.rejects(store.update("bob", topic.id, topic.revision, draft("nouveau"), true), /créateur/);
  await assert.rejects(store.update("alice", topic.id, randomUUID(), draft("nouveau"), true), /modifié/);
  const cancelled = await store.propose("alice", "Une autre intention");
  await store.cancel("alice", cancelled.id);
  await assert.rejects(store.confirm("alice", cancelled.id, draft("annule"), true), /annulée/);
});

test("hierarchy rejects cycles, invalid parent tags and dangling/self relations", async t => {
  const { create, store, draft } = await setup(t);
  const parent = await create(draft("politiks"));
  const child = await create(draft("politiks.france", parent.id));
  const topics = await store.list();
  assert.throws(() => validateTopics(topics.map(t => t.id === parent.id ? { ...t, parentId: child.id } : t)), /Cycle/);
  assert.throws(() => validateTopics([{ ...parent, relatedIds: [parent.id] }]), /Relation/);
  assert.throws(() => validateTopics([{ ...parent, relatedIds: [randomUUID()] }]), /Relation/);
  assert.throws(() => validateTopics([{ ...parent, tag: "politiks.france" }]), /spécialiser/);
  await assert.rejects(store.update("alice", parent.id, parent.revision, { ...draft("politiks"), parentId: child.id }, true), /Cycle|spécialiser/);
});

test("rename subtree preserves UUIDs/references; aliases reserved and SQLite fully reconstructible", async t => {
  const { create, store, draft, db, root, vault } = await setup(t);
  const parent = await create(draft("politiks"));
  const child = await create(draft("politiks.france", parent.id));
  await store.update("alice", parent.id, parent.revision, draft("politique"), true);
  let topics = await store.list();
  assert.equal(topics.find(t => t.id === child.id)?.tag, "politique.france");
  assert.deepEqual(topics.find(t => t.id === child.id)?.aliases, ["politiks.france"]);
  assert.equal((db.prepare("SELECT topic_id FROM topic_tag WHERE tag = ?").get("politiks.france") as { topic_id: string }).topic_id, child.id);
  const proposal = await store.propose("bob", "Ancien tag");
  assert.equal((await store.confirm("bob", proposal.id, draft("politiks"), true)).state, "failed");
  db.exec("DROP TABLE topic_index; DROP TABLE topic_tag; DROP TABLE topic_routing;");
  const rebuilt = createTopicStore({ vault, db });
  assert.deepEqual(await rebuilt.reindex(), topics);
  // Simulate crash after writing rename intent but before replacing its individual Markdown files.
  const planned = topics.map(t => ({ ...t, description: "Recovered transaction" }));
  await writeFile(join(root, "topics", ".pending.md"), `---\n${stringify(planned)}---\n`);
  topics = await rebuilt.list();
  assert.ok(topics.every(t => t.description === "Recovered transaction"));
  assert.ok(!(await readdir(join(root, "topics"))).includes(".pending.md"));
});

test("concurrent stores serialize tag allocation and conflicting confirmations", async t => {
  const { store, vault, draft } = await setup(t);
  const db2 = new Database(":memory:"); t.after(() => db2.close());
  const second = createTopicStore({ vault, db: db2 });
  const [a, b] = await Promise.all([store.propose("alice", "Même topic"), second.propose("bob", "Même topic")]);
  const results = await Promise.all([store.confirm("alice", a.id, draft("unique"), true), second.confirm("bob", b.id, draft("unique"), true)]);
  assert.deepEqual(results.map(r => r.state).sort(), ["completed", "failed"]);
  assert.equal((await store.list()).length, 1);
});

test("resume after indexing failure and restart never repeats public creation", async t => {
  let fail = true;
  const { store, draft, vault, db, root } = await setup(t, step => { if (step === 8 && fail) { fail = false; throw new Error("disk/index failure"); } });
  const proposed = await store.propose("alice", "Science privée");
  const failed = await store.confirm("alice", proposed.id, draft("science"), true);
  assert.equal(failed.state, "failed");
  assert.equal(failed.steps[7].status, "completed");
  assert.equal(failed.steps[8].status, "failed");
  assert.equal(failed.steps[9].status, "pending");
  const restarted = createTopicStore({ vault, db });
  const recovered = await restarted.resume("alice", proposed.id);
  assert.equal(recovered.state, "completed");
  assert.equal(recovered.topicId, failed.topicId);
  assert.equal((await readdir(join(root, "topics"))).filter(n => n.endsWith(".md")).length, 1);
  assert.ok(recovered.steps.every(s => s.status === "completed"));
  assert.deepEqual(await restarted.resume("alice", proposed.id), recovered);
  assert.match(encodeRun(recovered), new RegExp(`^id: ${eventCursor(recovered)}`));
  assert.equal(new Set(recovered.events.map(e => e.id)).size, recovered.events.length);
  assert.deepEqual(JSON.parse(encodeRun(recovered).split("data: ")[1]), recovered);
});

test("routing chooses appropriate specialization, contextual secondaries, and accepts human correction", async t => {
  const { store, create, draft } = await setup(t);
  const world = await create(draft("politiks"));
  const france = await create(draft("politiks.france", world.id));
  const assembly = await create({ ...draft("politiks.france.assemblee", france.id), name: "Assemblée nationale" });
  assert.equal((await store.route("Politique mondiale")).primaryId, world.id);
  assert.equal((await store.route("Politique française")).primaryId, france.id);
  const precise = await store.route("Assemblée nationale");
  assert.equal(precise.primaryId, assembly.id);
  assert.ok(!precise.secondaryIds.includes(precise.primaryId!));
  assert.equal((await store.route("Volcanologie")).primaryId, null);
  const correction = await store.route("Politique mondiale", { primaryId: assembly.id, secondaryIds: [world.id] });
  assert.deepEqual(correction.secondaryIds, [world.id]);
  await assert.rejects(store.route("Politique mondiale", { primaryId: world.id, secondaryIds: [world.id] }), /invalides/);
});

test("externally corrupted Markdown refuses rebuild without destroying the previous index", async t => {
  const { create, store, draft, root, db } = await setup(t);
  const topic = await create(draft("science"));
  const broken: Topic = { ...topic, parentId: topic.id };
  await writeFile(join(root, "topics", `${topic.id}.md`), `---\n${stringify(broken)}---\n`);
  await assert.rejects(store.reindex(), /Cycle/);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM topic_index").get() as { n: number }).n, 1);
});

test("failed analysis resumes without bypassing human confirmation", async t => {
  let fail = true;
  const { store, root } = await setup(t, step => { if (step === 0 && fail) { fail = false; throw new Error("analyzer unavailable"); } });
  const failed = await store.propose("alice", "Politique mondiale");
  assert.equal(failed.state, "failed");
  const resumed = await store.resume("alice", failed.id);
  assert.equal(resumed.state, "waiting");
  assert.equal(resumed.confirmed, false);
  assert.equal(resumed.steps[7].status, "pending");
  assert.equal((await readdir(join(root, "topics"))).filter(n => n.endsWith(".md")).length, 0);
});

test("a crashed process releases the writer lock and a pending proposal can proceed", async t => {
  const { spawn } = await import("node:child_process");
  const { store, root } = await setup(t);
  await store.list();
  const child = spawn(process.execPath, ["-e", `const Database = require('better-sqlite3'); const db = new Database(process.argv[1]); db.exec('BEGIN IMMEDIATE'); console.log('locked'); setInterval(() => {}, 1000);`, join(root, "topics", ".writer-lock.sqlite")], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  await once(child.stdout!, "data");
  const pending = store.propose("alice", "Après redémarrage");
  const exited = once(child, "exit");
  child.kill("SIGKILL"); await exited;
  assert.equal((await pending).state, "waiting");
});

test("deterministic subjects strip request phrases and normalize known specializations", async () => {
  const { deterministicAnalyzer } = await import("../src/lib/topics/analysis");
  for (const intent of ["Je souhaite suivre la politique française", "Je veux me renseigner sur la politique française", "J'aimerais comprendre la politique française", "J’aimerais comprendre la politique française", "Parle-moi de la politique française", "Je m'intéresse à la politique française"]) {
    const proposal = await deterministicAnalyzer.analyze(intent, []);
    assert.equal(proposal.subject, "Politique française");
    assert.equal(proposal.draft.tag, "politiks.france");
    assert.equal(proposal.draft.name, "Politique française");
    assert.equal(proposal.draft.scope, "Politique, institutions et actualité politique françaises");
    assert.deepEqual(proposal.missingParents?.map(p => p.tag), ["politiks"]);
  }
  for (const [subject, tag] of [["Parle-moi des élections françaises", "politiks.france.elections"], ["Je m’intéresse aux élections françaises", "politiks.france.elections"], ["Politique allemande", "politiks.allemagne"], ["Élections françaises", "politiks.france.elections"], ["Politique européenne", "politiks.europe"], ["politiks.france", "politiks.france"]]) {
    assert.equal((await deterministicAnalyzer.analyze(subject, [])).draft.tag, tag);
  }
});

test("unknown and ambiguous subjects retain cautious editable flat proposals", async t => {
  const { deterministicAnalyzer } = await import("../src/lib/topics/analysis");
  const { create, draft } = await setup(t);
  const parent = await create(draft("politiks"));
  for (const [intent, name] of [["Je souhaite suivre la volcanologie", "Volcanologie"], ["Parle-moi de l'astronomie", "Astronomie"], ["Politique française et allemande", "Politique française et allemande"], ["Politique des océans", "Politique des océans"], ["2026 et ses découvertes", "2026 et ses découvertes"]]) {
    const proposal = await deterministicAnalyzer.analyze(intent, [parent]);
    assert.equal(proposal.draft.name, name); assert.equal(proposal.draft.parentId, null);
    assert.ok(!proposal.draft.tag.includes(".")); assert.match(proposal.draft.scope, /Périmètre à préciser/);
    assert.ok(!proposal.draft.scope.includes("Je souhaite"));
  }
  await assert.rejects(deterministicAnalyzer.analyze("Je souhaite suivre…".replace("…", ""), []), /Précisez/);
});

test("missing parents require separate human confirmations; stable runs resume to child and account", async t => {
  const { store, vault, db } = await setup(t);
  const { createAccountStore } = await import("../src/lib/accounts/store");
  const childRun = await store.propose("alice", "Je souhaite suivre la politique française");
  assert.equal(childRun.draft.tag, "politiks.france"); assert.equal((await store.list()).length, 0);
  await assert.rejects(store.confirm("alice", childRun.id, childRun.draft, true), /parent proposé/);
  const parentRun = await store.proposeParent("alice", childRun.id);
  assert.equal(parentRun.returnRunId, childRun.id); assert.equal(parentRun.draft.tag, "politiks");
  assert.equal((await store.proposeParent("alice", childRun.id)).id, parentRun.id);
  assert.equal((await store.list()).length, 0);
  await assert.rejects(store.confirm("alice", parentRun.id, parentRun.draft, false), /validation explicite/);
  const parent = await store.confirm("alice", parentRun.id, parentRun.draft, true); assert.equal(parent.state, "completed");
  assert.equal((await store.list()).length, 1);
  const restarted = createTopicStore({ vault, db });
  const ready = await restarted.resume("alice", childRun.id);
  assert.equal(ready.topicId, childRun.topicId); assert.equal(ready.confirmed, false); assert.equal(ready.state, "waiting");
  assert.equal(ready.draft.parentId, parent.topicId);
  const completed = await restarted.confirm("alice", ready.id, ready.draft, true); assert.equal(completed.state, "completed");
  assert.deepEqual(await restarted.confirm("alice", parentRun.id, parentRun.draft, true), parent);
  const topics = await store.list(); assert.equal(topics.length, 2); assert.equal(topics.find(t => t.id === parent.topicId)?.scope, parentRun.draft.scope);
  const accounts = createAccountStore({ vault, db, topics: restarted });
  const account = await accounts.propose("alice", childRun.topicId); const proposed = await accounts.resume("alice", account.id);
  assert.equal(proposed.draft!.handle, "politiks.france"); assert.equal(proposed.draft!.name, "Politique française");
  assert.equal((await accounts.confirm("alice", account.id, proposed.draft, true)).state, "completed");
  const saved = (await accounts.list("alice"))[0]; assert.equal(saved.editorial!.primaryTopicId, childRun.topicId); assert.ok(!("scope" in saved.editorial!));
});

test("nested missing parents, existing parent reuse and aliases preserve general scopes", async t => {
  const { store } = await setup(t);
  const elections = await store.propose("alice", "Élections françaises");
  const france = await store.proposeParent("alice", elections.id);
  const politics = await store.proposeParent("alice", france.id);
  assert.equal(politics.draft.tag, "politiks"); await store.confirm("alice", politics.id, politics.draft, true);
  const readyFrance = await store.resume("alice", france.id); await store.confirm("alice", france.id, readyFrance.draft, true);
  const readyElections = await store.resume("alice", elections.id); assert.equal(readyElections.draft.parentId, france.topicId);
  await store.confirm("alice", elections.id, readyElections.draft, true);
  const all = await store.list(); assert.equal(all.length, 3);
  assert.equal(all.find(t => t.id === france.topicId)?.scope, "Politique, institutions et actualité politique françaises");
  const parent = all.find(t => t.id === politics.topicId)!;
  await store.update("alice", parent.id, parent.revision, { ...parent, tag: "politique" }, true);
  const german = await store.propose("alice", "Politique allemande"); assert.equal(german.draft.tag, "politique.allemagne"); assert.equal(german.draft.parentId, parent.id); assert.deepEqual(german.missingParents, []);
  const duplicate = await store.propose("alice", "Élections françaises"); assert.equal(duplicate.existingTopicId, elections.topicId); assert.equal(duplicate.draft.tag, "politique.france.elections");
});

test("parent creation failure and concurrent parent collision never create orphan children", async t => {
  let fail = true;
  const { store, vault, db } = await setup(t, step => { if (step === 8 && fail) { fail = false; throw new Error("index unavailable"); } });
  const first = await store.propose("alice", "Politique française"); const second = await store.propose("bob", "Politique allemande");
  const a = await store.proposeParent("alice", first.id); const b = await store.proposeParent("bob", second.id);
  assert.equal((await store.confirm("alice", a.id, a.draft, true)).state, "failed");
  const restarted = createTopicStore({ vault, db }); assert.equal((await restarted.resume("alice", a.id)).state, "completed");
  const conflict = await store.confirm("bob", b.id, b.draft, true); assert.equal(conflict.state, "failed"); assert.equal(conflict.existingTopicId, a.topicId);
  const ready = await store.resume("bob", second.id); assert.equal(ready.draft.parentId, a.topicId); assert.equal(ready.confirmed, false);
  assert.equal((await store.list()).length, 1);
  assert.equal((await store.confirm("bob", ready.id, ready.draft, true)).state, "completed");
  assert.equal((await store.list()).length, 2);
  await assert.rejects(store.proposeParent("bob", first.id), /introuvable/);
});
