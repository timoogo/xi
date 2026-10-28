import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { chromium, type Browser } from "playwright-core";
import { Document, stringify } from "yaml";
import { BUILTIN_PRESETS } from "../src/lib/accounts/types";
import { serializeGenerator } from "../src/lib/graph/format";
import { createPublicationStore } from "../src/lib/publications/store";
import { openVault } from "../src/lib/publications/vault";
import type { Topic } from "../src/lib/topics/types";
import { createTestServer } from "./helpers/next-server";

const at = "2026-10-27T00:00:00.000Z";

test("universal search: #topic, former tags, unknown tags, @agents, crossed search and agent isolation", { timeout: 120_000 }, async t => {
  const app = await createTestServer();
  const resources: { browser?: Browser } = {};
  t.after(async () => { await resources.browser?.close(); await app.dispose(); });

  // Catalogue and agents written as Markdown: the stores reconcile their index from the vault.
  const topic = (tag: string, name: string, extra: Partial<Topic> = {}): Topic => ({ id: randomUUID(), tag, name, description: "", scope: `Actualité ${name.toLowerCase()}`, parentId: null, relatedIds: [], aliases: [], createdAt: at, updatedAt: at, createdBy: "seed", updatedBy: "seed", revision: randomUUID(), ...extra });
  const climate = topic("climat", "Climat");
  const politics = topic("politiks", "Politique", { relatedIds: [climate.id] });
  const france = topic("politiks.france", "Politique française", { parentId: politics.id, aliases: ["politiks.hexagone"], description: "Institutions et vie politique." });
  await mkdir(join(app.vaultPath, "topics"), { recursive: true });
  for (const item of [climate, politics, france]) await writeFile(join(app.vaultPath, "topics", `${item.id}.md`), `---\n${stringify(item)}---\n`);
  const editorial = (primaryTopicId: string) => ({ primaryTopicId, secondaryTopicIds: [], presetId: BUILTIN_PRESETS[0].id, presetVersion: 1, settings: BUILTIN_PRESETS[0].settings, active: true, modelRef: null, validationMode: "human", updatedAt: at, updatedBy: "seed", revision: randomUUID() });
  const agents = { public: randomUUID(), private: randomUUID() };
  for (const [slug, id, visibility] of [["veille-france", agents.public, "public"], ["secret-france", agents.private, "private"]] as const) {
    await mkdir(join(app.vaultPath, "generators", slug), { recursive: true });
    await writeFile(join(app.vaultPath, "generators", slug, "index.md"), serializeGenerator({ id, slug, title: slug, ownerId: "someone-else", visibility, createdAt: at }, "", new Document({ editorial: editorial(france.id) })));
  }

  await app.migrate();
  // Publications of another user, topics declared in the frontmatter (no hashtag in their text).
  const db = new Database(app.databasePath);
  const store = createPublicationStore({ vault: await openVault(app.vaultPath), db });
  const author = { id: "someone-else" };
  async function publish(body: string, visibility: "public" | "private", topics: string[]) {
    const id = await store.create(author);
    const draft = await store.getEditable(author, id);
    const saved = await store.save(author, id, { baseRevision: draft.revision, summary: "", visibility, messages: [{ key: "a", file: null, body }] });
    assert.ok(saved.ok);
    await store.publish(author, id, saved.snapshot.revision);
    const { path } = db.prepare<[string], { path: string }>("SELECT path FROM publication WHERE id = ?").get(id)!;
    const file = join(app.vaultPath, path, "index.md");
    await writeFile(file, (await readFile(file, "utf8")).replace(/^---\n/, `---\ntopics: [${topics.join(", ")}]\nprimary_topic: ${topics[0]}\n`));
    return id;
  }
  const lyon = await publish("Les scrutins municipaux à Lyon.", "public", [france.id]);
  await publish("Scrutin confidentiel préparé en privé.", "private", [france.id, climate.id]);
  await publish("Les élections et la canicule.", "public", [france.id, climate.id]);
  // Lot 5: a durable discovery record (as the worker writes it) associating the Lyon publication with Climat by
  // inference, plus a concept without a topic.
  const revision = (await store.publicPublications()).find(p => p.id === lyon)!.revision;
  await mkdir(join(app.vaultPath, "topic-discovery"), { recursive: true });
  const concept = (key: string, label: string, topicId: string | null) => ({ key, label, topicId, match: topicId ? "inferred" : null, via: "model", excerpt: "Les scrutins municipaux à Lyon.", from: `publication:${lyon}` });
  await writeFile(join(app.vaultPath, "topic-discovery", `${lyon}.md`), `---\n${stringify({ publication: lyon, revision, author: "someone-else", analyzedAt: at, pipeline: "xi-discovery-v1", mode: "model", model: "fake-local", pendingInference: false, concepts: [concept("climat", "Climat", climate.id), concept("scrutin municipal", "Scrutin municipal", null)], relations: [] })}---\n`);
  db.close();
  await app.start();
  const browser = resources.browser = await chromium.launch({ executablePath: process.env.XI_E2E_CHROME ?? "/usr/bin/google-chrome-stable", headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  page.setDefaultTimeout(12_000);
  const signup = await context.request.post(`${app.origin}/api/auth/sign-up/email`, { headers: { Origin: app.origin }, data: { name: "Searcher", email: "search@example.com", password: "search browser password" } });
  assert.equal(signup.status(), 200);

  // The search form works from the explore page (mobile) without hashtags in any publication.
  await page.goto(`${app.origin}/dashboard/explore`);
  const search = page.getByRole("searchbox", { name: /Rechercher/ });
  await search.fill("#Politiks.France");
  await search.press("Enter");
  await page.waitForURL(`${app.origin}/dashboard/topics/politiks.france`);
  await page.getByRole("heading", { name: "Politique française", level: 1 }).waitFor();
  await page.getByText("Institutions et vie politique.").waitFor();
  const hierarchy = page.getByRole("region", { name: "Hiérarchie" });
  await hierarchy.getByRole("link", { name: /Politique #politiks/ }).waitFor();
  const experts = page.getByRole("region", { name: "ΞAgents spécialisés" });
  await experts.getByRole("link", { name: /veille-france/ }).waitFor();
  assert.equal(await experts.getByText("secret-france").count(), 0, "a private agent of another user is never listed");
  const topicPublications = page.getByRole("region", { name: "Publications déclarées sur Politique française" });
  await topicPublications.getByText("Les scrutins municipaux à Lyon.").waitFor();
  await topicPublications.getByText("Les élections et la canicule.").waitFor();
  assert.equal(await page.getByText("Scrutin confidentiel").count(), 0, "a private publication of another user is never listed");

  // Former tag → canonical page; unknown tag → search page with suggestions; malformed tag → 404.
  await page.goto(`${app.origin}/dashboard/topics/politiks.hexagone`);
  await page.waitForURL(`${app.origin}/dashboard/topics/politiks.france`);
  await page.getByText("Les scrutins municipaux à Lyon.").waitFor();
  await page.goto(`${app.origin}/dashboard/topics/france-politique`);
  await page.waitForURL(/\/dashboard\/explore\?q=%23france-politique$/);
  await page.getByText(": aucun topic ne porte ce tag.").waitFor();
  await page.getByRole("link", { name: /Politique française #politiks.france/ }).waitFor();
  assert.equal((await context.request.get(`${app.origin}/dashboard/topics/${encodeURIComponent("#!")}`)).status(), 404);

  // A unique last segment resolves; @agents open their profile; private ones of others stay invisible.
  await page.goto(`${app.origin}/dashboard/explore?q=${encodeURIComponent("#france")}`);
  await page.waitForURL(`${app.origin}/dashboard/topics/politiks.france`);
  await page.goto(`${app.origin}/dashboard/explore?q=${encodeURIComponent("@Veille-France")}`);
  await page.waitForURL(`${app.origin}/dashboard/profiles/${agents.public}`);
  await page.goto(`${app.origin}/dashboard/explore?q=${encodeURIComponent("@secret-france")}`);
  await page.getByText(": aucun ΞAgent visible ne porte ce handle.").waitFor();
  assert.equal(await page.getByRole("link", { name: /secret-france/ }).count(), 0);

  // Crossed search shows the declared links; plain text matches names and scopes.
  await page.goto(`${app.origin}/dashboard/explore?q=${encodeURIComponent("#politiks #climat #politiks.france")}`);
  await page.getByRole("heading", { name: "Recherche croisée" }).waitFor();
  await page.getByText("Politique ↔ relation déclarée ↔ Climat").waitFor();
  await page.getByText("Politique → spécialisé par → Politique française").waitFor();
  // Crossed publications: associated with every topic, read by id; no relation is claimed.
  await page.goto(`${app.origin}/dashboard/explore?q=${encodeURIComponent("#politiks.hexagone #climat")}`);
  const crossed = page.getByRole("region", { name: "Publications trouvées" });
  await crossed.getByText("Les élections et la canicule.").waitFor();
  assert.equal(await crossed.getByText("Les scrutins municipaux à Lyon.").count(), 0);
  await page.getByText("Ce croisement ne constitue pas une relation entre eux.").waitFor();
  // Full text: case, accents and plurals; private content of others never matches.
  await page.goto(`${app.origin}/dashboard/explore?q=${encodeURIComponent("SCRUTIN municipal")}`);
  await page.getByRole("region", { name: "Publications trouvées" }).getByText("Les scrutins municipaux à Lyon.").waitFor();
  await page.goto(`${app.origin}/dashboard/explore?q=${encodeURIComponent("confidentiel")}`);
  await page.getByText("Aucune publication accessible ne correspond à cette recherche.").waitFor();
  await page.goto(`${app.origin}/dashboard/explore?q=${encodeURIComponent("climat")}`);
  await page.getByRole("region", { name: "Topics correspondants" }).getByRole("link", { name: /Climat #climat/ }).waitFor();
  // Lot 5: inferred associations are listed apart from declared publications, with their evidence; concepts without
  // a topic are shown on the management page, never created.
  await page.goto(`${app.origin}/dashboard/topics/climat`);
  const inferredRegion = page.getByRole("region", { name: "Associations inférées" });
  await inferredRegion.getByText("Concept « Climat » identifié par le modèle local fake-local").waitFor();
  await inferredRegion.getByText("« Les scrutins municipaux à Lyon. »").waitFor();
  await page.goto(`${app.origin}/dashboard/topics`);
  const discovered = page.getByRole("region", { name: "Concepts découverts" });
  await discovered.getByRole("listitem", { name: "Concept Scrutin municipal" }).getByText("observé").waitFor();
  // Lot 3: submitting an unknown #tag opens a new personal topic; subscribing only records the interest.
  await page.goto(`${app.origin}/dashboard/explore`);
  await page.getByRole("searchbox", { name: /Rechercher/ }).fill("#Essence");
  const personalOwners = () => readdir(join(app.vaultPath, ".xi-personal-topics")).catch(() => [] as string[]);
  assert.deepEqual(await personalOwners(), [], "typing creates nothing");
  await page.getByRole("searchbox", { name: /Rechercher/ }).press("Enter");
  await page.waitForURL(`${app.origin}/dashboard/topics/essence`);
  await page.getByText("Topic personnel", { exact: true }).waitFor();
  assert.equal(await page.getByRole("link", { name: "Fiche de gestion" }).count(), 0);
  await page.getByRole("button", { name: "S’abonner" }).click();
  await page.getByRole("button", { name: "Abonné" }).waitFor();
  const [owner] = await personalOwners();
  const [topicFile] = await readdir(join(app.vaultPath, ".xi-personal-topics", owner));
  const topicId = topicFile.replace(/\.md$/, "");
  assert.match(await readFile(join(app.vaultPath, "posts", "_users", owner, "feed.md"), "utf8"), new RegExp(`topics:\\s*\\n\\s*- ${topicId}`));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.reload();
  await page.getByRole("region", { name: "Sujets suivis" }).getByRole("link", { name: /Essence #essence/ }).waitFor();
  await page.getByRole("button", { name: "Abonné" }).click();
  await page.getByRole("button", { name: "S’abonner" }).waitFor();
  await page.getByText("Abonnez-vous à un topic depuis sa page").waitFor();
  assert.deepEqual(await readdir(join(app.vaultPath, "generators")).then(names => names.filter(name => !name.startsWith(".")).sort()), ["secret-france", "veille-france"], "no ΞAgent created");

  // Lot 4: the declared relation is shown with its provenance; a non-creator hides it for themselves only,
  // and a relation they add (here to their personal topic) is stored in their private space.
  await page.goto(`${app.origin}/dashboard/topics/politiks`);
  const related = page.getByRole("region", { name: "Topics liés" });
  const declared = related.getByRole("listitem", { name: "Lié à Climat" });
  await declared.getByText("Déclarée dans la fiche du topic par son créateur").waitFor();
  assert.equal(await related.getByRole("button", { name: "Exclure pour tous" }).count(), 0, "not a creator");
  await declared.getByRole("button", { name: "Masquer pour moi" }).click();
  await related.getByRole("heading", { name: "Masquées pour vous" }).waitFor();
  await related.getByText("Aucune relation établie.").waitFor();
  assert.match(await readFile(join(app.vaultPath, ".xi-personal-topics", owner, "relation-exclusions.md"), "utf8"), new RegExp(`declared:`));
  await related.getByRole("button", { name: "Rétablir pour moi" }).click();
  await related.getByRole("listitem", { name: "Lié à Climat" }).getByRole("button", { name: "Masquer pour moi" }).waitFor();
  await related.getByText("Ajouter une relation").click();
  await related.getByLabel("Type").selectOption("influences");
  await related.getByLabel("Topic").selectOption({ label: "Essence (#essence)" });
  await related.getByLabel("Justification").fill("Le prix du carburant pèse sur le débat politique.");
  await related.getByRole("button", { name: "Ajouter la relation" }).click();
  await page.getByRole("region", { name: "Topics liés" }).getByRole("listitem", { name: "Influence Essence" }).getByText("personnelle").waitFor();
  assert.equal((await readdir(join(app.vaultPath, ".xi-personal-topics", owner, "relations"))).length, 1);
  assert.equal(await readdir(join(app.vaultPath, "topic-relations")).then(names => names.filter(name => name.endsWith(".md")).length, () => 0), 0);

  // Another user never sees it; opening the URL creates nothing for them until they ask explicitly.
  const other = await browser.newContext();
  const otherPage = await other.newPage();
  assert.equal((await other.request.post(`${app.origin}/api/auth/sign-up/email`, { headers: { Origin: app.origin }, data: { name: "Other", email: "other@example.com", password: "other browser password" } })).status(), 200);
  await otherPage.goto(`${app.origin}/dashboard/topics/politiks`);
  await otherPage.getByRole("region", { name: "Topics liés" }).getByRole("listitem", { name: "Lié à Climat" }).waitFor();
  assert.equal(await otherPage.getByText("Essence").count(), 0, "a personal relation never reveals the personal topic");
  await otherPage.goto(`${app.origin}/dashboard/topics/essence`);
  await otherPage.waitForURL(/\/dashboard\/explore\?q=%23essence$/);
  await otherPage.getByText(": aucun topic ne porte ce tag.").waitFor();
  assert.deepEqual(await personalOwners(), [owner]);
  await otherPage.getByRole("button", { name: "Créer et ouvrir ma fiche personnelle #essence" }).click();
  await otherPage.waitForURL(`${app.origin}/dashboard/topics/essence`);
  await otherPage.getByRole("button", { name: "S’abonner" }).waitFor();
  assert.equal((await personalOwners()).length, 2);
  await other.close();
  assert.deepEqual(errors, []);
});
