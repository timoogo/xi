import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { chromium, type Browser } from "playwright-core";
import { createTestServer } from "./helpers/next-server";

test("ΞAgent creation: keywords without AI, edit, YAML export, invalid then valid import, deployment, export route, duplication", { timeout: 180_000 }, async t => {
  const app = await createTestServer();
  const resources: { browser?: Browser } = {};
  t.after(async () => { await resources.browser?.close(); await app.dispose(); });
  await app.migrate(); await app.start();
  const browser = resources.browser = await chromium.launch({ executablePath: process.env.XI_E2E_CHROME ?? "/usr/bin/google-chrome-stable", headless: true });
  const alice = await browser.newContext({ timezoneId: "Europe/Paris", acceptDownloads: true }); const bob = await browser.newContext();
  const headers = { Origin: app.origin };
  for (const [context, name] of [[alice, "Alice"], [bob, "Bob"]] as const) assert.equal((await context.request.post(`${app.origin}/api/auth/sign-up/email`, { headers, data: { name, email: `${name}@import.test`, password: "import test password" } })).status(), 200);

  const page = await alice.newPage(); page.setDefaultTimeout(15_000);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${app.origin}/dashboard/xiagents`);
  await page.getByRole("button", { name: "Créer un ΞAgent ou un topic" }).click();
  const dialog = page.getByRole("dialog", { name: "Nouveau ΞAgent" });

  // Smart creation from four keywords, with no model configured.
  await dialog.getByLabel("Sujet en quelques mots").fill("Astronomie, NASA, JWST, exoplanètes");
  await dialog.getByRole("button", { name: "Proposer une configuration" }).click();
  await dialog.getByRole("heading", { name: "Vérifier" }).waitFor();
  await dialog.getByText("James Webb Space Telescope", { exact: false }).first().waitFor();
  await dialog.locator("summary", { hasText: "Veille Astronomie" }).click();
  const name = dialog.getByLabel("Nom", { exact: true });
  assert.equal(await name.inputValue(), "Veille Astronomie");
  await name.fill("Ma veille astro");
  await dialog.locator("summary", { hasText: "Modifié par vous" }).first().waitFor();

  // Export of the edited draft.
  const [download] = await Promise.all([page.waitForEvent("download"), dialog.getByRole("button", { name: "Exporter le YAML" }).click()]);
  const yaml = await readFile((await download.path())!, "utf8");
  assert.match(yaml, /^# Configuration ΞAgent/);
  assert.match(yaml, /name: Ma veille astro/);
  assert.doesNotMatch(yaml, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);

  // Invalid then valid import, back on the first step.
  await dialog.getByRole("button", { name: "Précédent" }).click();
  await dialog.getByRole("radio", { name: /Importer un YAML/ }).check();
  const paste = dialog.getByLabel("Ou collez le YAML");
  await paste.fill("xiagent: 2\nidentity: { name: X }\n");
  await dialog.getByRole("button", { name: "Importer", exact: true }).click();
  await dialog.getByRole("list", { name: "Erreurs d’import" }).waitFor();
  await dialog.getByRole("heading", { name: "Décrire" }).waitFor();
  await paste.fill(yaml.replace("sources: []", "sources:\n  - url: https://science.nasa.gov/\n    status: approved\n  - url: https://127.0.0.1/promo\n    status: excluded"));
  await dialog.getByRole("button", { name: "Importer", exact: true }).click();
  await dialog.getByRole("heading", { name: "Vérifier" }).waitFor();
  await dialog.getByText("Importé (YAML) : vérifiez la proposition", { exact: false }).waitFor();
  await dialog.locator("summary", { hasText: "Ma veille astro" }).click();
  await name.fill("Veille astro importée");
  // Imported approved source is not approved automatically; the excluded one stays excluded, visibly.
  await dialog.getByText("Sources exclues par le fichier, conservées exclues", { exact: false }).waitFor();
  const sourcesSection = dialog.locator("details", { has: page.locator("summary", { hasText: "à décider" }) });
  assert.equal(await sourcesSection.getAttribute("open"), "", "the Sources section opens on imported exclusions");
  await sourcesSection.getByText("Exclusions (1) :", { exact: false }).waitFor();
  await sourcesSection.getByText("Exclue par le fichier YAML", { exact: false }).waitFor();
  assert.equal(await dialog.getByRole("group", { name: "Décision pour science.nasa.gov" }).getByLabel("Ne pas décider").isChecked(), true);
  const excludedDecision = dialog.getByRole("group", { name: "Décision pour 127.0.0.1" });
  assert.equal(await excludedDecision.getByLabel("Exclure").isChecked(), true);
  // The exclusion survives an export; it is lifted only by an explicit choice.
  const [again] = await Promise.all([page.waitForEvent("download"), dialog.getByRole("button", { name: "Exporter le YAML" }).click()]);
  assert.match(await readFile((await again.path())!, "utf8"), /url: https:\/\/127\.0\.0\.1\/promo\n\s+type: [^\n]*\n(\s+rationale: [^\n]*\n)?\s+status: excluded/);
  await excludedDecision.getByLabel("Approuver").check();
  await sourcesSection.getByText("Exclusions (", { exact: false }).waitFor({ state: "detached" });

  await dialog.getByRole("button", { name: "Suivant" }).click();
  await dialog.getByRole("heading", { name: "Calendriers" }).waitFor();
  await dialog.getByRole("button", { name: "Suivant" }).click();
  await dialog.getByRole("heading", { name: "Personnaliser" }).waitFor();
  await dialog.getByRole("button", { name: "Suivant" }).click();
  await dialog.getByText("Veille astro importée").waitFor();
  await dialog.getByRole("button", { name: "Déployer" }).click();
  await page.waitForURL(/\/dashboard\/xiagents\/deployments\/[0-9a-f-]{36}$/);
  await page.getByText(/Déployé — 9\/9 étapes terminées/).waitFor({ timeout: 60_000 });
  await page.getByText("Configuration importée depuis un fichier YAML", { exact: false }).waitFor({ state: "attached" });
  await page.getByRole("link", { name: "Ouvrir la page du ΞAgent" }).click();
  await page.waitForURL(/\/dashboard\/xiagents\/[0-9a-f-]{36}$/);
  const agentId = new URL(page.url()).pathname.split("/").at(-1)!;

  // Export of the deployed agent: owner only, no internal identifiers.
  const exported = await alice.request.get(`${app.origin}/api/xiagents/${agentId}/export`);
  assert.equal(exported.status(), 200);
  const text = await exported.text();
  assert.match(text, /name: Veille astro importée/);
  assert.ok(!text.includes(agentId));
  assert.equal((await bob.request.get(`${app.origin}/api/xiagents/${agentId}/export`)).status(), 404);

  // Duplication: configuration without history, the taken handle gets a free alternative.
  await page.getByRole("link", { name: "Dupliquer (sans historique)" }).click();
  await page.getByRole("dialog", { name: "Nouveau ΞAgent" }).getByRole("heading", { name: "Vérifier" }).waitFor();
  await page.getByRole("button", { name: /^Utiliser @veille-astronomie-2$/ }).waitFor();
  assert.deepEqual(errors, []);
});
