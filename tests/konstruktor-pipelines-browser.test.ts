import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import Database from "better-sqlite3";
import { chromium, type Page } from "playwright-core";
import { createTestServer } from "./helpers/next-server";
import { openVault } from "../src/lib/publications/vault";
import { createPublicationStore } from "../src/lib/publications/store";
import { createTopicStore } from "../src/lib/topics/store";
import { createAccountStore } from "../src/lib/accounts/store";

/**
 * Konstruktor pipelines in Chromium, on a production build: launch, live progress, a failing publication
 * exhausting its attempts, logs, targeted retry, filters, history, a real server restart, forced re-analysis,
 * and another user's access. Retry delays are skipped by making pending jobs due: every attempt really runs.
 */
test("pipelines Konstruktor : lancement, progression, échecs, relance, redémarrage et confidentialité", { timeout: 240_000 }, async t => {
  const model = { broken: true, calls: 0 };
  const ollama = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer);
    const data = JSON.parse(Buffer.concat(chunks).toString());
    const prompt: string = data.messages?.[1]?.content ?? data.prompt ?? "";
    const sentence = prompt.replace(/^Texte :\n/, "").split("\n").find(line => /utilise|observe/.test(line)) ?? "";
    model.calls++;
    res.writeHead(200, { "Content-Type": "application/json" });
    if (!sentence || (sentence.includes("PANNE") && model.broken)) { res.end(JSON.stringify({ message: { content: "réponse illisible" }, response: "réponse illisible", done: true })); return; }
    const words = sentence.replace("PANNE : ", "").replace(/\.$/, "").split(" ");
    const [from, to] = [words[0], words.at(-1)!];
    const content = JSON.stringify({ concepts: [{ name: from }, { name: to }], relations: [{ from, link: sentence.slice(sentence.indexOf(from) + from.length, sentence.lastIndexOf(to)).trim(), to, type: "related_to", confidence: 0.8 }] });
    res.end(JSON.stringify({ message: { content }, response: content, done: true }));
  });
  ollama.listen(0, "127.0.0.1"); await once(ollama, "listening");
  const address = ollama.address(); assert.ok(address && typeof address !== "string");
  const app = await createTestServer({ XI_INFERENCE_URL: `http://127.0.0.1:${address.port}`, XI_INFERENCE_MODEL: "test" });
  const fixtureDb = new Database(":memory:");
  const browser = await chromium.launch({ executablePath: process.env.XI_E2E_CHROME ?? "/usr/bin/google-chrome-stable", headless: true });
  t.after(async () => { await browser.close(); fixtureDb.close(); await app.dispose(); await new Promise<void>(resolve => ollama.close(() => resolve())); });
  await app.migrate(); await app.start();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const signed = await context.request.post(`${app.origin}/api/auth/sign-up/email`, { headers: { Origin: app.origin }, data: { name: "Alice", email: "pipelines@example.com", password: "pipelines test password" } });
  assert.equal(signed.status(), 200);
  const owner = (await signed.json()).user.id as string;

  const vault = await openVault(app.vaultPath);
  const topics = createTopicStore({ vault, db: fixtureDb });
  const accounts = createAccountStore({ vault, db: fixtureDb, topics });
  const publications = createPublicationStore({ vault, db: fixtureDb });
  const agentOf = async (name: string) => {
    const run = await topics.propose(owner, `Espace ${name}`);
    await topics.confirm(owner, run.id, { tag: name.toLowerCase(), name, description: "", scope: "Espace", parentId: null, relatedIds: [] }, true);
    const proposal = await accounts.propose(owner, run.topicId), ready = await accounts.resume(owner, proposal.id);
    await accounts.confirm(owner, ready.id, ready.draft, true);
    return { id: ready.accountId, topic: run.topicId };
  };
  const propulsion = await agentOf("Propulsion"), orbites = await agentOf("Orbites");
  const publish = async (agent: { id: string; topic: string }, text: string) => {
    const id = randomUUID();
    const draft = await publications.saveWatchDraft(owner, agent.id, { id, summary: text, topicIds: [agent.topic], messages: [{ body: text, sources: [0] }], sources: [{ url: "https://agence.example/a", title: "Agence", publisher: "Agence", accessedAt: "2026-11-01", facts: [text], reservations: [] }], watch: {} });
    assert.ok((await publications.reviewWatchDraft({ id: owner }, agent.id, id, { action: "approve", revision: draft.revision })).ok);
    return id;
  };
  const ids = [await publish(propulsion, "Asterion-47 utilise le moteur Helios-9."), await publish(propulsion, "Orion-12 observe la région Tinga."), await publish(propulsion, "PANNE : Vega-2 utilise le moteur Kappa-5.")];
  await publications.publishGenerated({ id: owner }, propulsion.id, { id: randomUUID(), summary: "Fixture", messages: ["Contenu de démonstration."], topicIds: [propulsion.topic] });
  await publish(orbites, "Zeta-3 utilise le moteur Rho-1.");
  // The server indexes the vault on its own schedule: wait until it serves every publication.
  for (const id of ids) {
    let status = 0;
    for (let attempt = 0; status !== 200 && attempt < 40; attempt++) { status = (await context.request.get(`${app.origin}/api/publications/${id}`)).status(); if (status !== 200) await new Promise(resolve => setTimeout(resolve, 250)); }
    assert.equal(status, 200);
  }
  /** Skips retry delays: pending jobs become due now; the page's refresh resumes them. */
  const hurry = () => { const db = new Database(app.databasePath); try { db.prepare("UPDATE watch_job SET run_after = 0 WHERE state = 'pending'").run(); } finally { db.close(); } };
  const statusOf = (page: Page, selector: string) => page.locator(selector).first().getAttribute("data-status");
  const until = async (page: Page, check: () => Promise<boolean>, label: string) => {
    for (let attempt = 0; attempt < 120; attempt++) { if (await check()) return; hurry(); await page.waitForTimeout(500); }
    assert.fail(`délai dépassé : ${label}`);
  };

  const page = await context.newPage(); page.setDefaultTimeout(20_000);
  await page.goto(`${app.origin}/dashboard/konstruktor`);
  await page.getByRole("link", { name: "Pipelines" }).click();
  await page.waitForURL(`${app.origin}/dashboard/konstruktor/pipelines`);
  await page.getByText("Aucun run.").waitFor();
  const launcher = page.getByRole("form", { name: "Nouveau run" });
  await launcher.getByLabel("ΞAgent").selectOption({ label: "Propulsion" });
  await launcher.getByLabel("Publications manquantes").check();
  await launcher.getByRole("button", { name: "Lancer un run" }).click();
  await page.waitForURL(/\/dashboard\/konstruktor\/pipelines\/[0-9a-f-]{36}$/);
  const runUrl = page.url(), runId = runUrl.split("/").at(-1)!;
  await page.getByRole("heading", { name: "Run #1" }).waitFor();
  const job = (id: string) => `[data-publication="${id}"] [data-status]`;
  await until(page, async () => await statusOf(page, job(ids[0])) === "success" && await statusOf(page, job(ids[1])) === "success" && await statusOf(page, job(ids[2])) === "failed", "deux succès et un échec");
  assert.equal(await statusOf(page, 'section[aria-label="Résumé"] [data-status]'), "partial");
  assert.equal(await page.getByRole("progressbar", { name: "Progression globale" }).getAttribute("aria-valuenow"), "4");
  await page.getByText("Contenu de test exclu.", { exact: false }).waitFor();
  await page.getByText("3 tentative(s)", { exact: false }).waitFor();
  await page.locator(`[data-publication="${ids[0]}"] summary`).click();
  await page.locator(`[data-publication="${ids[0]}"]`).getByText("Concept « Asterion-47 » : topic #asterion-47", { exact: false }).waitFor();
  await page.locator(`[data-publication="${ids[0]}"]`).getByText("Relation Asterion-47 → Helios-9 (related_to) proposée", { exact: false }).waitFor();
  await page.locator(`[data-publication="${ids[2]}"] summary`).click();
  assert.ok(await page.locator(`[data-publication="${ids[2]}"]`).getByText(/InferenceOutputError|illisible|invalide/i).count() >= 1, "l’erreur est journalisée");
  await mkdir("artifacts/konstruktor-pipelines", { recursive: true });
  await page.screenshot({ path: "artifacts/konstruktor-pipelines/run-mobile.png", fullPage: true });
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  assert.ok(width <= 390, `pas de défilement horizontal sur mobile (${width}px)`);

  // Persistence: a reload, then a real server restart, show the same run.
  await page.reload();
  assert.equal(await statusOf(page, 'section[aria-label="Résumé"] [data-status]'), "partial");
  await app.stop(); await app.start();
  await page.goto(runUrl);
  assert.equal(await statusOf(page, 'section[aria-label="Résumé"] [data-status]'), "partial");

  // Targeted retry of the failed publication only.
  model.broken = false;
  const calls = model.calls;
  await page.getByRole("button", { name: "Relancer les échecs" }).click();
  await until(page, async () => await statusOf(page, 'section[aria-label="Résumé"] [data-status]') === "success", "relance réussie");
  assert.equal(model.calls - calls, 1, "seule la publication en échec est réanalysée");
  assert.equal(await page.getByRole("button", { name: "Relancer les échecs" }).count(), 0);

  // History, filters, then a forced re-analysis from the list.
  await page.getByRole("link", { name: "Retour aux pipelines" }).click();
  await page.waitForURL(new RegExp(`/dashboard/konstruktor/pipelines\\?agent=${propulsion.id}$`));
  await page.getByRole("navigation", { name: "Filtrer par ΞAgent" }).getByRole("link", { name: "Orbites" }).click();
  await page.getByText("Aucun run pour ce ΞAgent.").waitFor();
  await page.getByRole("navigation", { name: "Filtrer par ΞAgent" }).getByRole("link", { name: "Tous" }).click();
  await page.getByRole("list", { name: "Runs" }).getByText("#1").waitFor();
  await launcher.getByLabel("ΞAgent").selectOption({ label: "Propulsion" });
  await launcher.getByLabel("Réanalyse complète").check();
  await launcher.getByText("Les exclusions, corrections et décisions sur les relations sont conservées", { exact: false }).waitFor();
  await launcher.getByRole("button", { name: "Lancer un run" }).click();
  await page.getByRole("heading", { name: "Run #2" }).waitFor();
  await until(page, async () => await statusOf(page, 'section[aria-label="Résumé"] [data-status]') === "success", "réanalyse complète");
  await page.goto(`${app.origin}/dashboard/konstruktor/pipelines`);
  const rows = page.getByRole("list", { name: "Runs" }).getByRole("listitem");
  assert.equal(await rows.count(), 2);
  assert.match(await rows.first().textContent() ?? "", /#2[\s\S]*réanalyse complète[\s\S]*Manuel/);
  await page.screenshot({ path: "artifacts/konstruktor-pipelines/list-mobile.png", fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: "artifacts/konstruktor-pipelines/list-desktop.png", fullPage: true });
  await page.goto(runUrl);
  await page.screenshot({ path: "artifacts/konstruktor-pipelines/run-desktop.png", fullPage: true });

  // Another user: no run, no detail, no logs, no launch on Alice's agent.
  const other = await browser.newContext();
  t.after(() => other.close());
  assert.equal((await other.request.post(`${app.origin}/api/auth/sign-up/email`, { headers: { Origin: app.origin }, data: { name: "Bob", email: "bob-pipelines@example.com", password: "pipelines test password" } })).status(), 200);
  assert.deepEqual((await (await other.request.get(`${app.origin}/api/konstruktor/pipelines`)).json()).runs, []);
  assert.equal((await other.request.get(`${app.origin}/api/konstruktor/pipelines/${runId}`)).status(), 404);
  assert.equal((await other.request.post(`${app.origin}/api/konstruktor/pipelines/${runId}`, { headers: { Origin: app.origin }, data: { action: "retry" } })).status(), 404);
  assert.equal((await other.request.post(`${app.origin}/api/konstruktor/pipelines`, { headers: { Origin: app.origin }, data: { agent: propulsion.id, mode: "force" } })).status(), 404);
  assert.equal((await other.request.post(`${app.origin}/api/konstruktor/pipelines`, { data: { agent: propulsion.id, mode: "force" } })).status(), 403, "origine contrôlée");
  const foreign = await other.newPage();
  const response = await foreign.goto(`${app.origin}/dashboard/konstruktor/pipelines/${runId}`);
  assert.equal(response?.status(), 404);
  assert.equal(await foreign.getByText("Asterion-47").count(), 0);
});
