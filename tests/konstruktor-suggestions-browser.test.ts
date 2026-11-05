import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { test } from "node:test";
import { chromium, type Browser } from "playwright-core";
import { createTestServer } from "./helpers/next-server";

/** A local Ollama double: a perimeter for the "empty profile" finding, no proposal otherwise. */
async function fakeOllama(t: test.TestContext) {
  const server = http.createServer((request, response) => {
    let raw = "";
    request.on("data", chunk => { raw += chunk; });
    request.on("end", () => {
      if (request.url !== "/api/chat") { response.writeHead(404).end(); return; }
      const prompt = (JSON.parse(raw) as { messages: { content: string }[] }).messages.at(-1)!.content;
      const content = JSON.stringify(prompt.includes("périmètre éditorial de ce ΞAgent est vide")
        ? { reply: "Voici un périmètre et une charte.", proposal: { summary: "Définir le périmètre", perimeter: "Volcans actifs et surveillance volcanique.", charter: "Citer les observatoires." } }
        : { reply: "Rien à proposer automatiquement.", proposal: null });
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ message: { role: "assistant", content }, done: true }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

type Suggestion = { id: string; kind: string; status: string; sessionId: string; agents: { id: string }[]; proposals: { id: string }[]; title: string };

test("Konstruktor L6 over HTTP and in the browser: review, inbox, indicator, saved preview, explicit validation, isolation", { timeout: 180_000 }, async t => {
  const app = await createTestServer({ XI_INFERENCE_URL: await fakeOllama(t), XI_INFERENCE_MODEL: "qwen-test" });
  const resources: { browser?: Browser } = {};
  t.after(async () => { await resources.browser?.close(); await app.dispose(); });
  await app.migrate(); await app.start();
  const browser = resources.browser = await chromium.launch({ executablePath: process.env.XI_E2E_CHROME ?? "/usr/bin/google-chrome-stable", headless: true });
  const viewport = { width: 1280, height: 1000 };
  const alice = await browser.newContext({ viewport }); const bob = await browser.newContext({ viewport }); const anon = await browser.newContext();
  const headers = { Origin: app.origin };
  for (const [context, name] of [[alice, "Alice"], [bob, "Bob"]] as const) assert.equal((await context.request.post(`${app.origin}/api/auth/sign-up/email`, { headers, data: { name, email: `${name}@suggest.test`, password: "konstruktor suggest password" } })).status(), 200);
  const request = async (path: string, data?: unknown, status = 200, method: "POST" | "PUT" = "POST") => {
    const response = data === undefined ? await alice.request.get(app.origin + path) : await alice.request.fetch(app.origin + path, { method, headers, data });
    assert.equal(response.status(), status, await response.text());
    return response.json();
  };
  const { run: topicRun } = await request("/api/topics/runs", { intent: "Volcans" });
  await request(`/api/topics/runs/${topicRun.id}`, { action: "resume" });
  await request(`/api/topics/runs/${topicRun.id}`, { action: "confirm", relationsConfirmed: true, draft: { tag: "volcans", name: "Volcans", description: "", scope: "Volcanologie", parentId: null, relatedIds: [] } });
  const { run: allocated } = await request("/api/accounts/runs", { topicId: topicRun.topicId });
  const { run: ready } = await request(`/api/accounts/runs/${allocated.id}`, { action: "resume" });
  const { run: complete } = await request(`/api/accounts/runs/${allocated.id}`, { action: "confirm", draft: ready.draft, confirmed: true });
  const agentId: string = complete.accountId;
  // The agent's current perimeter and charter, read through a conversation's configuration (read-only).
  const reader = randomUUID();
  await request("/api/konstruktor/sessions", { id: reader, target: { type: "agent", id: agentId } });
  const profile = async () => { const { draft } = (await request(`/api/konstruktor/sessions/${reader}/configuration`)).configuration; return { perimeter: draft.perimeter, charter: draft.charter }; };
  const profileBefore = await profile();

  // ---------------------------------------------------------------- HTTP
  assert.equal((await anon.request.get(`${app.origin}/api/konstruktor/suggestions`)).status(), 401);
  assert.equal((await anon.request.post(`${app.origin}/api/konstruktor/reviews`, { headers })).status(), 401);
  assert.equal((await alice.request.post(`${app.origin}/api/konstruktor/reviews`, { headers: { Origin: "https://evil.test" } })).status(), 403);
  let review = (await request("/api/konstruktor/reviews", {})).request;
  for (let i = 0; i < 100 && review.state !== "done" && review.state !== "failed"; i++) { await new Promise(resolve => setTimeout(resolve, 150)); review = (await request(`/api/konstruktor/reviews?requestId=${review.requestId}`)).request; }
  assert.equal(review.state, "done", review.message ?? "");
  assert.equal((await request("/api/konstruktor/reviews", {})).request.requestId, review.requestId, "same state, same day: the same review");
  const suggestions: Suggestion[] = (await request("/api/konstruktor/suggestions")).suggestions;
  const empty = suggestions.find(item => item.kind === "empty-profile")!;
  assert.ok(empty, JSON.stringify(suggestions.map(item => item.kind)));
  assert.deepEqual([empty.status, empty.agents.map(agent => agent.id), empty.proposals.length], ["pending", [agentId], 1]);
  assert.deepEqual(await profile(), profileBefore, "nothing configured by the review");
  assert.equal((await request(`/api/konstruktor/suggestions?type=agent&id=${agentId}`)).suggestions.length, suggestions.filter(item => item.agents.some(agent => agent.id === agentId)).length);
  await request("/api/konstruktor/suggestions?type=agent&id=x", undefined, 400);
  // Bob sees and decides nothing of Alice's.
  assert.deepEqual((await (await bob.request.get(`${app.origin}/api/konstruktor/suggestions`)).json()).suggestions, []);
  assert.equal((await bob.request.post(`${app.origin}/api/konstruktor/suggestions/${empty.id}`, { headers, data: { action: "refuse" } })).status(), 404);
  assert.equal((await bob.request.get(`${app.origin}/api/konstruktor/sessions/${empty.sessionId}/preview`)).status(), 404);
  assert.equal((await bob.request.put(`${app.origin}/api/konstruktor/sessions/${empty.sessionId}/preview`, { headers, data: { selection: {}, manual: {}, topicManual: {}, seed: null, timeZone: null } })).status(), 404);
  await request(`/api/konstruktor/suggestions/${empty.id}`, { action: "supprimer" }, 400);
  await request(`/api/konstruktor/sessions/${empty.sessionId}/preview`, { selection: {}, manual: { owner: "bob" }, topicManual: {}, seed: null, timeZone: null }, 400, "PUT");

  // ---------------------------------------------------------------- browser
  const page = await alice.newPage(); page.setDefaultTimeout(20_000);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  // Discreet indicator on the ΞAgent page, leading to the inbox.
  await page.goto(`${app.origin}/dashboard/xiagents/${agentId}`);
  const panel = page.locator('[data-konstruktor="agent"]');
  await panel.locator("[data-suggestions]").waitFor();
  await page.goto(`${app.origin}/dashboard/konstruktor`);
  const pendingGroup = page.getByRole("region", { name: "En attente" });
  const item = pendingGroup.locator('[data-suggestion="empty-profile"]');
  await item.getByText("Pourquoi :").waitFor();
  await item.getByRole("button", { name: "Ouvrir l’aperçu" }).click();
  const preview = page.getByRole("region", { name: "Proposition ouverte" }).getByRole("region", { name: "Aperçu avant application" });
  await preview.getByRole("checkbox", { name: "charte" }).uncheck();
  await page.waitForTimeout(800);
  assert.deepEqual(await profile(), profileBefore, "saving the preview configures nothing");

  // Reloaded: the preview opens again with the owner's choice kept.
  await page.goto(`${app.origin}/dashboard/konstruktor?suggestion=${empty.id}`);
  const again = page.getByRole("region", { name: "Proposition ouverte" }).getByRole("region", { name: "Aperçu avant application" });
  await again.getByRole("checkbox", { name: "périmètre" }).waitFor();
  assert.equal(await again.getByRole("checkbox", { name: "charte" }).isChecked(), false, "kept after a reload");
  assert.equal(await again.getByRole("checkbox", { name: "périmètre" }).isChecked(), true);
  await again.getByRole("button", { name: "Valider et appliquer" }).click();
  await again.locator('[data-application="completed"]').waitFor({ timeout: 60_000 });
  const applied = await profile();
  assert.deepEqual([applied.perimeter, applied.charter], ["Volcans actifs et surveillance volcanique.", profileBefore.charter], "only the accepted field, after validation");
  await page.getByRole("region", { name: "Appliquées" }).locator('[data-suggestion="empty-profile"]').waitFor();

  // Never in the editorial feed.
  await page.goto(`${app.origin}/dashboard`);
  await page.waitForLoadState("networkidle");
  assert.equal(await page.getByText(empty.title).count(), 0);
  assert.equal(await page.getByRole("link", { name: "Propositions" }).count() > 0, true, "reachable from the dashboard");
  assert.deepEqual(errors, []);
});
