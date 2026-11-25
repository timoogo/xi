import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { chromium, type Browser, type Locator } from "playwright-core";
import { hydrated } from "./helpers/hydration";
import { createTestServer } from "./helpers/next-server";

test("command palette: open, filter, simple command, multi-step workflows with real data, back and cancel", { timeout: 120_000 }, async t => {
  const app = await createTestServer();
  const resources: { browser?: Browser } = {};
  t.after(async () => { await resources.browser?.close(); await app.dispose(); });
  await app.migrate(); await app.start();
  const browser = resources.browser = await chromium.launch({ executablePath: process.env.XI_E2E_CHROME ?? "/usr/bin/google-chrome-stable", headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const headers = { Origin: app.origin };
  assert.equal((await context.request.post(`${app.origin}/api/auth/sign-up/email`, { headers, data: { name: "Alice", email: "alice@commands.test", password: "commands test password" } })).status(), 200);
  // A real editorial ΞAgent, through the creation flow's API.
  const post = async (path: string, data: unknown) => { const response = await context.request.post(app.origin + path, { headers, data }); assert.equal(response.status(), 200, await response.text()); return response.json(); };
  const { run: topic } = await post("/api/topics/runs", { intent: "Politique fictive" });
  await post(`/api/topics/runs/${topic.id}`, { action: "resume" });
  await post(`/api/topics/runs/${topic.id}`, { action: "confirm", relationsConfirmed: true, draft: { tag: "politiks", name: "Politique", description: "Test", scope: "Scénarios fictifs", parentId: null, relatedIds: [] } });
  const { run: allocated } = await post("/api/accounts/runs", { topicId: topic.topicId });
  const { run: ready } = await post(`/api/accounts/runs/${allocated.id}`, { action: "resume" });
  const { run: complete } = await post(`/api/accounts/runs/${allocated.id}`, { action: "confirm", draft: ready.draft, confirmed: true });
  const agentId: string = complete.accountId;

  const page = await context.newPage(); page.setDefaultTimeout(12_000);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const palette = page.getByRole("dialog", { name: "Palette de commandes" });
  const input = palette.getByRole("combobox");
  const trigger = page.getByRole("button", { name: "Commandes", exact: true });
  const bubble = page.getByRole("button", { name: "Ouvrir la palette de commandes" });
  async function open(at: string) {
    await page.goto(app.origin + at);
    await hydrated(trigger);
    await page.keyboard.press("Control+k");
    await input.waitFor();
  }

  // Simple command, found by typing, run with Enter.
  await open("/dashboard");
  assert.equal(await input.getAttribute("aria-label"), "Commandes");
  for (const [label, badge] of [["Aller aux publications", "Publications"], ["Rechercher un ΞAgent", "ΞAgents"], ["🧪 Test Cmdly global", "Global"]]) {
    assert.equal(await palette.getByRole("option", { name: label }).getByText(badge, { exact: true }).count(), 1);
  }
  assert.equal(await palette.getByRole("option", { name: "🧪 Test Cmdly global" }).count(), 1);
  await input.fill("search");
  assert.equal(await palette.getByRole("option", { name: "Rechercher une publication" }).count(), 1);
  assert.equal(await palette.getByRole("option", { name: "Rechercher un ΞAgent" }).count(), 1);
  assert.equal(await palette.getByRole("option", { name: "Aller aux publications" }).count(), 0);
  await input.fill("aller aux");
  assert.equal(await palette.getByRole("option", { name: "Aller aux publications" }).count(), 1);
  await input.press("Enter");
  await page.waitForURL(`${app.origin}/dashboard/publications`);
  await palette.waitFor({ state: "detached" });

  // Conditional availability; steps; Escape goes back one step, then closes.
  await trigger.click();
  await input.waitFor();
  assert.equal(await palette.getByRole("option", { name: "Aller aux publications" }).count(), 0);
  await palette.getByRole("option", { name: "Rechercher une publication" }).click();
  await palette.getByText("Étape 1/2").waitFor();
  assert.equal(await input.getAttribute("aria-label"), "Où chercher ?");
  await page.keyboard.press("Escape");
  await palette.getByRole("option", { name: "Rechercher une publication" }).waitFor();
  assert.equal(await input.getAttribute("aria-label"), "Commandes");
  await page.keyboard.press("Escape");
  await palette.waitFor({ state: "detached" });

  // ⌘+K opens it too; arrows move the active option (wrapping), Enter runs the active one.
  await page.keyboard.press("Meta+k");
  await input.waitFor();
  const options = palette.getByRole("option");
  const active = () => palette.getByRole("option", { selected: true }).textContent();
  const first = await options.first().textContent();
  await input.press("ArrowDown");
  assert.equal(await active(), await options.nth(1).textContent());
  await input.press("ArrowUp");
  await input.press("ArrowUp");
  assert.equal(await active(), await options.last().textContent(), "ArrowUp wraps to the last option");
  await input.press("ArrowDown");
  assert.equal(await active(), first);
  await page.keyboard.press("Meta+k");
  await palette.waitFor({ state: "detached" });

  // Multi-step with real data: a draft created in the app, found in "my publications", opened.
  await hydrated(page.getByRole("button", { name: "Publier" }).first());
  await page.getByRole("button", { name: "Publier" }).first().click();
  await page.waitForURL(/\/dashboard\/publications\/[^/]+\/edit$/);
  const draftId = new URL(page.url()).pathname.split("/")[3];
  await open("/dashboard");
  await input.fill("rechercher une pub");
  await input.press("Enter");
  await palette.getByRole("option", { name: "Mes publications et brouillons" }).click();
  await palette.getByText("Étape 2/2").waitFor();
  await palette.getByRole("option", { name: "Brouillon · Sans titre" }).waitFor();
  // Back keeps the previous answer selected; Backspace on an empty field goes back too.
  await input.press("Backspace");
  await palette.getByRole("option", { name: "Mes publications et brouillons", selected: true }).waitFor();
  await input.press("Enter");
  await input.fill("introuvable");
  await palette.getByText("Aucun résultat pour « introuvable ».").waitFor();
  await input.fill("");
  await palette.getByRole("option", { name: "Brouillon · Sans titre" }).click();
  await page.waitForURL(new RegExp(`/dashboard/publications/${draftId}`));

  // Second module: find a ΞAgent, then open its publication generator with the chosen agent.
  await open("/dashboard");
  await input.fill("rechercher un ξ");
  await input.press("Enter");
  await palette.getByRole("option", { name: /^Politique · @/ }).click();
  await page.waitForURL(`${app.origin}/dashboard/xiagents/${agentId}`);
  await open("/dashboard");
  await palette.getByRole("option", { name: "Créer une publication pour un ΞAgent" }).click();
  await palette.getByRole("option", { name: /^Politique · @/ }).click();
  await page.waitForURL(`${app.origin}/dashboard/xiagents/${agentId}#publication-generator`);
  await page.getByRole("heading", { name: "Générer une publication" }).waitFor({ state: "visible" });

  // The Bloub bubble opens the same palette (a single dialog), on desktop at the bottom right.
  await page.goto(`${app.origin}/dashboard`);
  await hydrated(bubble);
  const viewport = page.viewportSize()!, desk = (await bubble.boundingBox())!;
  assert.ok(desk.x + desk.width > viewport.width - 40 && desk.y + desk.height > viewport.height - 40, "bottom right");
  assert.equal(await bubble.locator("[data-bloub]").count(), 1);
  await bubble.locator('[data-bloub][data-animating="true"]').waitFor();
  // Its eyes (mask holes, x of their matrix) look left, towards the page, at rest.
  const eyesX = async (target = page) => {
    const xs = await target.locator('button[data-mood] [data-bloub] mask path[fill="#000"]').evaluateAll(paths => paths.map(p => Number(/matrix\(([^)]+)\)/.exec(p.getAttribute("transform")!)![1].split(",")[4])));
    return xs.reduce((a, b) => a + b, 0) / xs.length;
  };
  assert.ok(await eyesX() < -5, "looks towards the page at rest");
  // Hover: attentive, the eyes follow the pointer; leaving brings them back to the rest direction.
  await page.mouse.move(desk.x + desk.width - 4, desk.y + desk.height / 2);
  await page.locator('button[data-mood="attentive"]').waitFor();
  await page.waitForTimeout(500);
  assert.ok(await eyesX() > 5, "looks at a pointer on its right");
  await page.mouse.move(200, 200);
  await page.locator('button[data-mood="neutral"]').waitFor();
  await page.waitForTimeout(1200);
  assert.ok(await eyesX() < -5, "back to the rest direction");
  // A click reacts and opens the palette at once.
  await bubble.click();
  await input.waitFor({ timeout: 1000 });
  assert.equal(await page.locator('button[data-mood="pleased"]').count(), 1);
  await page.keyboard.press("Escape");
  await palette.waitFor({ state: "detached" });
  await bubble.focus();
  await page.keyboard.press("Enter");
  await input.waitFor();
  assert.equal(await page.getByRole("dialog").count(), 1);
  await page.keyboard.press("Escape");
  await palette.waitFor({ state: "detached" });

  // Reduced motion: a still frame (no animation loop), still looking towards the page, still opening the palette.
  const still = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce", storageState: await context.storageState() });
  const calm = await still.newPage(); calm.setDefaultTimeout(12_000);
  calm.on("pageerror", error => errors.push(error.message));
  const calmBubble = calm.getByRole("button", { name: "Ouvrir la palette de commandes" });
  await calm.goto(`${app.origin}/dashboard`);
  await hydrated(calmBubble);
  await calmBubble.hover();
  await calm.locator('button[data-mood="attentive"]').waitFor();
  assert.equal(await calmBubble.locator("[data-bloub]").getAttribute("data-animating"), "false");
  assert.ok(await eyesX(calm) < -5);
  await calmBubble.click();
  await calm.getByRole("dialog", { name: "Palette de commandes" }).getByRole("combobox").waitFor();
  await still.close();

  // Mobile: visible, clear of the tab bar and the compose button, and fully usable with the keyboard.
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, storageState: await context.storageState() });
  const phone = await mobile.newPage(); phone.setDefaultTimeout(12_000);
  phone.on("pageerror", error => errors.push(error.message));
  const phoneBubble = phone.getByRole("button", { name: "Ouvrir la palette de commandes" });
  const phonePalette = phone.getByRole("dialog", { name: "Palette de commandes" });
  const box = async (locator: Locator) => (await locator.boundingBox())!;
  const apart = (a: { x: number; y: number; width: number; height: number }, b: typeof a) => a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
  await phone.goto(`${app.origin}/dashboard`);
  await hydrated(phoneBubble);
  await phoneBubble.locator('[data-bloub][data-animating="true"]').waitFor();
  assert.ok(await eyesX(phone) < -5, "looks towards the page on mobile too");
  const tabBar = await box(phone.locator("nav.fixed")), compose = await box(phone.getByRole("button", { name: "Publier" }));
  assert.ok(apart(await box(phoneBubble), tabBar) && apart(await box(phoneBubble), compose), "no overlap with the tab bar or the compose button");
  await phoneBubble.tap();
  const phoneInput = phonePalette.getByRole("combobox");
  await phoneInput.waitFor();
  await phoneInput.fill("aller aux");
  await phoneInput.press("ArrowDown");
  await phoneInput.press("Enter");
  await phone.waitForURL(`${app.origin}/dashboard/publications`);
  await phonePalette.waitFor({ state: "detached" });
  // In the editor, where the compose button is hidden, the bubble takes its place, still clear of the tab bar.
  await phone.goto(`${app.origin}/dashboard/publications/${draftId}/edit`);
  await hydrated(phoneBubble);
  const editing = await box(phoneBubble);
  assert.ok(apart(editing, await box(phone.locator("nav.fixed"))) && editing.x + editing.width > 390 - 24);
  await mobile.close();

  assert.deepEqual(errors, []);
});

test("Cmdly POC: creation, exact topic identity, scan and errors through Xi APIs", { timeout: 180_000 }, async t => {
  const ollamaUrl = process.env.XI_CMDLY_REAL_OLLAMA_URL;
  const app = await createTestServer(ollamaUrl ? { XI_INFERENCE_URL: ollamaUrl, XI_INFERENCE_API: "ollama", XI_INFERENCE_MODEL: "qwen3:1.7b" } : {});
  const resources: { browser?: Browser } = {};
  t.after(async () => { await resources.browser?.close(); await app.dispose(); });
  await app.migrate(); await app.start();
  const browser = resources.browser = await chromium.launch({ executablePath: process.env.XI_E2E_CHROME ?? "/usr/bin/google-chrome-stable", headless: true });
  const alice = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const bob = await browser.newContext();
  const headers = { Origin: app.origin };
  for (const [context, name] of [[alice, "Alice"], [bob, "Bob"]] as const) {
    assert.equal((await context.request.post(`${app.origin}/api/auth/sign-up/email`, { headers, data: { name, email: `${name}@cmdly-poc.test`, password: "commands test password" } })).status(), 200);
  }
  const page = await alice.newPage(); page.setDefaultTimeout(15_000);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  // The personal topic exists first; a shared topic may subsequently acquire the same tag.
  await page.goto(`${app.origin}/dashboard/explore`);
  const search = page.locator("#main-content").getByRole("searchbox", { name: /Rechercher/ });
  await hydrated(search); await search.fill("#homonyme"); await search.press("Enter");
  await page.waitForURL(`${app.origin}/dashboard/topics/homonyme`);
  await page.getByText("Topic personnel", { exact: true }).waitFor();
  const post = async (path: string, data: unknown) => {
    const response = await alice.request.post(app.origin + path, { headers, data });
    assert.equal(response.status(), 200, await response.text()); return response.json();
  };
  const { run: topic } = await post("/api/topics/runs", { intent: "Homonyme partagé" });
  await post(`/api/topics/runs/${topic.id}`, { action: "resume" });
  await post(`/api/topics/runs/${topic.id}`, { action: "confirm", relationsConfirmed: true, draft: { tag: "homonyme", name: "Homonyme partagé", description: "Sujet commun", scope: "Périmètre partagé", parentId: null, relatedIds: [] } });
  const catalog = await (await alice.request.get(`${app.origin}/api/commands/topics`)).json();
  const twins = catalog.topics.filter((entry: { tag: string }) => entry.tag === "homonyme");
  assert.equal(twins.length, 2);
  const personal = twins.find((entry: { personal: boolean }) => entry.personal);
  const shared = twins.find((entry: { personal: boolean }) => !entry.personal);
  assert.notEqual(personal.id, shared.id);
  const { run: allocated } = await post("/api/accounts/runs", { topicId: topic.topicId });
  const { run: ready } = await post(`/api/accounts/runs/${allocated.id}`, { action: "resume" });
  const { run: complete } = await post(`/api/accounts/runs/${allocated.id}`, { action: "confirm", draft: ready.draft, confirmed: true });
  const agentId: string = complete.accountId;
  const watchPath = `/api/xiagents/${agentId}/watch`;
  const watch = await (await alice.request.get(app.origin + watchPath)).json();
  const enabled = await alice.request.patch(app.origin + watchPath, { headers, data: { revision: watch.revision, policy: { ...watch.policy, enabled: true } } });
  assert.equal(enabled.status(), 200, await enabled.text());
  if (ollamaUrl) {
    const env = (await (await alice.request.get(`${app.origin}/api/llm/instances`)).json()).environment;
    assert.equal(env.configured, true); assert.equal(env.defaultModel, "qwen3:1.7b");
    const tags = await (await fetch(new URL("/api/tags", ollamaUrl))).json() as { models: { name: string }[] };
    assert.ok(tags.models.some(model => model.name === "qwen3:1.7b"));
    const source = await post(`/api/xiagents/${agentId}/sources`, { url: "https://www.nature.com/subjects/machine-learning.rss" });
    assert.equal(source.source.status, "proposed");
  }
  const palette = page.getByRole("dialog", { name: "Palette de commandes" });
  const open = async () => { await page.getByRole("button", { name: "Commandes", exact: true }).click(); await palette.getByRole("combobox").waitFor(); };
  await page.goto(`${app.origin}/dashboard`); await hydrated(page.getByRole("button", { name: "Commandes", exact: true }));
  await open(); await palette.getByRole("option", { name: "Ajouter un bot" }).click();
  const wizard = page.getByRole("dialog", { name: "Nouveau ΞAgent" }); await wizard.waitFor();
  await wizard.getByRole("radio", { name: /Saisie manuelle/ }).check(); await wizard.getByRole("button", { name: "Saisir manuellement" }).click();
  await wizard.getByRole("button", { name: "Suivant" }).click(); await wizard.getByRole("alert").filter({ hasText: "Nom requis." }).waitFor();
  await page.keyboard.press("Escape"); await wizard.waitFor({ state: "detached" });
  for (const choice of [personal, shared]) {
    await open(); await palette.getByRole("option", { name: "Se renseigner sur un topic" }).click();
    await palette.getByRole("option", { name: `${choice.name} · #homonyme (${choice.personal ? "personnel" : "partagé"})` }).click();
    await page.waitForURL(`${app.origin}/dashboard/topics/homonyme?topicId=${choice.id}`);
    assert.equal(await page.getByText("Topic personnel", { exact: true }).count(), choice.personal ? 1 : 0);
    if (!choice.personal) {
      await page.getByText("Périmètre partagé", { exact: true }).waitFor();
      await page.getByRole("button", { name: "S’abonner" }).click();
      await page.getByRole("button", { name: "Abonné" }).waitFor();
      assert.equal(new URL(page.url()).searchParams.get("topicId"), shared.id);
      await page.getByRole("button", { name: "Je connais ce sujet" }).click();
      await page.getByRole("button", { name: "Connaissance acquise" }).waitFor();
      assert.equal(new URL(page.url()).searchParams.get("topicId"), shared.id);
    }
  }
  assert.equal((await bob.request.get(`${app.origin}/dashboard/topics/by-id?topicId=${personal.id}`)).status(), 404);
  const anonymous = await browser.newContext();
  assert.equal((await anonymous.request.get(`${app.origin}/api/commands/topics`)).status(), 401);
  await anonymous.close();
  await page.goto(`${app.origin}/dashboard`); await hydrated(page.getByRole("button", { name: "Commandes", exact: true }));
  await open(); await palette.getByRole("option", { name: "Demander un scan" }).click();
  const scanResponse = page.waitForResponse(response => response.url().endsWith(`/api/xiagents/${agentId}/control`) && response.request().method() === "POST");
  await palette.getByRole("option", { name: /Homonyme partagé · @/ }).click();
  const response = await scanResponse; assert.equal(response.status(), 200);
  const scan = await response.json(); assert.equal(scan.planned, ollamaUrl ? 1 : 0); assert.ok(scan.runId);
  await page.getByText(ollamaUrl ? /Veille demandée : 1 collecte/ : "Aucune source à collecter pour cet ΞAgent.").waitFor();
  if (ollamaUrl) {
    const db = new Database(app.databasePath, { readonly: true });
    try {
      const pending = (db.prepare("SELECT count(*) AS n FROM watch_job WHERE kind = 'collect-source' AND state = 'pending' AND json_extract(payload, '$.agentId') = ?").get(agentId) as { n: number }).n;
      assert.equal(pending, 1);
      console.log(`Real Cmdly scan: ${scan.planned} collection scheduled and persisted; no worker is started by this test.`);
    } finally { db.close(); }
  }
  await post(`/api/xiagents/${agentId}/control`, { action: "pause", resumeAt: null, resumeWith: "now" });
  await open(); await palette.getByRole("option", { name: "Demander un scan" }).click();
  await palette.getByRole("option", { name: /Homonyme partagé · @/ }).click();
  await palette.getByRole("alert").filter({ hasText: "ΞAgent en pause" }).waitFor();
  assert.deepEqual(errors, []);
});
