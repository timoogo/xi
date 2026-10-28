import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { Document, stringify } from "yaml";
import { BUILTIN_PRESETS } from "../src/lib/accounts/types";
import { serializeGenerator } from "../src/lib/graph/format";
import type { Topic } from "../src/lib/topics/types";
import { createTestServer } from "./helpers/next-server";

const at = "2026-10-27T00:00:00.000Z";

test("topic network: tree preserved, layers, explicit knowledge, exploration, keyboard, list, mobile, isolation", { timeout: 150_000 }, async t => {
  const app = await createTestServer();
  const resources: { browser?: Browser } = {};
  t.after(async () => { await resources.browser?.close(); await app.dispose(); });

  const topic = (tag: string, name: string, extra: Partial<Topic> = {}): Topic => ({ id: randomUUID(), tag, name, description: "", scope: `Actualité ${name.toLowerCase()}`, parentId: null, relatedIds: [], aliases: [], createdAt: at, updatedAt: at, createdBy: "seed", updatedBy: "seed", revision: randomUUID(), ...extra });
  const climate = topic("climat", "Climat");
  const politics = topic("politiks", "Politique", { relatedIds: [climate.id] });
  const france = topic("politiks.france", "Politique française", { parentId: politics.id });
  const energy = topic("energie", "Énergie");
  await mkdir(join(app.vaultPath, "topics"), { recursive: true });
  for (const item of [climate, politics, france, energy]) await writeFile(join(app.vaultPath, "topics", `${item.id}.md`), `---\n${stringify(item)}---\n`);
  const editorial = (primaryTopicId: string) => ({ primaryTopicId, secondaryTopicIds: [], presetId: BUILTIN_PRESETS[0].id, presetVersion: 1, settings: BUILTIN_PRESETS[0].settings, active: true, modelRef: null, validationMode: "human", updatedAt: at, updatedBy: "seed", revision: randomUUID() });
  for (const [slug, visibility, primary] of [["veille-france", "public", france.id], ["secret-energie", "private", energy.id]] as const) {
    await mkdir(join(app.vaultPath, "generators", slug), { recursive: true });
    await writeFile(join(app.vaultPath, "generators", slug, "index.md"), serializeGenerator({ id: randomUUID(), slug, title: slug, ownerId: "someone-else", visibility, createdAt: at }, "", new Document({ editorial: editorial(primary) })));
  }
  await app.migrate();
  await app.start();

  const browser = resources.browser = await chromium.launch({ executablePath: process.env.XI_E2E_CHROME ?? "/usr/bin/google-chrome-stable", headless: true });
  async function user(email: string, viewport: { width: number; height: number }) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    page.setDefaultTimeout(12_000);
    const signup = await context.request.post(`${app.origin}/api/auth/sign-up/email`, { headers: { Origin: app.origin }, data: { name: email, email, password: "topic network password" } });
    assert.equal(signup.status(), 200);
    return page;
  }
  const errors: string[] = [];
  const page = await user("network@example.com", { width: 1280, height: 800 });
  page.on("pageerror", e => errors.push(e.message));
  const node = (p: Page, name: string) => p.locator("[data-topic-id]", { has: p.locator("title", { hasText: name }) });
  const layer = (p: Page, name: string) => p.getByRole("group", { name: "Couches affichées" }).getByRole("button", { name: new RegExp(name) });

  // The existing tree is the default mode, untouched.
  await page.goto(`${app.origin}/dashboard/graph`);
  await page.getByRole("toolbar", { name: "Outils du graphe" }).waitFor();
  assert.equal(await page.getByRole("link", { name: "Arbre actuel" }).getAttribute("aria-current"), "page");

  // Network mode: the experts layer brings the public agent's topic; the private agent of another user never appears.
  await page.getByRole("link", { name: "Réseau Topics" }).click();
  await page.waitForURL(/view=topics/);
  await page.getByRole("toolbar", { name: "Outils du réseau des topics" }).waitFor();
  await node(page, "Politique française (#politiks.france)").waitFor();
  assert.equal(await node(page, "Énergie (#energie)").count(), 0);
  assert.ok(!(await page.content()).includes("secret-energie"), "never sent to the browser");
  for (const name of ["Mes connaissances", "Mes centres d’intérêt", "ΞAgents experts"]) assert.equal(await layer(page, name).getAttribute("aria-pressed"), "true");

  // Keyboard: Tab reaches the node, Enter selects it and opens its panel.
  await node(page, "Politique française").focus();
  await page.keyboard.press("Enter");
  const panel = page.getByRole("complementary", { name: "Politique française" });
  await panel.waitFor();
  await panel.getByText("spécialité déclarée (principal)").waitFor();
  await panel.getByText("aucune publication accessible").waitFor();
  assert.ok(await panel.getByRole("link", { name: "Ouvrir la fiche" }).getAttribute("href").then(h => h?.endsWith("/dashboard/topics/politiks.france")));

  // Explicit knowledge from the panel; back to the same network view.
  await panel.getByRole("button", { name: "Ajouter à mes connaissances" }).click();
  await page.waitForURL(/view=topics/);
  await layer(page, "Mes connaissances").getByText("1").waitFor();
  assert.match(await node(page, "Politique française").getAttribute("aria-label") ?? "", /dans mes connaissances/);

  // Progressive exploration: the parent appears through the hierarchy only on request.
  assert.equal(await node(page, "Politique (#politiks)").count(), 0);
  await node(page, "Politique française").click();
  await page.getByRole("complementary", { name: "Politique française" }).getByRole("button", { name: /Explorer ses voisins \(1\)/ }).click();
  await page.waitForURL(/open=/);
  await node(page, "Politique (#politiks)").waitFor();
  assert.equal(await node(page, "Climat (#climat)").count(), 0, "neighbours of neighbours wait for their own exploration");

  // Arrow keys move between topics.
  await node(page, "Politique française").focus();
  let moved = false;
  for (const key of ["ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown"]) {
    await node(page, "Politique française").focus();
    await page.keyboard.press(key);
    if (await page.evaluate(() => document.activeElement?.querySelector("title")?.textContent ?? "") === "Politique (#politiks)") { moved = true; break; }
  }
  assert.ok(moved, "an arrow key reaches the neighbour");

  // Text alternative: nodes and relations as lists of buttons.
  await page.getByRole("button", { name: "Liste" }).click();
  const list = page.getByRole("region", { name: "Liste du réseau" });
  await list.getByText("2 topics affichés").waitFor();
  await list.getByText("Tag hiérarchique · validée").waitFor();
  await list.getByRole("button", { name: "Fermer la liste" }).click();

  // Layers are independent: experts off keeps the known topic; knowledge off too leaves an explicit empty state.
  await layer(page, "ΞAgents experts").click();
  await page.waitForURL(/layers=knowledge%2Cinterests|layers=knowledge,interests/);
  await node(page, "Politique française").waitFor();
  await layer(page, "Mes connaissances").click();
  await page.getByText("Aucun topic à afficher").waitFor();

  // Back to the tree: its toolbar and filters are still there.
  await page.getByRole("link", { name: "Arbre actuel" }).click();
  await page.getByRole("toolbar", { name: "Outils du graphe" }).waitFor();
  await page.getByRole("button", { name: /Types de relation/ }).waitFor();

  // Topic page: the knowledge button reflects the registration; the network link targets that topic.
  await page.goto(`${app.origin}/dashboard/topics/politiks.france`);
  assert.equal(await page.getByRole("button", { name: "Connaissance acquise" }).getAttribute("aria-pressed"), "true");
  await page.getByRole("link", { name: "Voir dans le réseau des topics" }).click();
  await page.waitForURL(/focus=/);
  await node(page, "Politique (#politiks)").waitFor();

  // Another user (mobile): none of the first user's knowledge, no horizontal scroll, panel usable from the list.
  const other = await user("other@example.com", { width: 390, height: 844 });
  other.on("pageerror", e => errors.push(e.message));
  await other.goto(`${app.origin}/dashboard/graph?view=topics`);
  await node(other, "Politique française").waitFor();
  assert.doesNotMatch(await node(other, "Politique française").getAttribute("aria-label") ?? "", /connaissances/);
  await layer(other, "Mes connaissances").getByText("0").waitFor();
  assert.ok(await other.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "no horizontal scroll");
  await other.getByRole("button", { name: "Liste" }).click();
  await other.getByRole("region", { name: "Liste du réseau" }).getByRole("button", { name: /Politique française/ }).click();
  const mobilePanel = other.getByRole("complementary", { name: "Politique française" });
  await mobilePanel.waitFor();
  assert.ok(await mobilePanel.evaluate(element => element === document.activeElement), "focus moves to the panel");
  const box = (await mobilePanel.boundingBox())!;
  assert.ok(box.width <= 390 && box.y > 200, "bottom sheet on mobile");
  // Panning the canvas doesn't scroll the page.
  const before = await other.evaluate(() => window.scrollY);
  await other.mouse.move(200, 300); await other.mouse.down(); await other.mouse.move(200, 200, { steps: 5 }); await other.mouse.up();
  assert.equal(await other.evaluate(() => window.scrollY), before);

  assert.deepEqual(errors, []);
});
