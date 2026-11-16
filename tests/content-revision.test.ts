import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { contentRevision, openVault, readMarkdownTree } from "../src/lib/publications/vault";
import { createPublicationStore } from "../src/lib/publications/store";
import { createTopicStore } from "../src/lib/topics/store";
import { createTopicRelationStore } from "../src/lib/topics/relations";
import { createAccountStore } from "../src/lib/accounts/store";
import { createJobQueue, type Job } from "../src/lib/watch/jobs";
import { drainJobs } from "../src/lib/watch/worker";
import { admit, SYSTEM_TASK_KIND } from "../src/lib/watch/orchestrator";
import { systemTaskHandler } from "../src/lib/system-agents/tasks";
import { createKnowledgePipelines, knowledgeRequestId } from "../src/lib/konstruktor/pipelines";

const FOLDER = "posts/_generators/a/post_20261113_001";
const tree = (message = "1_ancien", source = "1_source", body = "Asterion-47 utilise Helios-9.", title = "Agence") => new Map([
  ["index.md", `---\nid: x\n---\n![[${FOLDER}/${message}]]\n`],
  [`${message}.md`, `${body}\n\n- [[${FOLDER}/_sources/${source}|${title}]] — Agence\n`],
  [`_sources/${source}.md`, `---\nurl: https://agence.example/a\ntitle: ${title}\n---\n`],
]);
const rev = (files: Map<string, string>) => contentRevision("post_20261113_001", files);

test("révision de contenu : indépendante des noms de fichiers, sensible au contenu, aux sources et à l’ordre", () => {
  const base = rev(tree());
  assert.equal(rev(tree("1_nouveau_nom", "1_autre_source")), base, "renommer message et source ne change rien");
  // Obsidian may rewrite links in short form after a rename.
  const short = new Map([...tree("1_nouveau_nom")].map(([name, text]) => [name, text.replaceAll(`${FOLDER}/`, "")]));
  assert.equal(rev(short), base, "lien court vers un fichier du dossier");
  assert.notEqual(rev(tree(undefined, undefined, "Asterion-47 utilise Helios-10.")), base, "texte modifié");
  assert.notEqual(rev(tree(undefined, undefined, undefined, "Agence spatiale")), base, "titre de source modifié");
  const metadata = tree(); metadata.set("index.md", metadata.get("index.md")!.replace("id: x", "id: x\nvisibility: public"));
  assert.notEqual(rev(metadata), base, "métadonnée modifiée");
  const url = tree(); url.set("_sources/1_source.md", url.get("_sources/1_source.md")!.replace("/a", "/b"));
  assert.notEqual(rev(url), base, "adresse de source modifiée");
  // Message identity is its number: renumbering is a change.
  const renumbered = new Map([...tree("2_ancien")]);
  assert.notEqual(rev(renumbered), base, "numéro de message modifié");
  // A link to another publication is content, whatever its form.
  const other = tree(); other.set("1_ancien.md", other.get("1_ancien.md")! + "[[posts/_users/u/post_20261101_001/1_ancien]]\n");
  assert.notEqual(rev(other), base);
});

/** The real engine: publications, the system-task queue, Konstruktor's analysis task and its pipelines. */
async function setup(t: test.TestContext) {
  const path = await mkdtemp(join(tmpdir(), "xi-content-revision-"));
  const db = new Database(":memory:");
  t.after(async () => { db.close(); await rm(path, { recursive: true, force: true }); });
  let clock = Date.parse("2026-11-13T09:00:00Z");
  const now = () => clock;
  const vault = await openVault(path), topics = createTopicStore({ vault, db });
  const accounts = createAccountStore({ vault, db, topics });
  const env = { publications: createPublicationStore({ vault, db }) };
  const relations = createTopicRelationStore({ vault, db, topics, readable: (viewer, ids) => env.publications.readableIds(viewer, ids) });
  const run = await topics.propose("alice", "Propulsion");
  await topics.confirm("alice", run.id, { tag: "propulsion", name: "Propulsion", description: "", scope: "Espace", parentId: null, relatedIds: [] }, true);
  const proposal = await accounts.propose("alice", run.topicId), ready = await accounts.resume("alice", proposal.id);
  await accounts.confirm("alice", ready.id, ready.draft, true);
  const agent = ready.accountId;
  const publish = async (text: string) => {
    const id = randomUUID();
    const draft = await env.publications.saveWatchDraft("alice", agent, { id, summary: text, topicIds: [run.topicId], messages: [{ body: text, sources: [0] }], sources: [{ url: "https://agence.example/a", title: "Agence", publisher: "Agence", accessedAt: "2026-11-01", facts: [text], reservations: [] }], watch: {} });
    assert.ok((await env.publications.reviewWatchDraft({ id: "alice" }, agent, id, { action: "approve", revision: draft.revision })).ok);
    return id;
  };
  const id = await publish("Asterion-47 utilise le moteur Helios-9.");
  const inference = { calls: 0, complete: async ({ prompt }: { prompt: string }) => {
    inference.calls++;
    const sentence = prompt.split("\n").find(line => line.includes("utilise"))!;
    const [from] = sentence.split(" "), to = sentence.replace(/\.$/, "").split(" ").at(-1)!;
    return JSON.stringify({ concepts: [{ name: from }, { name: to }], relations: [{ from, link: "utilise le moteur", to, type: "related_to", confidence: 0.8 }] });
  } };
  const binding = { ok: true as const, resolved: { model: "local-test" }, inference };
  const systemAgents = { get: async () => ({ id: "konstruktor", enabled: true }) };
  const queue = createJobQueue(db, now);
  const handlers = { [SYSTEM_TASK_KIND]: systemTaskHandler({ store: systemAgents as never, llm: () => binding as never, services: { db, accounts, topics, get publications() { return env.publications; }, relations, agentLLM: () => binding as never }, now }) };
  const control = { db, admit: async (job: Job) => admit(job, undefined, new Map(), now()), owner: async (job: Job) => (job.payload as { owner: string }).owner };
  const drain = async () => { for (let pass = 0; pass < 6; pass++) { await drainJobs({ queue, handlers, clock: now, control, maxJobs: 50 }); clock += 10 * 60_000; } };
  const pipelines = () => createKnowledgePipelines({ db, accounts, publications: env.publications, systemAgents: systemAgents as never, queue, now });
  // A fresh store re-reads the vault: what the app sees after an edit in Obsidian and a restart.
  const restart = () => { env.publications = createPublicationStore({ vault, db }); };
  const folder = async () => {
    const parent = join(path, "posts", "_generators", agent);
    return join(parent, (await readdir(parent)).find(name => name.startsWith("post_"))!);
  };
  const jobs = () => db.prepare("SELECT COUNT(*) FROM watch_job").pluck().get() as number;
  const knowledge = () => db.prepare("SELECT publication, revision, topic, excerpt FROM xi_agent_knowledge ORDER BY topic").all();
  const memory = async () => env.publications.agentMemory("alice", agent, "private");
  return { db, path, agent, id, env, inference, queue, drain, pipelines, restart, folder, jobs, knowledge, memory, relations, topics };
}

/** What Obsidian does on a rename: the file moves, and links to it are rewritten. */
async function obsidianRename(path: string, dir: string, from: string, to: string) {
  const folder = dir.slice(path.length + 1);
  await rename(join(dir, from), join(dir, to));
  for (const [name, content] of (await readMarkdownTree(dir)).files) {
    const updated = content.replaceAll(`[[${folder}/${from.replace(/\.md$/, "")}`, `[[${folder}/${to.replace(/\.md$/, "")}`);
    if (updated !== content) await writeFile(join(dir, name), updated);
  }
}

test("renommage seul : aucune réanalyse, connaissances, relations et tâches inchangées", async t => {
  const w = await setup(t);
  assert.equal((await w.pipelines().start("alice", { agent: w.agent, mode: "missing" }))!.enqueued, 1);
  await w.drain();
  const before = await w.env.publications.get({ id: "alice" }, w.id);
  const learned = w.knowledge(), memory = await w.memory(), jobs = w.jobs(), calls = w.inference.calls;
  const topic = (await w.topics.visible("alice")).personal.find(item => item.tag === "asterion-47")!;
  const relations = await w.relations.relationsOf("alice", topic.id);
  assert.equal(learned.length, 2);

  const dir = await w.folder();
  const message = (await readdir(dir)).find(name => /^1_.+\.md$/.test(name))!;
  const source = (await readdir(join(dir, "_sources")))[0];
  await obsidianRename(w.path, dir, message, "1_renomme_dans_obsidian.md");
  await obsidianRename(w.path, dir, `_sources/${source}`, "_sources/1_agence_renommee.md");
  w.restart();
  const after = await w.env.publications.get({ id: "alice" }, w.id);
  assert.notEqual(after.revision, before.revision, "le jeton d’édition suit les fichiers");
  assert.equal(after.contentRevision, before.contentRevision);
  assert.deepEqual(after.messages.map(item => item.file), ["1_renomme_dans_obsidian.md"], "ordre et numéro conservés");
  assert.match(after.messages[0].body, /_sources\/1_agence_renommee\|Agence/, "lien Obsidian à jour");

  // Nothing planned: neither by the worker nor by a « missing » run.
  await w.pipelines().planAutomatic();
  const missing = (await w.pipelines().start("alice", { agent: w.agent, mode: "missing" }))!;
  assert.equal(missing.enqueued, 0);
  assert.equal(missing.run.jobs[0].reason, "Déjà analysée à cette révision.");
  await w.drain();
  assert.equal(w.inference.calls, calls, "aucun appel au modèle");
  assert.equal(w.jobs(), jobs, "aucune tâche Konstruktor créée");
  assert.deepEqual(w.knowledge(), learned);
  assert.deepEqual(await w.memory(), memory, "connaissances et citations toujours visibles");
  assert.deepEqual(await w.relations.relationsOf("alice", topic.id), relations);
});

test("contenu modifié, avec ou sans renommage : réanalyse", async t => {
  const w = await setup(t);
  await w.pipelines().start("alice", { agent: w.agent, mode: "missing" });
  await w.drain();
  const dir = await w.folder();
  const edit = async (from: string, to: string) => {
    const text = await readFile(join(dir, to), "utf8");
    await writeFile(join(dir, to), text.replace(from, to.startsWith("_sources") ? from : `${from} Il a décollé.`));
  };
  const message = (await readdir(dir)).find(name => /^1_.+\.md$/.test(name))!;
  // Content only.
  await edit("Helios-9.", message);
  w.restart();
  assert.equal((await w.pipelines().start("alice", { agent: w.agent, mode: "missing" }))!.enqueued, 1, "contenu modifié");
  await w.drain();
  assert.equal(w.knowledge().length, 2);
  assert.equal((await w.memory()).length, 2, "la connaissance suit la nouvelle révision de contenu");
  // Rename and content.
  await obsidianRename(w.path, dir, message, "1_nouveau.md");
  await writeFile(join(dir, "1_nouveau.md"), (await readFile(join(dir, "1_nouveau.md"), "utf8")).replace("Il a décollé.", "Il a atterri."));
  w.restart();
  assert.equal((await w.pipelines().start("alice", { agent: w.agent, mode: "missing" }))!.enqueued, 1, "renommage et contenu modifié");
  // A source change (its title) counts too.
  await w.drain();
  const source = (await readdir(join(dir, "_sources")))[0];
  await writeFile(join(dir, "_sources", source), (await readFile(join(dir, "_sources", source), "utf8")).replace("title: Agence", "title: Agence spatiale"));
  w.restart();
  assert.equal((await w.pipelines().start("alice", { agent: w.agent, mode: "missing" }))!.enqueued, 1, "source modifiée");
});

test("migration unique : les analyses enregistrées avec l’ancienne révision restent valides", async t => {
  const w = await setup(t);
  await w.pipelines().start("alice", { agent: w.agent, mode: "missing" });
  await w.drain();
  const current = await w.env.publications.get({ id: "alice" }, w.id);
  const learned = w.knowledge(), memory = await w.memory(), jobs = w.jobs();
  // A database written before content revisions: every analysis refers to the exact revision of the files.
  const [exact, content] = [current.revision, current.contentRevision];
  const automatic = (revision: string) => knowledgeRequestId("alice", w.agent, w.id, revision);
  w.db.prepare("UPDATE xi_agent_knowledge SET revision = ?").run(exact);
  for (const job of w.db.prepare<[], { id: string; key: string; payload: string }>("SELECT id, key, payload FROM watch_job").all()) {
    w.db.prepare("UPDATE watch_job SET key = ?, payload = ? WHERE id = ?").run(job.key.replace(automatic(content), automatic(exact)), job.payload.replaceAll(content, exact).replaceAll(automatic(content), automatic(exact)), job.id);
  }
  w.db.prepare("UPDATE konstruktor_pipeline_job SET revision = ?, job_key = replace(job_key, ?, ?)").run(exact, automatic(content), automatic(exact));
  // An analysis already planned under the new name (the worker ran before the migration): both coexist.
  w.db.prepare("INSERT INTO watch_job (id, kind, key, payload, state, run_after, attempts, max_attempts, created_at, updated_at) SELECT ?, kind, ?, replace(payload, ?, ?), state, run_after, attempts, max_attempts, created_at, updated_at FROM watch_job WHERE key LIKE ?")
    .run(randomUUID(), `system:konstruktor:alice:${automatic(content)}`, exact, content, `%${automatic(exact)}`);
  w.db.prepare("DELETE FROM xi_index_meta WHERE key = 'content_revision_migration'").run();
  w.db.prepare("UPDATE xi_index_meta SET value = '7' WHERE key = 'schema_version'").run();
  assert.equal((await w.memory()).length, 0, "sans migration, la connaissance serait masquée");

  w.restart();
  await w.env.publications.ensureIndexed();
  assert.deepEqual(w.knowledge(), learned);
  assert.deepEqual(await w.memory(), memory);
  const missing = (await w.pipelines().start("alice", { agent: w.agent, mode: "missing" }))!;
  assert.equal(missing.enqueued, 0, "aucune réanalyse");
  await w.pipelines().planAutomatic();
  assert.equal(w.jobs(), jobs + 1, "aucune tâche planifiée");
  // The earlier run still lists its job under the renamed key.
  const [first] = w.pipelines().list("alice", { agent: w.agent }).slice(-1);
  assert.equal(w.pipelines().get("alice", first.id).jobs[0].status, "success");
  // Once only.
  w.db.prepare("UPDATE xi_agent_knowledge SET revision = 'autre'").run();
  w.restart();
  await w.env.publications.ensureIndexed();
  assert.equal(w.db.prepare("SELECT revision FROM xi_agent_knowledge LIMIT 1").pluck().get(), "autre");
});
