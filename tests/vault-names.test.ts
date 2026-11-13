import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { createAccountStore } from "../src/lib/accounts/store";
import { createPublicationStore } from "../src/lib/publications/store";
import { slugify } from "../src/lib/publications/markdown";
import { NUMBERED_FILE, openVault, readMarkdownTree, recordFileName } from "../src/lib/publications/vault";
import { createTopicStore } from "../src/lib/topics/store";
import { createSourceStore } from "../src/lib/watch/sources";
import { migrateAgentKnowledge } from "../src/lib/konstruktor/knowledge";
import { applyVaultNames, planVaultNames } from "../src/lib/maintenance/vault-names";

const USDA = "L'accord entre NASA et l'USDA vise à moderniser les données agricoles du pays.";
const X59 = "NASA test pilot Mike Lippert successfully completed a flight of the X-59 quiet supersonic research aircraft.";

test("noms : slugs descriptifs, noms propres gardés, jamais coupés au milieu d’un mot", () => {
  assert.equal(slugify(USDA, "message"), "accord_entre_nasa_et_usda_vise_a_moderniser_les_donnees");
  assert.equal(slugify("NASA’s X-59 Quiet Supersonic Aircraft", "source"), "nasa_x-59_quiet_supersonic_aircraft");
  assert.equal(slugify("La mission Perseverance a capturé une image de la région 'Tinga'", "m"), "la_mission_perseverance_a_capture_une_image_de_la_region");
  assert.equal(slugify("Tinga's Tale", "source"), "tinga_tale");
  assert.equal(slugify("---", "message"), "message");
  assert.ok(slugify("mot ".repeat(40), "m").length <= 80);
  assert.ok(NUMBERED_FILE.test("1_nasa_x-59_quiet.md") && NUMBERED_FILE.test("12_sub_element.md") && !NUMBERED_FILE.test("index.md"));
  // Records: readable stem, deterministic suffix when taken, current name kept while it fits (no churn).
  const id = "0b431369-420a-40d0-b9d2-ff14a9dbc692";
  assert.equal(recordFileName("x-59", id, () => false), "x-59.md");
  assert.equal(recordFileName("relation-exclusions", id, name => name === "relation-exclusions.md"), "relation-exclusions--0b431369.md");
  assert.equal(recordFileName("x-59", id, () => false, "x-59--0b431369.md"), "x-59--0b431369.md");
  assert.equal(recordFileName("x-59", id, () => false, `${id}.md`), "x-59.md");
  assert.equal(recordFileName("../evil", id, () => false), `${id}.md`, "un nom inutilisable retombe sur l’identifiant");
});

async function world(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "xi-vault-names-"));
  const db = new Database(join(root, "..", `${root.split("/").at(-1)}.sqlite`));
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); await rm(`${root}.sqlite`, { force: true }); await rm(`${root}-backup`, { recursive: true, force: true }); });
  const vault = await openVault(root);
  const topics = createTopicStore({ vault, db });
  const accounts = createAccountStore({ vault, db, topics });
  const publications = createPublicationStore({ vault, db });
    const sources = createSourceStore({ vault, topics });
  return { root, db, vault, topics, accounts, publications, sources };
}

test("topics et sources : fichiers nommés par tag ou adresse, identité dans le frontmatter", async t => {
  const w = await world(t);
  const run = await w.topics.propose("alice", "Astronomie");
  await w.topics.confirm("alice", run.id, { tag: "astronomie", name: "Astronomie", description: "", scope: "Ciel", parentId: null, relatedIds: [] }, true);
  const child = await w.topics.create("alice", randomUUID(), { tag: "astronomie.mars", name: "Mars", description: "", scope: "Planète", parentId: run.topicId, relatedIds: [] });
  assert.deepEqual((await readdir(join(w.root, "topics"))).filter(name => name.endsWith(".md")).sort(), ["astronomie.mars.md", "astronomie.md"]);
  // A tag renamed with its subtree moves the files; ids and links by id are unchanged.
  const parent = (await w.topics.list()).find(topic => topic.id === run.topicId)!;
  await w.topics.update("alice", parent.id, parent.revision, { tag: "espace", name: "Espace", description: "", scope: "Ciel", parentId: null, relatedIds: [] }, true);
  assert.deepEqual((await readdir(join(w.root, "topics"))).filter(name => name.endsWith(".md")).sort(), ["espace.mars.md", "espace.md"]);
  assert.equal((await w.topics.list()).find(topic => topic.id === child.topic.id)?.tag, "espace.mars");

  // Personal topics: owner folder, readable names, a reserved name gets a suffix, never overwritten.
  await mkdir(join(w.root, ".xi-personal-topics", "alice"), { recursive: true });
  await writeFile(join(w.root, ".xi-personal-topics", "alice", "relation-exclusions.md"), "---\nexclusions: []\n---\n");
  const x59 = (await w.topics.openPersonal("alice", "x-59", "X-59")).topic;
  const odd = (await w.topics.openPersonal("alice", "relation-exclusions")).topic;
  const mine = await readdir(join(w.root, ".xi-personal-topics", "alice"));
  assert.ok(mine.includes("x-59.md") && mine.includes(`relation-exclusions--${odd.id.slice(0, 8)}.md`) && mine.includes("relation-exclusions.md"));
  assert.equal((await w.topics.visible("alice")).personal.length, 2, "le fichier d’exclusions n’est pas un topic");
  assert.equal((await w.topics.visible("bob")).personal.length, 0);

  // A legacy `<uuid>.md` file is still the same topic, and gets its readable name at its next write.
  await rename(join(w.root, ".xi-personal-topics", "alice", "x-59.md"), join(w.root, ".xi-personal-topics", "alice", `${x59.id}.md`));
  assert.equal((await w.topics.openPersonal("alice", "x-59")).topic.id, x59.id);
  // Two files for one id are refused rather than guessed.
  await writeFile(join(w.root, ".xi-personal-topics", "alice", "copie.md"), await readFile(join(w.root, ".xi-personal-topics", "alice", `${x59.id}.md`), "utf8"));
  await assert.rejects(w.topics.visible("alice"), /dupliqué/);
  await rm(join(w.root, ".xi-personal-topics", "alice", "copie.md"));

  // Sources: named after their address; the same address for two owners stays two files.
  const proposal = { url: "https://www.nasa.gov/feed/", publisher: "NASA", topicIds: [run.topicId], kind: "feed" as const, site: null, reliability: { level: "inconnue" as const, reasons: [], estimated: true } };
  const first = (await w.sources.propose("alice", proposal, "alice")).source;
  const second = (await w.sources.propose("bob", proposal, "bob")).source;
  assert.deepEqual((await readdir(join(w.root, "watch", "sources"))).filter(name => name.endsWith(".md")).sort(), ["nasa-gov-feed--" + second.id.slice(0, 8) + ".md", "nasa-gov-feed.md"].sort());
  assert.equal((await w.sources.list("alice")).sources[0].id, first.id);
  assert.equal((await w.sources.list("bob")).sources[0].id, second.id);
});

/** The names this vault had before the migration: six words, 48 characters, cut anywhere. */
const legacySlug = (text: string) => text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean).slice(0, 6).join("_").slice(0, 48).replace(/_+$/, "");

test("migration : sauvegarde, renommages, liens, révisions, isolation, idempotence et reprise", async t => {
  const w: Awaited<ReturnType<typeof world>> = await world(t);
  const run = await w.topics.propose("alice", "Astronomie");
  await w.topics.confirm("alice", run.id, { tag: "astronomie", name: "Astronomie", description: "", scope: "Ciel", parentId: null, relatedIds: [] }, true);
  const proposed = await w.accounts.propose("alice", run.topicId), ready = await w.accounts.resume("alice", proposed.id);
  await w.accounts.confirm("alice", ready.id, ready.draft, true);
  const agent = ready.accountId;
  const publish = async (text: string, source: string) => {
    const id = randomUUID();
    const draft = await w.publications.saveWatchDraft("alice", agent, { id, summary: text, topicIds: [run.topicId], messages: [{ body: text, sources: [0] }], sources: [{ url: "https://nasa.example/x", title: source, publisher: "NASA", accessedAt: "2026-11-01", facts: [text], reservations: [] }], watch: {} });
    assert.ok((await w.publications.reviewWatchDraft({ id: "alice" }, agent, id, { action: "approve", revision: draft.revision })).ok);
    return id;
  };
  const usda = await publish(USDA, "NASA, USDA Sign Agreement to Advance Agricultural Data");
  const x59 = await publish(X59, "NASA’s X-59 Completes First Flight");
  const personal = (await w.topics.openPersonal("alice", "x-59", "X-59")).topic;
  const nasa = await w.sources.propose("alice", { url: "https://www.nasa.gov/feed/", publisher: "NASA", topicIds: [run.topicId], kind: "feed", site: null, reliability: { level: "inconnue", reasons: [], estimated: true } }, "alice");

  // Make it a legacy vault: `<uuid>.md` records, truncated message and source names, links to them.
  // Publications are numbered in creation order: USDA first, X-59 second.
  const folderOf = async (id: string) => join(w.root, "posts", "_generators", agent, (await readdir(join(w.root, "posts", "_generators", agent))).find(name => name.startsWith("post_") && name.endsWith(id === usda ? "_001" : "_002"))!);
  for (const id of [usda, x59]) {
    const dir = await folderOf(id), rel = dir.slice(w.root.length + 1);
    const { files } = await readMarkdownTree(dir);
    const renames: [string, string][] = [];
    for (const name of files.keys()) {
      const m = /^(_sources\/)?(\d+)_(.+)\.md$/.exec(name);
      if (!m) continue;
      const text = m[1] ? (id === usda ? "NASA, USDA Sign Agreement to Advance Agricultural Data" : "NASA’s X-59 Completes First Flight") : (id === usda ? USDA : X59);
      renames.push([name, `${m[1] ?? ""}${m[2]}_${legacySlug(text)}.md`]);
    }
    for (const [from, to] of renames) if (from !== to) await rename(join(dir, from), join(dir, to));
    for (const [name, content] of (await readMarkdownTree(dir)).files) {
      let next = content;
      for (const [from, to] of renames) next = next.split(`[[${rel}/${from.replace(/\.md$/, "")}`).join(`[[${rel}/${to.replace(/\.md$/, "")}`);
      if (next !== content) await writeFile(join(dir, name), next);
    }
  }
  for (const [dir, id, file] of [[join(w.root, "topics"), run.topicId, "astronomie.md"], [join(w.root, ".xi-personal-topics", "alice"), personal.id, "x-59.md"], [join(w.root, "watch", "sources"), nasa.source.id, "nasa-gov-feed.md"]] as const) await rename(join(dir, file), join(dir, `${id}.md`));
  // The legacy vault is fully readable before any migration (a fresh store is a restart of the app).
  const restart = () => { w.publications = createPublicationStore({ vault: w.vault, db: w.db }); };
  restart();
  const before = await w.publications.get({ id: "alice" }, usda);
  assert.equal(before.messages[0].body.includes("moderniser"), true);
  assert.equal((await w.topics.visible("alice")).personal[0].id, personal.id);
  // Knowledge learned at the legacy revision.
  migrateAgentKnowledge(w.db);
  w.db.prepare("INSERT INTO xi_agent_knowledge VALUES (?, ?, ?, ?, ?, ?)").run("alice", agent, usda, before.revision, personal.id, USDA);
  assert.equal((await w.publications.agentMemory("alice", agent, "private")).length, 1);

  // Dry run: a plan, nothing written.
  const snapshot = async () => JSON.stringify(await Promise.all([join(w.root, "topics"), join(w.root, ".xi-personal-topics", "alice"), join(w.root, "watch", "sources"), await folderOf(usda), join(await folderOf(usda), "_sources")].map(dir => readdir(dir).then(names => names.sort()))));
  const untouched = await snapshot();
  const plan = await planVaultNames(w.root);
  assert.deepEqual(plan.problems, []);
  assert.deepEqual(plan.records.map(item => item.to.split("/").at(-1)).sort(), ["astronomie.md", "nasa-gov-feed.md", "x-59.md"]);
  assert.deepEqual(plan.folders.flatMap(folder => folder.renames.map(item => item.to)).sort(), [
    "1_accord_entre_nasa_et_usda_vise_a_moderniser_les_donnees.md", "1_nasa_test_pilot_mike_lippert_successfully_completed_a_flight_of.md",
    "_sources/1_nasa_usda_sign_agreement_to_advance_agricultural_data.md", "_sources/1_nasa_x-59_completes_first_flight.md",
  ]);
  assert.equal(await snapshot(), untouched);

  // Apply: backup first (outside the vault only), then renames.
  await assert.rejects(applyVaultNames(w.root, { db: w.db, backupDir: join(w.root, "sauvegarde") }), /hors du vault/);
  const result = await applyVaultNames(w.root, { db: w.db, backupDir: `${w.root}-backup` });
  assert.ok((await readdir(join(result.backup.vault, "topics"))).includes(`${run.topicId}.md`), "la sauvegarde garde l’état d’origine");
  assert.equal(new Database(result.backup.database!, { readonly: true }).prepare("SELECT revision FROM xi_agent_knowledge").pluck().get(), before.revision);
  assert.equal(result.knowledge, 1);

  // Same data through the stores after the restart; every link resolves to an existing file.
  restart();
  const after = await w.publications.get({ id: "alice" }, usda);
  // Bodies are identical except for the path of their link to the renamed source file.
  const unlinked = (body: string) => body.replace(/\[\[[^\]|]*\|?/g, "[[");
  assert.deepEqual([after.id, after.messages.map(m => unlinked(m.body)), after.sources.map(s => [s.title, s.url])], [before.id, before.messages.map(m => unlinked(m.body)), before.sources.map(s => [s.title, s.url])]);
  assert.match(after.messages[0].body, /_sources\/1_nasa_usda_sign_agreement_to_advance_agricultural_data\|/);
  assert.notEqual(after.revision, before.revision);
  for (const id of [usda, x59]) {
    const dir = await folderOf(id);
    for (const [, content] of (await readMarkdownTree(dir)).files) for (const [, target] of content.matchAll(/\[\[([^\]|#]+)/g)) {
      assert.ok((await readdir(join(w.root, ...target.split("/").slice(0, -1)))).includes(`${target.split("/").at(-1)}.md`), `lien cassé : ${target}`);
    }
  }
  assert.deepEqual(await w.publications.agentMemory("alice", agent, "private"), [{ publication: usda, topic: personal.id, excerpt: USDA }], "la connaissance suit la nouvelle révision");
  assert.deepEqual((await w.topics.visible("alice")).personal.map(topic => topic.id), [personal.id]);
  assert.equal((await w.topics.visible("bob")).personal.length, 0);
  assert.equal((await w.sources.list("alice")).sources[0].id, nasa.source.id);
  assert.equal((await w.sources.list("bob")).sources.length, 0);
  assert.equal((await w.topics.list()).find(topic => topic.id === run.topicId)?.tag, "astronomie");

  // Idempotent: nothing left to do, and a rerun changes nothing.
  assert.deepEqual(await planVaultNames(w.root), { records: [], folders: [], problems: [] });
  await rm(`${w.root}-backup`, { recursive: true, force: true });
  assert.equal((await applyVaultNames(w.root, { db: w.db, backupDir: `${w.root}-backup` })).knowledge, 0);
  assert.equal(await w.publications.agentMemory("alice", agent, "private").then(rows => rows.length), 1);

  // A swap interrupted between its two renames is finished by the next run, without loss.
  const dir = await folderOf(x59), name = dir.split("/").at(-1)!;
  await rename(dir, join(dir, "..", `.${name}.previous`));
  await rm(`${w.root}-backup`, { recursive: true, force: true });
  await applyVaultNames(w.root, { db: w.db, backupDir: `${w.root}-backup` });
  restart();
  assert.ok((await readdir(join(dir, ".."))).includes(name));
  assert.equal((await w.publications.get({ id: "alice" }, x59)).messages[0].body.includes("X-59"), true);

  // New content gets readable names directly.
  const fresh = await publish("La mission Perseverance a capturé une image de la région 'Tinga'.", "Tinga's Tale");
  const freshDir = join(w.root, "posts", "_generators", agent, (await readdir(join(w.root, "posts", "_generators", agent))).filter(item => item.startsWith("post_")).sort().at(-1)!);
  assert.ok((await readdir(freshDir)).includes("1_la_mission_perseverance_a_capture_une_image_de_la_region.md"));
  assert.ok((await readdir(join(freshDir, "_sources"))).includes("1_tinga_tale.md"));
  assert.ok((await w.publications.get({ id: "alice" }, fresh)).id === fresh);
});
