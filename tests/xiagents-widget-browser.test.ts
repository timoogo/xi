import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import Database from "better-sqlite3";
import { chromium, type Browser } from "playwright-core";
import { createTestServer } from "./helpers/next-server";

test("ΞAgents widget: real activity, refresh, reduced motion, pins persisted per user, navigation", { timeout: 120_000 }, async t => {
  const app = await createTestServer();
  const resources: { browser?: Browser } = {};
  t.after(async () => { await resources.browser?.close(); await app.dispose(); });
  await app.migrate(); await app.start();
  const browser = resources.browser = await chromium.launch({ executablePath: process.env.XI_E2E_CHROME ?? "/usr/bin/google-chrome-stable", headless: true });
  const viewport = { width: 1280, height: 900 };
  const alice = await browser.newContext({ viewport }); const bob = await browser.newContext({ viewport }); const anon = await browser.newContext();
  const headers = { Origin: app.origin };
  for (const [context, name] of [[alice, "Alice"], [bob, "Bob"]] as const) assert.equal((await context.request.post(`${app.origin}/api/auth/sign-up/email`, { headers, data: { name, email: `${name}@widget.test`, password: "widget test password" } })).status(), 200);
  const post = async (path: string, data: unknown) => { const response = await alice.request.post(app.origin + path, { headers, data }); assert.equal(response.status(), 200, await response.text()); return response.json(); };
  const { run: topic } = await post("/api/topics/runs", { intent: "Politique fictive" });
  await post(`/api/topics/runs/${topic.id}`, { action: "resume" });
  await post(`/api/topics/runs/${topic.id}`, { action: "confirm", relationsConfirmed: true, draft: { tag: "politiks", name: "Politique", description: "Test", scope: "Scénarios fictifs", parentId: null, relatedIds: [] } });
  const { run: allocated } = await post("/api/accounts/runs", { topicId: topic.topicId });
  const { run: ready } = await post(`/api/accounts/runs/${allocated.id}`, { action: "resume" });
  const { run: complete } = await post(`/api/accounts/runs/${allocated.id}`, { action: "confirm", draft: ready.draft, confirmed: true });
  const agentId: string = complete.accountId;

  const page = await alice.newPage(); page.setDefaultTimeout(12_000);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${app.origin}/dashboard`);
  const widget = page.locator('[data-widget="xiagents"]');
  const row = widget.locator(`[data-agent-id="${agentId}"]`);
  const avatar = row.locator("[data-bloub]");
  await row.waitFor();
  // Active agent, watch disabled → sleeping: the real state, not the neutral identity avatar.
  assert.equal(await avatar.getAttribute("data-activity"), "sleeping");
  await row.getByText("En veille", { exact: true }).waitFor();
  assert.equal(await widget.getByRole("link", { name: "Voir tous" }).getAttribute("href"), "/dashboard/xiagents");
  assert.equal(await page.getByRole("heading", { name: "Générateurs Ξ" }).count(), 0, "provisional block replaced");
  for (const title of ["Sujets suivis", "Tendances", "Suggestions"]) await page.getByRole("heading", { name: title }).waitFor();

  // A claimed watch job makes the agent work; returning to the tab refreshes without reloading.
  const db = new Database(app.databasePath); t.after(() => db.close());
  const now = Date.now();
  db.prepare("INSERT INTO watch_job (id, kind, key, payload, state, run_after, max_attempts, lease_token, lease_until, created_at, updated_at) VALUES (?, 'collect', ?, ?, 'running', ?, 3, 'lease', ?, ?, ?)")
    .run(randomUUID(), `widget:${agentId}`, JSON.stringify({ agentId }), now, now + 60_000, now, now);
  let polls = 0; page.on("request", request => { if (new URL(request.url()).pathname === "/api/xiagents") polls++; });
  // A hidden tab does not poll.
  // Strings, not functions: tsx would inject its `__name` helper into the page.
  const setHidden = (hidden: boolean) => page.evaluate(`Object.defineProperty(document, "hidden", { configurable: true, value: ${hidden} }); document.dispatchEvent(new Event("visibilitychange"))`);
  await setHidden(true);
  await page.waitForTimeout(300);
  assert.equal(polls, 0);
  await setHidden(false);
  await row.getByText("Au travail", { exact: true }).waitFor();
  assert.equal(polls, 1);
  assert.equal(await avatar.getAttribute("data-activity"), "working");
  await page.waitForFunction(id => document.querySelector(`[data-agent-id="${id}"] [data-bloub]`)?.getAttribute("data-animating") === "true", agentId);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.waitForFunction(id => document.querySelector(`[data-agent-id="${id}"] [data-bloub]`)?.getAttribute("data-animating") === "false", agentId);
  await page.emulateMedia({ reducedMotion: "no-preference" });

  // Pins: saved server-side, restored after reload, isolated per user.
  const pin = row.getByRole("button", { name: "Épingler Politique" });
  assert.equal(await pin.getAttribute("aria-pressed"), "false");
  await pin.click();
  await page.waitForResponse(response => response.url().endsWith(`/api/xiagents/${agentId}/pin`) && response.ok());
  await page.reload();
  await row.waitFor();
  assert.equal(await row.getByRole("button", { name: "Épingler Politique" }).getAttribute("aria-pressed"), "true");
  assert.equal((await (await alice.request.get(`${app.origin}/api/xiagents`)).json()).agents[0].pinnedAt > 0, true);
  const endpoint = `${app.origin}/api/xiagents/${agentId}/pin`;
  assert.deepEqual((await (await bob.request.get(`${app.origin}/api/xiagents`)).json()).agents, []);
  assert.equal((await bob.request.put(endpoint, { headers, data: { pinned: false } })).status(), 404);
  assert.equal((await anon.request.get(`${app.origin}/api/xiagents`)).status(), 401);
  assert.equal((await anon.request.put(endpoint, { headers, data: { pinned: false } })).status(), 401);
  assert.equal((await alice.request.put(endpoint, { headers: { Origin: "https://foreign.example" }, data: { pinned: false } })).status(), 403);
  assert.equal((await alice.request.put(endpoint, { headers, data: { pinned: "no" } })).status(), 400);
  assert.ok((await (await alice.request.get(`${app.origin}/api/xiagents`)).json()).agents[0].pinnedAt, "foreign attempts changed nothing");
  const bobPage = await bob.newPage();
  await bobPage.goto(`${app.origin}/dashboard`);
  await bobPage.locator('[data-widget="xiagents"]').getByText("Vous n’avez encore aucun ΞAgent.").waitFor();

  // Each row opens the agent's page.
  await row.getByRole("link").click();
  await page.waitForURL(`${app.origin}/dashboard/xiagents/${agentId}`);

  // Category selector (Base Select): system agents in the widget, kept while navigating, carried by « Voir tous ».
  const bobWidget = bobPage.locator('[data-widget="xiagents"]');
  await bobWidget.getByRole("combobox", { name: "Catégorie de ΞAgents" }).click();
  await bobPage.getByRole("option", { name: "Agents systèmes" }).click();
  await bobWidget.getByText("Konstruktor").waitFor();
  await bobWidget.getByText("Arbitre prioritaire").waitFor();
  assert.equal(await bobWidget.locator("li[data-agent-id]").count(), 2, "each system agent once");
  assert.equal(await bobWidget.getByRole("link", { name: "Voir tous" }).getAttribute("href"), "/dashboard/xiagents?category=system");
  await bobWidget.getByRole("link", { name: "Voir tous" }).click();
  await bobPage.waitForURL(`${app.origin}/dashboard/xiagents?category=system`);
  await bobPage.locator("#agent-konstruktor").waitFor();
  assert.equal(await bobWidget.getAttribute("data-category"), "system", "the widget keeps its category across navigation");
  // Bob's choice survives a reload (rendered by the server, no flash); Alice keeps her own default.
  await bobPage.reload();
  await bobWidget.getByText("Konstruktor").waitFor();
  assert.equal(await bobWidget.getAttribute("data-category"), "system", "kept after a reload");
  await page.reload();
  assert.equal(await page.locator('[data-widget="xiagents"]').getAttribute("data-category"), "editorial", "never imposed on another user");
  // The page's selector navigates through the URL.
  await bobPage.locator("#main-content header").getByRole("combobox", { name: "Catégorie de ΞAgents" }).click();
  await bobPage.getByRole("option", { name: "Agents éditoriaux" }).click();
  await bobPage.waitForURL(`${app.origin}/dashboard/xiagents`);
  await bobPage.getByRole("heading", { name: "Mes ΞAgents" }).waitFor();
  assert.deepEqual(errors, []);
});
