import assert from "node:assert/strict";
import { test } from "node:test";
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
  await input.fill("aller aux");
  assert.deepEqual(await palette.getByRole("option").allTextContents(), ["Aller aux publications"]);
  await input.press("Enter");
  await page.waitForURL(`${app.origin}/dashboard/publications`);
  await palette.waitFor({ state: "detached" });

  // Conditional availability; steps; Escape goes back one step, then closes.
  await trigger.click();
  await input.waitFor();
  assert.ok(!(await palette.getByRole("option").allTextContents()).includes("Aller aux publications"));
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
  await bubble.focus();
  await page.keyboard.press("Enter");
  await input.waitFor();
  assert.equal(await page.getByRole("dialog").count(), 1);
  await page.keyboard.press("Escape");
  await palette.waitFor({ state: "detached" });

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
