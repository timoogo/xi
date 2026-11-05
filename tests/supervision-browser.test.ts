import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { chromium, type Browser } from "playwright-core";
import { migrateArbitrations } from "../src/lib/arbiter/arbitration";
import { createJobQueue } from "../src/lib/watch/jobs";
import { finishRun, startRun } from "../src/lib/watch/orchestrator";
import { migrateWatchDecisions } from "../src/lib/watch/publisher";
import { migrateEditorialQueue } from "../src/lib/watch/queue";
import { migrateWatchItems } from "../src/lib/watch/stories";
import { localDate } from "../src/lib/xiagents/calendar";
import { createTestServer } from "./helpers/next-server";

const HOUR = 3_600_000;

test("supervision: HTTP projection scoped to the viewer, kept across a restart; global calendar, queue and executions in the browser", { timeout: 180_000 }, async t => {
  const app = await createTestServer();
  const resources: { browser?: Browser } = {};
  t.after(async () => { await resources.browser?.close(); await app.dispose(); });
  await app.migrate(); await app.start();
  const browser = resources.browser = await chromium.launch({ executablePath: process.env.XI_E2E_CHROME ?? "/usr/bin/google-chrome-stable", headless: true });
  const viewport = { width: 1280, height: 1000 };
  const alice = await browser.newContext({ viewport }); const bob = await browser.newContext({ viewport }); const anon = await browser.newContext();
  const headers = { Origin: app.origin };
  const ids: Record<string, string> = {};
  for (const [context, name] of [[alice, "Alice"], [bob, "Bob"]] as const) {
    const response = await context.request.post(`${app.origin}/api/auth/sign-up/email`, { headers, data: { name, email: `${name}@supervision.test`, password: "supervision test password" } });
    assert.equal(response.status(), 200);
    ids[name] = (await response.json()).user.id;
  }
  const post = async (path: string, data: unknown) => { const response = await alice.request.post(app.origin + path, { headers, data }); assert.equal(response.status(), 200, await response.text()); return response.json(); };
  const { run: topic } = await post("/api/topics/runs", { intent: "Politique fictive" });
  await post(`/api/topics/runs/${topic.id}`, { action: "resume" });
  await post(`/api/topics/runs/${topic.id}`, { action: "confirm", relationsConfirmed: true, draft: { tag: "politiks", name: "Politique", description: "Test", scope: "Scénarios fictifs", parentId: null, relatedIds: [] } });
  const { run: allocated } = await post("/api/accounts/runs", { topicId: topic.topicId });
  const { run: ready } = await post(`/api/accounts/runs/${allocated.id}`, { action: "resume" });
  const { run: complete } = await post(`/api/accounts/runs/${allocated.id}`, { action: "confirm", draft: ready.draft, confirmed: true });
  const agentId: string = complete.accountId;

  // What the worker would have left: runs, a decision, a queue row, an @arbitre request (and Bob's rows).
  const db = new Database(app.databasePath);
  t.after(() => db.close());
  migrateWatchItems(db); migrateWatchDecisions(db); migrateArbitrations(db); migrateEditorialQueue(db);
  const now = Date.now();
  const at = now - 2 * HOUR;
  const day = localDate(at, "Europe/Paris");
  const owner = ids.Alice;
  db.prepare("INSERT INTO watch_story VALUES ('s1', ?, 'Le Premier ministre démissionne', ?, ?, NULL, 2, 2, 2, '[]', ?)").run(owner, at, at, at);
  const queue = createJobQueue(db);
  queue.enqueue({ kind: "draft-candidate", key: "seed-draft", payload: { agentId, storyId: "s1" } });
  const runs: [string, string, "done" | "failed", unknown, string | undefined][] = [
    ["r1", "collect-source", "failed", null, undefined], ["r2", "evaluate-story", "done", { outcome: "rejected" }, undefined], ["r3", "draft-candidate", "done", { outcome: "drafted" }, queue.get("seed-draft")!.id],
  ];
  runs.forEach(([id, kind, status, result, jobId], index) => {
    startRun(db, { id, jobId, agentId, owner, kind, trigger: "calendar" }, at + index * 60_000);
    finishRun(db, id, status, at + index * 60_000 + 1_000, { result, ...(status === "failed" ? { error: "Error: flux injoignable" } : {}) });
  });
  startRun(db, { id: "bob-run", agentId, owner: ids.Bob, kind: "collect-source", trigger: "calendar" }, at);
  finishRun(db, "bob-run", "failed", at + 1_000, { error: "Error: secret de Bob" });
  db.prepare("INSERT INTO editorial_queue VALUES ('d1', ?, ?, 's1', 2, ?, 'immediate', 0, 0.95, 0.8, ?, ?, 'ready', NULL, ?, ?)").run(owner, agentId, topic.topicId, at - HOUR, at + 35 * HOUR, at, at);
  db.prepare("INSERT INTO arbiter_request VALUES ('a1', ?, ?, 's1', 2, NULL, 'Le Premier ministre démissionne', '{}', NULL, 'refused', NULL, ?, NULL, ?, ?, ?)")
    .run(owner, agentId, JSON.stringify({ priority: false, justification: "Peut attendre la fenêtre.", criteria: [], model: "m", promptVersion: "arbitre-1.0", decidedAt: new Date(at).toISOString() }), at + HOUR, at + 3 * 60_000, at + 3 * 60_000);

  // HTTP: session required, parameters validated, rows of the viewer only.
  const api = (context: typeof alice, query: string) => context.request.get(`${app.origin}/api/xiagents/supervision?${query}`);
  assert.equal((await api(anon, "view=queue")).status(), 401);
  const invalid = await api(alice, "view=activity&from=2026-02-10&to=2026-02-01");
  assert.equal(invalid.status(), 400);
  assert.match((await invalid.json()).error, /Période invalide/);
  assert.equal((await api(alice, "tz=Mars/Olympus")).status(), 400);
  const activity = await (await api(alice, "view=activity")).json();
  assert.deepEqual(activity.items.map((item: { type: string; state: string }) => `${item.type}:${item.state}`).sort(), ["arbitration:done", "run:done", "run:empty", "run:error"]);
  assert.ok(!JSON.stringify(activity).includes("secret de Bob"));
  const asBob = await (await api(bob, `view=activity&agent=${agentId}`)).json();
  assert.deepEqual([asBob.agents, asBob.scoped, asBob.items], [[], [], []], "Bob sees nothing of Alice's agent, even by id");
  const calendar = await (await api(alice, `view=calendar&date=${day}`)).json();
  assert.equal(calendar.day.lanes.length, 1);
  assert.ok(calendar.days.find((item: { date: string }) => item.date === day).errors === 1);
  const before = await (await api(alice, "view=queue")).json();
  assert.deepEqual(before.rows.map((row: { draftId: string; state: string; title: string }) => [row.draftId, row.state, row.title]), [["d1", "ready", "Le Premier ministre démissionne"]]);

  // Restart: the same projection from the database.
  await app.stop(); await app.start();
  const after = await (await api(alice, "view=queue")).json();
  assert.deepEqual(after.rows, before.rows.map((row: { freshness: number }) => ({ ...row, freshness: after.rows[0].freshness })));
  assert.deepEqual(after.counts, { ready: 1, published: 0, withdrawn: 0, expired: 0 });

  // Browser.
  const page = await alice.newPage(); page.setDefaultTimeout(20_000);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${app.origin}/dashboard`);
  await page.getByRole("link", { name: "Supervision" }).first().click();
  await page.waitForURL(/\/dashboard\/supervision/);
  await page.getByRole("heading", { name: "Supervision éditoriale" }).first().waitFor();
  await page.goto(`${app.origin}/dashboard/supervision?date=${day}`);
  const cell = page.locator(`[data-date="${day}"] a`);
  assert.match((await cell.getAttribute("aria-label"))!, /1 en erreur/);
  assert.equal(await cell.getAttribute("aria-current"), "date");
  const lane = page.locator(`[data-lane="${agentId}"]`);
  await lane.waitFor();
  assert.match(await lane.innerText(), /calendrier historique/);
  await page.getByText(/aucun horaire n’est réservé à l’avance/).waitFor();
  const happened = page.getByRole("list", { name: "Exécutions et décisions" });
  await happened.locator('[data-state="error"]').getByText("Error: flux injoignable").waitFor();
  await happened.locator('[data-activity="run"][data-state="empty"]').getByText("Sans suite (aucune actualité pertinente)").waitFor();

  await page.getByRole("link", { name: "Queue éditoriale" }).click();
  await page.waitForURL(/view=queue/);
  const item = page.locator('[data-queue="ready"]');
  await item.getByText("« Le Premier ministre démissionne »").waitFor();
  await item.getByText("@arbitre : prioritaire : non — Peut attendre la fenêtre.").waitFor();
  assert.equal(await item.getByRole("button").count(), 0, "read-only: no action on a queued content");
  await page.getByRole("combobox", { name: "État" }).click();
  await page.getByRole("option", { name: "Publié" }).click();
  await page.waitForURL(/state=published/);
  await page.getByText("Aucun contenu à l’état « Publié ».").waitFor();
  await page.goto(`${app.origin}/dashboard/supervision?view=queue`);
  await page.locator('[data-queue="ready"]').getByRole("link", { name: "Historique de cette actualité" }).click();
  await page.waitForURL(/story=s1/);
  await page.locator('[data-activity="arbitration"]').getByText(/Prioritaire : non\. Peut attendre la fenêtre\./).waitFor();
  assert.equal(await page.locator('[data-activity="run"]').count(), 1, "only this news' runs");

  await page.goto(`${app.origin}/dashboard/supervision?view=activity&state=error`);
  assert.equal(await page.getByRole("list", { name: "Exécutions et décisions" }).getByRole("listitem").count(), 1);
  await page.goto(`${app.origin}/dashboard/supervision?view=activity&from=2026-02-10&to=2026-02-01`);
  await page.getByRole("alert").getByText("Période invalide : le début suit la fin.").waitFor();
  // Phone width: no horizontal page scroll on the calendar and the queue.
  await page.setViewportSize({ width: 390, height: 900 });
  for (const view of [`date=${day}`, "view=queue", "view=activity"]) {
    await page.goto(`${app.origin}/dashboard/supervision?${view}`);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `no horizontal scroll (${view})`);
  }
  assert.deepEqual(errors, []);

  const other = await bob.newPage();
  await other.goto(`${app.origin}/dashboard/supervision`);
  await other.getByText(/pour suivre ici ses calendriers et ses publications/).waitFor();
  assert.equal(await other.getByText("Le Premier ministre démissionne").count(), 0);
});
