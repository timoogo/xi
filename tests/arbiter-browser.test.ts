import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { chromium, type Browser } from "playwright-core";
import { arbitrationId, migrateArbitrations, type Mention } from "../src/lib/arbiter/arbitration";
import { createTestServer } from "./helpers/next-server";

/** A recorded request, as the pipeline and @arbitre leave it (the pipeline itself is covered by arbiter.test.ts). */
function record(db: Database.Database, owner: string, handle: string, title: string, decision: { priority: boolean; justification: string } | null, at: number) {
  const agentId = `agent-${owner}`;
  const mention: Mention = {
    to: "@arbitre", from: { agentId, handle }, story: { id: `story-${title}`, version: 2, title, firstPublishedAt: null },
    claims: [{ text: `${title}.`, status: "corroborated", independent: 2 }], sources: [{ publisher: "Le Quotidien", title, url: "https://lequotidien.example/a", claims: [] }],
    context: { topic: null, summary: title }, factors: { importance: 0.95, alertThreshold: 0.85, independent: 2, primary: false, novelty: "new", details: [] }, justification: "Importance d’alerte.",
  };
  const id = arbitrationId(agentId, mention.story.id, 2);
  db.prepare("INSERT INTO arbiter_request VALUES (?, ?, ?, ?, 2, NULL, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)").run(
    id, owner, agentId, mention.story.id, title, JSON.stringify(mention), decision ? (decision.priority ? "favorable" : "refused") : "expired", decision ? null : "Aucune décision en 15 min.",
    decision ? JSON.stringify({ ...decision, criteria: ["Portée nationale"], model: "qwen-test sur Ollama local (configuration globale)", promptVersion: "arbitre-1.0", decidedAt: new Date(at).toISOString() }) : null,
    JSON.stringify({ result: decision?.priority ? "published" : "normal", reason: decision?.priority ? "Publiée." : "Circuit normal.", at: new Date(at).toISOString() }), at + 900_000, at, at,
  );
}

test("@arbitre's card: the viewer's arbitration history only, with requester, news, decision and justification", { timeout: 180_000 }, async t => {
  const app = await createTestServer();
  const resources: { browser?: Browser } = {};
  t.after(async () => { await resources.browser?.close(); await app.dispose(); });
  await app.migrate(); await app.start();
  const browser = resources.browser = await chromium.launch({ executablePath: process.env.XI_E2E_CHROME ?? "/usr/bin/google-chrome-stable", headless: true });
  const alice = await browser.newContext(); const bob = await browser.newContext();
  const ids: Record<string, string> = {};
  for (const [context, name] of [[alice, "Alice"], [bob, "Bob"]] as const) {
    const response = await context.request.post(`${app.origin}/api/auth/sign-up/email`, { headers: { Origin: app.origin }, data: { name, email: `${name}@arbitre.test`, password: "arbitre history password" } });
    assert.equal(response.status(), 200);
    ids[name] = (await response.json()).user.id;
  }
  const db = new Database(app.databasePath);
  t.after(() => db.close());
  migrateArbitrations(db);
  const at = Date.parse("2026-10-28T10:00:00Z");
  record(db, ids.Alice, "@politiks", "Le Premier ministre démissionne", { priority: true, justification: "Conséquences immédiates pour tout le pays." }, at);
  record(db, ids.Alice, "@politiks", "Une loi adoptée en commission", null, at + 1_000);
  record(db, ids.Bob, "@sciences", "Une comète visible ce soir", { priority: false, justification: "Rien ne presse : information de Bob." }, at);

  const page = await alice.newPage(); page.setDefaultTimeout(20_000);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${app.origin}/dashboard/xiagents?category=system#agent-arbitre`);
  const card = page.locator("#agent-arbitre");
  const history = card.getByRole("region", { name: "Historique des arbitrages" });
  await history.waitFor();
  assert.equal(await history.locator("[data-arbitration]").count(), 2);
  const favorable = history.locator('[data-arbitration="favorable"]');
  for (const text of ["@politiks", "Le Premier ministre démissionne", "Prioritaire : oui", "Conséquences immédiates pour tout le pays.", "Portée nationale", "prompt arbitre-1.0", "Publiée"]) await favorable.getByText(text, { exact: false }).first().waitFor();
  await history.locator('[data-arbitration="expired"]').getByText("Délai dépassé").waitFor();
  assert.equal(await page.getByText("information de Bob").count(), 0, "never another user's request");
  // Konstruktor's card has no arbitration history; @arbitre's Bloub and state are shown.
  assert.equal(await page.locator("#agent-konstruktor").getByRole("region", { name: "Historique des arbitrages" }).count(), 0);
  await card.getByText(/^@arbitre · /).waitFor();
  assert.deepEqual(errors, []);

  const other = await bob.newPage();
  await other.goto(`${app.origin}/dashboard/xiagents?category=system`);
  const bobHistory = other.locator("#agent-arbitre").getByRole("region", { name: "Historique des arbitrages" });
  await bobHistory.locator('[data-arbitration="refused"]').getByText("Rien ne presse").waitFor();
  assert.equal(await bobHistory.locator("[data-arbitration]").count(), 1);
  assert.equal(await other.getByText("Le Premier ministre démissionne").count(), 0);
});
