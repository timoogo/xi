import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { chromium, type Browser } from "playwright-core";
import { createTestServer } from "./helpers/next-server";
import { openVault } from "../src/lib/publications/vault";
import { createTopicStore } from "../src/lib/topics/store";
import { createSourceStore } from "../src/lib/watch/sources";

test("sources browser: trust list by ΞAgent, global decisions never overwritten, scope dialog by keyboard, search and filters", { timeout: 120_000 }, async t => {
  const app = await createTestServer();
  const resources: { browser?: Browser } = {};
  t.after(async () => { await resources.browser?.close(); await app.dispose(); });
  await app.migrate(); await app.start();
  const browser = resources.browser = await chromium.launch({ executablePath: process.env.XI_E2E_CHROME ?? "/usr/bin/google-chrome-stable", headless: true });
  const alice = await browser.newContext();
  const headers = { Origin: app.origin };
  const post = async (path: string, data: unknown) => {
    const response = await alice.request.post(app.origin + path, { headers, data });
    assert.equal(response.status(), 200, await response.text());
    return response.json();
  };
  await post("/api/auth/sign-up/email", { name: "Alice", email: "alice@sources.test", password: "sources test password" });
  const { run: topicRun } = await post("/api/topics/runs", { intent: "Politique fictive" });
  await post(`/api/topics/runs/${topicRun.id}`, { action: "resume" });
  await post(`/api/topics/runs/${topicRun.id}`, { action: "confirm", relationsConfirmed: true, draft: { tag: "politiks", name: "Politique", description: "Test", scope: "Scénarios fictifs", parentId: null, relatedIds: [] } });
  const { run: allocated } = await post("/api/accounts/runs", { topicId: topicRun.topicId });
  const { run: ready } = await post(`/api/accounts/runs/${allocated.id}`, { action: "resume" });
  const { run: complete } = await post(`/api/accounts/runs/${allocated.id}`, { action: "confirm", draft: ready.draft, confirmed: true });
  const ownerId = (await (await alice.request.get(`${app.origin}/api/auth/get-session`)).json()).user.id;
  const db = new Database(app.databasePath); db.pragma("busy_timeout = 5000");
  t.after(() => db.close());
  const vault = await openVault(app.vaultPath);
  const sources = createSourceStore({ vault, topics: createTopicStore({ vault, db }) });
  // Discovered by the agent (as the worker would), and one added manually then approved globally.
  await sources.propose(ownerId, { url: "https://gazette.example/rss", kind: "feed", site: null, publisher: "La Gazette", topicIds: [topicRun.topicId], reliability: { level: "inconnue", reasons: [], estimated: true } }, `agent:${complete.accountId}`);
  const { source: quotidien } = await sources.propose(ownerId, { url: "https://quotidien.example/rss", kind: "feed", site: null, publisher: "Le Quotidien", topicIds: [topicRun.topicId], reliability: { level: "inconnue", reasons: [], estimated: true } }, ownerId);
  await sources.decide(ownerId, quotidien.id, { action: "approve", revision: quotidien.revision });

  const page = await alice.newPage(); page.setDefaultTimeout(12_000);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${app.origin}/dashboard/sources`);
  const level = (publisher: string, scope = "pour tous les ΞAgents") => page.getByRole("combobox", { name: `Niveau de confiance de ${publisher} ${scope}` });
  const origin = async (publisher: string, scope?: string) => page.locator(`#${await level(publisher, scope).getAttribute("aria-describedby")}`).innerText();
  const status = (text: string) => page.getByRole("status").filter({ hasText: text }).waitFor();
  const decisions = async () => ((await (await alice.request.get(`${app.origin}/api/watch/trust`)).json()).decisions as { scope: string; decision: string }[]).map(d => `${d.scope}:${d.decision}`).sort();

  // Default: every ΞAgent, the selector is the global decision.
  await page.getByRole("columnheader", { name: "Niveau de confiance" }).waitFor();
  assert.equal(await page.getByLabel("ΞAgent", { exact: true }).inputValue(), "");
  assert.equal(await level("Le Quotidien").inputValue(), "approved");
  assert.equal(await origin("Le Quotidien"), "Globale");
  assert.deepEqual([await level("La Gazette").inputValue(), await origin("La Gazette")], ["pending", "Aucune décision"]);
  await page.getByRole("rowheader", { name: /La Gazette/ }).getByText("Découverte par @politiks").waitFor();

  // One ΞAgent: the selector sets the agent's decision, never the global one.
  await page.getByLabel("ΞAgent", { exact: true }).selectOption(complete.accountId);
  await level("Le Quotidien", "pour @politiks").focus();
  await level("Le Quotidien", "pour @politiks").selectOption("denied");
  await status("Le Quotidien : refusée pour @politiks.");
  assert.equal(await origin("Le Quotidien", "pour @politiks"), "Spécifique à @politiks");
  assert.deepEqual(await decisions(), ["agent:denied", "global:approved"], "the global approval is kept");
  await page.getByLabel("ΞAgent", { exact: true }).selectOption("");
  assert.equal(await level("Le Quotidien").inputValue(), "approved");
  assert.equal(await origin("Le Quotidien"), "Globale · 1 décision spécifique");

  // Scope dialog, keyboard only: global denial, then a topic approval for the other source.
  const scopeButton = page.getByRole("button", { name: "Périmètre des décisions pour Le Quotidien" });
  await scopeButton.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Périmètre — Le Quotidien" });
  await dialog.getByRole("combobox", { name: "Confiance de Le Quotidien — global" }).selectOption("denied");
  await status("Le Quotidien : refusée pour tous vos ΞAgents.");
  assert.equal(await dialog.getByRole("combobox", { name: "Confiance de Le Quotidien — @politiks" }).inputValue(), "denied");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Périmètre des décisions pour Le Quotidien", "focus returns to its trigger");
  // A global denial prevails over an agent approval, and says so.
  await page.getByLabel("ΞAgent", { exact: true }).selectOption(complete.accountId);
  await level("Le Quotidien", "pour @politiks").selectOption("approved");
  await status("Le refus global reste prioritaire.");
  assert.deepEqual([await level("Le Quotidien", "pour @politiks").inputValue(), await origin("Le Quotidien", "pour @politiks")], ["denied", "Refus global prioritaire"]);
  assert.deepEqual(await decisions(), ["agent:approved", "global:denied"]);
  // Inherited from a topic.
  await page.getByRole("button", { name: "Périmètre des décisions pour La Gazette" }).click();
  await page.getByRole("dialog").getByRole("combobox", { name: "Confiance de La Gazette — #politiks" }).selectOption("approved");
  await status("La Gazette : approuvée pour le topic #politiks.");
  await page.keyboard.press("Escape");
  assert.deepEqual([await level("La Gazette", "pour @politiks").inputValue(), await origin("La Gazette", "pour @politiks")], ["approved", "Héritée du topic #politiks"]);

  // Search and state filter.
  await page.getByLabel("État", { exact: true }).selectOption("denied");
  assert.deepEqual(await page.getByRole("rowheader").allInnerTexts().then(rows => rows.map(row => row.split("\n")[0])), ["Le Quotidien"]);
  await page.getByLabel("État", { exact: true }).selectOption("all");
  await page.getByLabel("Rechercher", { exact: true }).fill("gazette.example");
  assert.deepEqual(await page.getByRole("rowheader").allInnerTexts().then(rows => rows.map(row => row.split("\n")[0])), ["La Gazette"]);

  // Add: a known address (normalized) is reported with a link to its page, nothing is created.
  await page.getByLabel("Rechercher", { exact: true }).fill("");
  await page.getByRole("button", { name: "Ajouter une source" }).focus();
  await page.keyboard.press("Enter");
  const add = page.getByRole("dialog", { name: "Ajouter une source" });
  await add.getByLabel("Adresse").fill("GAZETTE.example/rss?utm_source=x");
  await add.getByLabel("#politiks").check();
  await add.getByRole("button", { name: "Ajouter", exact: true }).click();
  await add.getByText("Cette source est déjà dans votre catalogue (en attente)").waitFor();
  await add.getByRole("link", { name: "ouvrir La Gazette" }).click();

  // Detail page: identity, nothing invented, back link.
  await page.waitForURL(/\/dashboard\/sources\/[0-9a-f-]{36}$/);
  const gazetteId = new URL(page.url()).pathname.split("/").at(-1)!;
  await page.getByRole("heading", { name: "La Gazette", level: 1 }).waitFor();
  for (const text of ["https://gazette.example/rss", "Flux RSS/Atom", "Découverte par @politiks, le", "Jamais collectée", "Aucune actualité collectée pour l’instant."]) await page.getByText(text).first().waitFor();
  const section = (name: string) => page.getByRole("region", { name });

  // Edit metadata.
  await section("Métadonnées").getByLabel("Nom", { exact: true }).fill("La Gazette du Rhône");
  await section("Métadonnées").getByLabel("Fréquence de collecte (minutes)").fill("120");
  await section("Métadonnées").getByRole("button", { name: "Enregistrer" }).click();
  await status("Métadonnées enregistrées.");
  await page.getByRole("heading", { name: "La Gazette du Rhône", level: 2 }).or(page.getByText("Toutes les 120 min")).first().waitFor();

  // Collection switch, then trust: global approval, agent denial, revocation.
  await page.getByRole("button", { name: "Désactiver la collecte" }).click();
  await status("Collecte désactivée.");
  await section("Collecte").getByText("Désactivée", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Réactiver la collecte (en attente)" }).click();
  await status("Collecte réactivée.");
  await page.getByLabel("Confiance globale").selectOption("approved");
  await status("Approuvée pour tous vos ΞAgents.");
  await page.getByLabel("Décision pour @politiks").selectOption("denied");
  await status("Refusée pour @politiks.");
  await section("Confiance").getByRole("cell").getByText("Refusée").first().waitFor();
  await page.getByRole("button", { name: "Révoquer la décision pour @politiks" }).click();
  await status("Décision révoquée pour @politiks.");
  assert.equal(await page.getByLabel("Décision pour @politiks").inputValue(), "pending");
  await section("Historique des décisions").getByText("Collecte désactivée", { exact: true }).waitFor();

  // Deletion: explicit confirmation, then back to the list without the source.
  await page.getByRole("button", { name: "Supprimer…" }).click();
  const confirm = page.getByRole("dialog", { name: "Supprimer La Gazette du Rhône ?" });
  assert.equal(await confirm.getByRole("button", { name: "Supprimer définitivement" }).isDisabled(), true, "nothing without the confirmation");
  await page.keyboard.press("Escape");
  await confirm.waitFor({ state: "hidden" });
  assert.equal((await alice.request.get(`${app.origin}/api/watch/sources/${gazetteId}`)).status(), 200, "cancelled: still there");
  await page.getByRole("button", { name: "Supprimer…" }).click();
  await confirm.getByLabel("Je confirme la suppression de cette source").check();
  await confirm.getByRole("button", { name: "Supprimer définitivement" }).click();
  await page.waitForURL(`${app.origin}/dashboard/sources`, );
  await page.getByRole("rowheader", { name: /Le Quotidien/ }).waitFor();
  assert.equal(await page.getByRole("rowheader", { name: /La Gazette/ }).count(), 0);
  assert.equal((await alice.request.get(`${app.origin}/api/watch/sources/${gazetteId}`)).status(), 404);
  // From the list, a name opens its page.
  await page.getByRole("link", { name: "Le Quotidien" }).click();
  await page.getByRole("heading", { name: "Le Quotidien", level: 1 }).waitFor();
  await page.getByRole("link", { name: "Retour aux sources" }).click();
  await page.waitForURL(`${app.origin}/dashboard/sources`);
  assert.deepEqual(errors, []);
});
