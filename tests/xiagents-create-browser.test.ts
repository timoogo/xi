import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium, type Browser } from "playwright-core";
import { createTestServer } from "./helpers/next-server";

test("ΞAgent creation: unavailable AI said as such, manual review, calendars by keyboard, Bloub, real deployment, controls", { timeout: 180_000 }, async t => {
  const app = await createTestServer();
  const resources: { browser?: Browser } = {};
  t.after(async () => { await resources.browser?.close(); await app.dispose(); });
  await app.migrate(); await app.start();
  const browser = resources.browser = await chromium.launch({ executablePath: process.env.XI_E2E_CHROME ?? "/usr/bin/google-chrome-stable", headless: true });
  const alice = await browser.newContext({ timezoneId: "Europe/Paris" }); const bob = await browser.newContext();
  const headers = { Origin: app.origin };
  for (const [context, name] of [[alice, "Alice"], [bob, "Bob"]] as const) assert.equal((await context.request.post(`${app.origin}/api/auth/sign-up/email`, { headers, data: { name, email: `${name}@create.test`, password: "create test password" } })).status(), 200);
  const topicRun = (await (await alice.request.post(`${app.origin}/api/topics/runs`, { headers, data: { intent: "Politiks fictif" } })).json()).run;
  await alice.request.post(`${app.origin}/api/topics/runs/${topicRun.id}`, { headers, data: { action: "resume" } });
  await alice.request.post(`${app.origin}/api/topics/runs/${topicRun.id}`, { headers, data: { action: "confirm", relationsConfirmed: true, draft: { tag: "politiks", name: "Politiks", description: "", scope: "Scénarios fictifs de politique", parentId: null, relatedIds: [] } } });

  const page = await alice.newPage(); page.setDefaultTimeout(15_000);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${app.origin}/dashboard/xiagents`);
  await page.getByRole("button", { name: "Créer un ΞAgent ou un topic" }).click();
  const dialog = page.getByRole("dialog", { name: "Nouveau ΞAgent" });
  await dialog.waitFor();
  // Step 1: manual entry, one of the three entries (smart, YAML, manual).
  await dialog.getByRole("radio", { name: /Saisie manuelle/ }).check();
  await dialog.getByRole("button", { name: "Saisir manuellement" }).click();

  // Step 2: review — validation before going on.
  await dialog.getByRole("heading", { name: "Vérifier" }).waitFor();
  await dialog.getByText("Saisie manuelle.").waitFor();
  await dialog.getByRole("button", { name: "Suivant" }).click();
  await dialog.getByRole("alert").filter({ hasText: "Nom requis." }).waitFor();
  await dialog.getByLabel("Nom", { exact: true }).fill("Veille Politiks");
  await dialog.getByLabel("Handle unique", { exact: false }).fill("veille-politiks");
  // Optional AI enrichment: the local model is not configured — said so, nothing invented, nothing lost.
  await dialog.getByRole("button", { name: "Enrichir avec l’IA locale" }).click();
  await dialog.getByText(/Moteur IA indisponible/).waitFor();
  assert.equal(await dialog.getByLabel("Nom", { exact: true }).inputValue(), "Veille Politiks");
  await dialog.getByLabel("Périmètre (ce que le ΞAgent couvre et ne couvre pas)").fill("Institutions fictives ; pas de rumeurs.");
  await dialog.getByLabel("Adresse d’une source à ajouter").fill("https://127.0.0.1/rss");
  await dialog.getByRole("button", { name: "Ajouter", exact: true }).click();
  await dialog.getByText("Ajoutée par vous", { exact: false }).waitFor();
  await dialog.getByRole("button", { name: "Suivant" }).click();

  // Step 3: calendars, keyboard only for the heatmap and tabs; precise times in the day editor.
  await dialog.getByRole("heading", { name: "Calendriers" }).waitFor();
  await dialog.getByRole("button", { name: "Modifier les plages du lundi (Calendrier de veille)" }).click();
  const day = page.getByRole("dialog", { name: "Lundi (semaine type)" });
  await day.getByRole("button", { name: "Ajouter une plage" }).click();
  await day.getByLabel("Début de la plage 2").fill("05:00");
  await day.getByLabel("Fin de la plage 2").fill("06:00");
  await day.getByRole("button", { name: "Enregistrer", exact: true }).click();
  await day.waitFor({ state: "detached" });
  await dialog.getByText("05:00–06:00, 07:00–23:00").waitFor();
  const heatmap = dialog.getByRole("group", { name: "Calendrier de veille : heures programmées par date" });
  await heatmap.locator('button[tabindex="0"]').focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  await dialog.getByRole("heading", { name: "Modification groupée — 1 jour(s) (Calendrier de veille)" }).waitFor();
  await dialog.getByLabel("Remplacer les plages").check();
  await dialog.getByLabel("Journée fermée (aucune plage)").check();
  await dialog.getByText("→ aucune plage", { exact: false }).waitFor();
  await dialog.getByRole("button", { name: "Appliquer" }).click();
  assert.equal(await heatmap.locator('button[aria-label*="exception"]').count(), 1);
  await dialog.getByRole("tab", { name: "Veille" }).focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(await dialog.getByRole("tab", { name: "Publication" }).getAttribute("aria-selected"), "true");
  await dialog.getByRole("group", { name: "Calendrier de publication : heures programmées par date" }).waitFor();
  await dialog.getByRole("button", { name: "Suivant" }).click();

  // Step 4: default Bloub, colour limited to readable ones; step 5: summary then deployment.
  await dialog.getByRole("heading", { name: "Personnaliser" }).waitFor();
  await dialog.getByRole("button", { name: "Bleu", exact: true }).click();
  await dialog.getByRole("button", { name: "Suivant" }).click();
  await dialog.getByText("Veille Politiks").waitFor();
  await dialog.getByText("Fuseau : Europe/Paris").waitFor();
  await dialog.getByRole("button", { name: "Déployer" }).click();

  await page.waitForURL(/\/dashboard\/xiagents\/deployments\/[0-9a-f-]{36}$/);
  const deploymentId = new URL(page.url()).pathname.split("/").at(-1)!;
  await page.getByText(/Déployé — 9\/9 étapes terminées/).waitFor({ timeout: 60_000 });
  // The unreachable source is logged as an error of its step, never hidden.
  await page.getByText(/Source non ajoutée \(127\.0\.0\.1\)/).waitFor({ state: "attached" });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "no horizontal scroll on mobile");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole("link", { name: "Ouvrir la page du ΞAgent" }).click();
  await page.waitForURL(/\/dashboard\/xiagents\/[0-9a-f-]{36}$/);
  const agentId = new URL(page.url()).pathname.split("/").at(-1)!;

  // Stored configuration.
  const { schedule } = await (await alice.request.get(`${app.origin}/api/xiagents/${agentId}/schedule`)).json();
  assert.equal(schedule.explicit, true); assert.equal(schedule.timeZone, "Europe/Paris");
  assert.deepEqual(schedule.watch.week[0], [{ start: 300, end: 360 }, { start: 420, end: 1380 }]);
  assert.deepEqual(Object.values(schedule.watch.exceptions), [[]]);
  assert.equal((await (await alice.request.get(`${app.origin}/api/xiagents/${agentId}/avatar`)).json()).config.color, "bleu");
  const watch = (await (await alice.request.get(`${app.origin}/api/xiagents/${agentId}/watch`)).json()).policy;
  assert.equal(watch.enabled, true); assert.equal(watch.paused, false);

  // Controls: automatic → paused → resumed; a manual run never changes the mode.
  const control = page.getByRole("region", { name: "Pilotage" });
  await control.locator("p", { hasText: "Mode : Automatique" }).waitFor();
  await control.getByRole("button", { name: "Lancer une veille" }).click();
  await control.getByRole("status").filter({ hasText: "Aucune source approuvée : rien à collecter." }).waitFor();
  await control.getByRole("button", { name: "Mettre en pause" }).click();
  await control.getByRole("status").filter({ hasText: "Pause indéfinie." }).waitFor();
  await control.locator("p", { hasText: "Mode : En pause (durée indéterminée)" }).waitFor();
  await control.getByRole("button", { name: "Reprendre maintenant" }).click();
  await control.locator("p", { hasText: "Mode : Automatique" }).waitFor();
  const history = page.getByRole("region", { name: "Historique d’exécution" });
  for (const kind of ["Veille manuelle", "Mise en pause", "Reprise"]) await history.getByRole("cell", { name: kind, exact: true }).first().waitFor();
  await history.getByRole("link", { name: "Détail" }).first().click();
  await page.getByRole("heading", { name: "Reprise" }).waitFor();
  await page.getByText("Reprise à partir de maintenant, sans rattrapage.").waitFor();

  // Isolation.
  assert.equal((await bob.request.get(`${app.origin}/api/xiagents/deployments/${deploymentId}`)).status(), 404);
  assert.equal((await bob.request.get(`${app.origin}/api/xiagents/${agentId}/schedule`)).status(), 404);
  assert.equal((await bob.request.post(`${app.origin}/api/xiagents/${agentId}/control`, { headers, data: { action: "pause", resumeAt: null, resumeWith: "now" } })).status(), 404);
  assert.equal((await alice.request.post(`${app.origin}/api/xiagents/${agentId}/control`, { data: { action: "pause", resumeAt: null, resumeWith: "now" } })).status(), 403, "Origin check");
  assert.deepEqual(errors, []);
});
