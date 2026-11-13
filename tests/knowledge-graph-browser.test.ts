import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import Database from "better-sqlite3";
import { chromium } from "playwright-core";
import { createTestServer } from "./helpers/next-server";
import { openVault } from "../src/lib/publications/vault";
import { createPublicationStore } from "../src/lib/publications/store";
import { createTopicStore } from "../src/lib/topics/store";
import { createTopicRelationStore } from "../src/lib/topics/relations";
import { createAccountStore } from "../src/lib/accounts/store";

/**
 * Graphe → Connaissances in Chromium, on a production build: knowledge learned by a real Konstruktor pipeline (local
 * fake Ollama), human decisions recorded in the vault, then navigation, selection, provenance, exclusions, empty
 * state, other modes intact, mobile, and another user's access.
 */
test("graphe des connaissances : ΞAgents, concepts, relations, provenance, décisions et confidentialité", { timeout: 240_000 }, async t => {
  const ollama = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer);
    const data = JSON.parse(Buffer.concat(chunks).toString());
    const text: string = (data.messages?.[1]?.content ?? "").replace(/^Texte :\n/, "").split("\n")[0];
    const pairs = (text.match(/[^.]+\./g) ?? []).map(sentence => sentence.trim()).filter(sentence => /utilise|influence/.test(sentence))
      .map(sentence => { const words = sentence.replace(/\.$/, "").split(" "); return { sentence, from: words[0], to: words.at(-1)! }; });
    const content = JSON.stringify({
      concepts: pairs.flatMap(({ from, to }) => [{ name: from }, { name: to }]),
      relations: pairs.map(({ sentence, from, to }) => ({ from, link: sentence.slice(sentence.indexOf(from) + from.length, sentence.lastIndexOf(to)).trim(), to, type: sentence.includes("influence") ? "influences" : "related_to", confidence: 0.8 })),
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: { content }, response: content, done: true }));
  });
  ollama.listen(0, "127.0.0.1"); await once(ollama, "listening");
  const address = ollama.address(); assert.ok(address && typeof address !== "string");
  const app = await createTestServer({ XI_INFERENCE_URL: `http://127.0.0.1:${address.port}`, XI_INFERENCE_MODEL: "test" });
  const fixtureDb = new Database(":memory:");
  const browser = await chromium.launch({ executablePath: process.env.XI_E2E_CHROME ?? "/usr/bin/google-chrome-stable", headless: true });
  t.after(async () => { await browser.close(); fixtureDb.close(); await app.dispose(); await new Promise<void>(resolve => ollama.close(() => resolve())); });
  await app.migrate(); await app.start();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const signed = await context.request.post(`${app.origin}/api/auth/sign-up/email`, { headers: { Origin: app.origin }, data: { name: "Alice", email: "knowledge@example.com", password: "knowledge test password" } });
  assert.equal(signed.status(), 200);
  const owner = (await signed.json()).user.id as string;

  const vault = await openVault(app.vaultPath);
  const topics = createTopicStore({ vault, db: fixtureDb });
  const accounts = createAccountStore({ vault, db: fixtureDb, topics });
  const publications = createPublicationStore({ vault, db: fixtureDb });
  const relations = createTopicRelationStore({ vault, db: fixtureDb, topics, readable: async (_viewer, ids) => new Set(ids) });
  const agentOf = async (name: string) => {
    const run = await topics.propose(owner, `Espace ${name}`);
    await topics.confirm(owner, run.id, { tag: name.toLowerCase(), name, description: "", scope: "Espace", parentId: null, relatedIds: [] }, true);
    const proposal = await accounts.propose(owner, run.topicId), ready = await accounts.resume(owner, proposal.id);
    await accounts.confirm(owner, ready.id, ready.draft, true);
    return { id: ready.accountId, topic: run.topicId };
  };
  const publish = async (agent: { id: string; topic: string }, text: string) => {
    const id = randomUUID();
    const draft = await publications.saveWatchDraft(owner, agent.id, { id, summary: text, topicIds: [agent.topic], messages: [{ body: text, sources: [0] }], sources: [{ url: "https://agence.example/depeche", title: "Dépêche spatiale", publisher: "Agence Orbitale", accessedAt: "2026-11-01", facts: [text], reservations: [] }], watch: {} });
    assert.ok((await publications.reviewWatchDraft({ id: owner }, agent.id, id, { action: "approve", revision: draft.revision })).ok);
    return id;
  };
  const astronoxi = await agentOf("Astronoxi"), orbites = await agentOf("Orbites"), vide = await agentOf("Vide");
  const p1 = await publish(astronoxi, "Asterion-47 utilise le moteur Helios-9. Helios-9 influence la trajectoire Orbite-3.");
  const p2 = await publish(astronoxi, "Vega-2 utilise le moteur Helios-9. Lyra-5 utilise le capteur Kappa-1.");
  // Another agent of the same owner learning one of the same relations from its own publication.
  const p3 = await publish(orbites, "Asterion-47 utilise le moteur Helios-9.");
  for (const id of [p1, p2, p3]) {
    let status = 0;
    for (let attempt = 0; status !== 200 && attempt < 40; attempt++) { status = (await context.request.get(`${app.origin}/api/publications/${id}`)).status(); if (status !== 200) await new Promise(resolve => setTimeout(resolve, 250)); }
    assert.equal(status, 200);
  }

  // Real knowledge pipeline runs (the « run #2 » of the request is any such run).
  for (const agent of [astronoxi, orbites]) {
    const started = await context.request.post(`${app.origin}/api/konstruktor/pipelines`, { headers: { Origin: app.origin }, data: { agent: agent.id, mode: "missing" } });
    assert.equal(started.status(), 200);
    const runId = (await started.json()).run.id as string;
    let status = "";
    for (let attempt = 0; status !== "success" && attempt < 80; attempt++) {
      status = (await (await context.request.get(`${app.origin}/api/konstruktor/pipelines/${runId}`)).json()).run.status;
      if (status !== "success") await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.equal(status, "success");
  }

  // Human decisions, recorded in the vault like the topic page does: validation, correction, exclusion.
  const catalog = await topics.visible(owner);
  const topic = (tag: string) => catalog.personal.find(item => item.tag === tag)!.id;
  const mine = async () => {
    const views = await relations.relationsOf(owner, topic("helios-9"));
    return [...views.visible, ...views.proposed, ...views.excluded];
  };
  const between = async (tag: string) => (await mine()).find(view => view.other.id === topic(tag))!;
  await relations.correct(owner, (await between("orbite-3")).id, { status: "accepted" });
  await relations.correct(owner, (await between("vega-2")).id, { type: "part_of", reason: "Le moteur est un composant." });
  const lyra = (await relations.relationsOf(owner, topic("kappa-1"))).proposed[0];
  await relations.correct(owner, lyra.id, { status: "excluded", reason: "Lien trop vague." });

  const page = await context.newPage(); page.setDefaultTimeout(20_000);
  const nodes = () => page.locator("[data-concept-id]");
  const concept = (name: string) => page.getByRole("button", { name: new RegExp(`^${name}, #`) });
  await page.goto(`${app.origin}/dashboard/graph`);
  await page.getByRole("navigation", { name: "Mode du graphe" }).getByRole("link", { name: "Connaissances" }).click();
  await page.waitForURL(/view=knowledge/);
  // One agent by default, the first by name; the picker toggles agents one by one, or all of them.
  const picker = page.getByRole("toolbar", { name: "Outils des connaissances" }).locator("details");
  const toggle = async (name: string) => {
    if (await picker.getAttribute("open") === null) await picker.locator("summary").click();
    await picker.getByRole("checkbox", { name }).click();
  };
  assert.equal(await picker.locator("summary").getAttribute("aria-label"), "ΞAgents affichés : Astronoxi");
  await concept("Helios-9").waitFor();
  assert.equal(await nodes().count(), 6);
  // Excluded relations are not drawn by default; the validated, proposed and corrected ones are.
  assert.equal(await page.locator('[data-edge-id][data-status="excluded"]').count(), 0);
  assert.equal(await page.locator('[data-edge-id][data-status="accepted"]').count(), 1);
  assert.equal(await page.locator('[data-edge-id][data-status="proposed"]').count(), 2);

  // Concept panel: relations, provenance, quotes, web sources.
  await concept("Helios-9").click();
  const panel = page.locator('[data-panel="concept"]');
  await panel.getByRole("heading", { name: "Helios-9" }).waitFor();
  // Helios → Orbite (influence) is outgoing; the corrected « part of » keeps the stored order of its ends; « lié à »
  // is symmetric, never outgoing nor incoming.
  await panel.getByText("Relations symétriques (1)").waitFor();
  assert.match(await panel.locator('section[aria-labelledby="concept-out"]').textContent() ?? "", /Influence\s*Orbite-3/);
  const oriented = await panel.evaluate(element => [...element.querySelectorAll("h3")].map(h => h.textContent ?? "").filter(text => /sortantes|entrantes/.test(text)).map(text => Number(/\((\d+)\)/.exec(text)![1])));
  assert.equal(oriented[0] + oriented[1], 2);
  await panel.locator("[data-provenance]").nth(1).waitFor();
  assert.equal(await panel.locator("[data-provenance]").count(), 2);
  await panel.getByText("« Asterion-47 utilise le moteur Helios-9. »").waitFor();
  assert.equal(await panel.getByRole("link", { name: "Dépêche spatiale" }).first().getAttribute("href"), "https://agence.example/depeche");
  await mkdir("artifacts/knowledge-graph", { recursive: true });
  await page.screenshot({ path: "artifacts/knowledge-graph/concept-desktop.png" });

  // Relation panel: nature, both concepts, status, evidence; then the corrected one.
  await panel.getByRole("button", { name: "Influence", exact: true }).click();
  const relation = page.locator('[data-panel="relation"]');
  await relation.getByRole("heading", { name: "Influence" }).waitFor();
  await relation.getByText("Relation orientée").waitFor();
  await relation.getByText("Validée", { exact: true }).waitFor();
  await relation.getByText("« Helios-9 influence la trajectoire Orbite-3. »").waitFor();
  await relation.getByRole("button", { name: "Orbite-3" }).waitFor();
  await page.screenshot({ path: "artifacts/knowledge-graph/relation-desktop.png" });
  await relation.getByRole("button", { name: "Helios-9" }).click();
  await panel.getByRole("button", { name: /^(Comprend|Fait partie de)$/ }).click();
  await relation.locator("[data-correction]").getByText("« Lié à » → « Fait partie de »", { exact: false }).waitFor();
  await relation.getByText("Proposée, à examiner").waitFor();

  // The publication of origin opens.
  await relation.getByRole("button", { name: "Helios-9" }).click();
  await panel.locator(`[data-provenance="${p1}"] a`).first().click();
  await page.waitForURL(new RegExp(`/dashboard/publications/${p1}$`));
  await page.goBack();
  await concept("Helios-9").waitFor();

  // Exclusions on request only, never as validated.
  await page.getByRole("button", { name: /^Exclues/ }).click();
  await page.waitForURL(/excluded=1/);
  await page.locator('[data-edge-id][data-status="excluded"]').waitFor();
  await page.locator('[data-edge-id][data-status="excluded"]').click();
  await relation.getByText("Exclue", { exact: true }).waitFor();
  await relation.getByText("Lien trop vague.", { exact: false }).waitFor();

  // Zoom, recentre, list, keyboard.
  const before = await concept("Helios-9").evaluate(element => element.parentElement!.getAttribute("transform"));
  await page.getByRole("button", { name: "Zoom avant" }).click();
  assert.notEqual(await concept("Helios-9").evaluate(element => element.parentElement!.getAttribute("transform")), before);
  await page.getByRole("button", { name: "Recentrer le graphe" }).click();
  await page.getByRole("button", { name: /Liste/ }).click();
  await page.getByRole("heading", { name: "Liste des connaissances" }).waitFor();
  await page.locator('section[aria-labelledby="knowledge-list-title"]').getByRole("button", { name: /^Vega-2 #vega-2/ }).click();
  await page.locator('[data-panel="concept"]').getByRole("heading", { name: "Vega-2" }).waitFor();
  await concept("Vega-2").focus();
  await page.keyboard.press("Enter");

  // Several agents: one node per concept, marked when shared; one edge per relation, each agent's evidence apart.
  await toggle("Orbites");
  await page.waitForURL(new RegExp(`agents=${astronoxi.id}(%2C|,)${orbites.id}`));
  await page.locator("summary[aria-label='ΞAgents affichés : Astronoxi et Orbites']").waitFor();
  await concept("Helios-9").waitFor();
  assert.equal(await concept("Helios-9").count(), 1);
  assert.equal(await nodes().count(), 6);
  assert.equal(await page.locator('[data-shared-by="2"]').count(), 2, "Asterion-47 et Helios-9");
  await concept("Helios-9").click();
  await panel.locator("[data-known-by]").getByText("Connu de Astronoxi et Orbites.").waitFor();
  await panel.locator(`[data-agent-provenance="${orbites.id}"] [data-provenance="${p3}"]`).waitFor();
  assert.equal(await panel.locator(`[data-agent-provenance="${astronoxi.id}"] [data-provenance]`).count(), 2);
  await panel.locator('section[aria-labelledby="concept-sym"]').getByRole("button").first().click();
  await relation.locator("[data-labels]").getByText("Asterion-47 utilise le moteur Helios-9").waitFor();
  assert.equal(await relation.locator("[data-agent-evidence]").count(), 2);
  await relation.locator(`[data-agent-evidence="${orbites.id}"]`).getByText("« Asterion-47 utilise le moteur Helios-9. »").waitFor();
  await page.screenshot({ path: "artifacts/knowledge-graph/relation-agents-desktop.png" });
  await toggle("Tous les ΞAgents");
  await page.waitForURL(/agents=all/);
  await page.locator("summary[aria-label='ΞAgents affichés : Astronoxi, Orbites et Vide']").waitFor();

  // Empty agent (the others unticked); the two other modes still render.
  await toggle("Astronoxi");
  await page.waitForURL(new RegExp(`agents=${orbites.id}(%2C|,)${vide.id}`));
  await toggle("Orbites");
  await page.waitForURL(new RegExp(`agents=${vide.id}(&|$)`));
  await page.getByText("Aucune connaissance").waitFor();
  assert.equal(await page.getByRole("link", { name: "Ouvrir les pipelines" }).getAttribute("href"), `/dashboard/konstruktor/pipelines?agent=${vide.id}`);
  await page.getByRole("navigation", { name: "Mode du graphe" }).getByRole("link", { name: "Réseau Topics" }).click();
  await page.locator("[data-topic-network]").waitFor();
  await page.getByRole("navigation", { name: "Mode du graphe" }).getByRole("link", { name: "Arbre actuel" }).click();
  await page.waitForURL(`${app.origin}/dashboard/graph`);
  assert.equal(await page.locator("[data-knowledge-network]").count(), 0);

  // Mobile: no horizontal scroll, bottom-sheet panel.
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, storageState: await context.storageState() });
  t.after(() => mobile.close());
  const phone = await mobile.newPage(); phone.setDefaultTimeout(20_000);
  await phone.goto(`${app.origin}/dashboard/graph?view=knowledge&agent=${astronoxi.id}`);
  await phone.getByRole("button", { name: /^Helios-9, #/ }).click();
  await phone.locator('[data-panel="concept"] [data-provenance]').first().waitFor();
  const overflow = await phone.evaluate(() => ({ width: document.documentElement.scrollWidth, wide: [...document.querySelectorAll("body *")].filter(element => element.getBoundingClientRect().right > 391).slice(0, 6).map(element => `${element.tagName.toLowerCase()}.${String(element.getAttribute("class") ?? "").slice(0, 60)} ${Math.round(element.getBoundingClientRect().right)}`) }));
  assert.ok(overflow.width <= 390, `pas de défilement horizontal : ${JSON.stringify(overflow)}`);
  await phone.screenshot({ path: "artifacts/knowledge-graph/concept-mobile.png" });
  await phone.locator('[data-panel="concept"]').getByRole("button", { name: "Fermer la fiche du concept" }).click();
  await phone.screenshot({ path: "artifacts/knowledge-graph/graph-mobile.png" });
  // The picker fits a phone, with every agent shown.
  await phone.goto(`${app.origin}/dashboard/graph?view=knowledge&agents=all`);
  await phone.getByRole("button", { name: /^Helios-9, #/ }).waitFor();
  await phone.locator("details summary").first().click();
  const menu = await phone.locator("details fieldset").first().boundingBox();
  assert.ok(menu && menu.x >= 0 && menu.x + menu.width <= 390, `sélecteur dans l’écran : ${JSON.stringify(menu)}`);
  await phone.screenshot({ path: "artifacts/knowledge-graph/agents-mobile.png" });

  // Another user: no agent of Alice in the selector, no graph, no provenance.
  const other = await browser.newContext();
  t.after(() => other.close());
  assert.equal((await other.request.post(`${app.origin}/api/auth/sign-up/email`, { headers: { Origin: app.origin }, data: { name: "Bob", email: "bob-knowledge@example.com", password: "knowledge test password" } })).status(), 200);
  assert.equal((await other.request.get(`${app.origin}/api/xiagents/${astronoxi.id}/knowledge/${topic("helios-9")}`)).status(), 404);
  assert.equal((await context.request.get(`${app.origin}/api/xiagents/${astronoxi.id}/knowledge/${topic("helios-9")}`)).status(), 200);
  const foreign = await other.newPage();
  await foreign.goto(`${app.origin}/dashboard/graph?view=knowledge&agent=${astronoxi.id}`);
  await foreign.getByText("Aucun ΞAgent", { exact: true }).waitFor();
  assert.equal(await foreign.locator("[data-concept-id]").count(), 0);
  assert.equal(await foreign.getByText("Helios").count(), 0);
});

