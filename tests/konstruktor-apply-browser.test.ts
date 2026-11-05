import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { test } from "node:test";
import { chromium, type Browser } from "playwright-core";
import { previewDraft } from "../src/lib/konstruktor/preview";
import type { Configuration } from "../src/lib/konstruktor/service";
import type { KonstruktorSession } from "../src/lib/konstruktor/types";
import { draftToEditSpec } from "../src/lib/xiagents/edit";
import { createTestServer } from "./helpers/next-server";

/** A local Ollama double: the proposal depends on the conversation's target. */
async function fakeOllama(t: test.TestContext) {
  const server = http.createServer((request, response) => {
    let raw = "";
    request.on("data", chunk => { raw += chunk; });
    request.on("end", () => {
      if (request.url !== "/api/chat") { response.writeHead(404).end(); return; }
      const prompt = (JSON.parse(raw) as { messages: { content: string }[] }).messages.at(-1)!.content;
      const creation = prompt.includes("\"cible\": \"Nouveau ΞAgent\"");
      const content = JSON.stringify(creation
        ? {
          reply: "Voici une veille nocturne.", unsupported: ["Plage de préparation distincte avant 3 h."],
          proposal: {
            summary: "Créer @veille-nuit", name: "Veille de nuit", handle: "veille-nuit", perimeter: "Volcans actifs, la nuit.", topics: [{ existing: "T1" }],
            schedule: { timeZone: "Europe/Paris", watch: { ranges: [{ from: "22:00", to: "02:00" }] }, publish: { ranges: [{ from: "02:00", to: "06:00" }] }, graceMinutes: 60 },
            publication: { autoPublish: true, maxPerDay: 2, minIntervalMinutes: 60 },
          },
        }
        : { reply: "Je précise.", proposal: { summary: "Préciser la veille", perimeter: "Volcans actifs et séismes associés.", publication: { maxPerDay: 5 } } });
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ message: { role: "assistant", content }, done: true }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

test("Konstruktor L5 over HTTP and in the browser: configuration, decisions, validation, 409, application, isolation", { timeout: 180_000 }, async t => {
  const app = await createTestServer({ XI_INFERENCE_URL: await fakeOllama(t), XI_INFERENCE_MODEL: "qwen-test" });
  const resources: { browser?: Browser } = {};
  t.after(async () => { await resources.browser?.close(); await app.dispose(); });
  await app.migrate(); await app.start();
  const browser = resources.browser = await chromium.launch({ executablePath: process.env.XI_E2E_CHROME ?? "/usr/bin/google-chrome-stable", headless: true });
  const viewport = { width: 1280, height: 1000 };
  const alice = await browser.newContext({ viewport }); const bob = await browser.newContext({ viewport });
  const headers = { Origin: app.origin };
  for (const [context, name] of [[alice, "Alice"], [bob, "Bob"]] as const) assert.equal((await context.request.post(`${app.origin}/api/auth/sign-up/email`, { headers, data: { name, email: `${name}@apply.test`, password: "konstruktor apply password" } })).status(), 200);
  const request = async (path: string, data?: unknown, status = 200) => {
    const response = data === undefined ? await alice.request.get(app.origin + path) : await alice.request.post(app.origin + path, { headers, data });
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
  const sessions = "/api/konstruktor/sessions";
  const converse = async (target: { type: string; id: string | null }, text: string) => {
    const id = randomUUID();
    await request(sessions, { id, target });
    await request(`${sessions}/${id}/messages`, { requestId: randomUUID(), text });
    let session: KonstruktorSession | null = null;
    for (let i = 0; i < 100 && session?.turn?.state !== "done"; i++) { await new Promise(resolve => setTimeout(resolve, 150)); session = (await request(`${sessions}/${id}`)).session; }
    assert.equal(session!.turn!.state, "done");
    return { id, session: session! };
  };

  // ---------------------------------------------------------------- HTTP: existing ΞAgent
  const { id, session } = await converse({ type: "agent", id: agentId }, "Ajoute les séismes.");
  const [proposal] = session.history.flatMap(message => message.proposals);
  const policyBefore = await request(`/api/xiagents/${agentId}/watch`);
  const { configuration } = await request(`${sessions}/${id}/configuration`) as { configuration: Configuration };
  assert.equal(configuration.kind, "agent");
  if (configuration.kind !== "agent") return;
  assert.equal((await bob.request.get(`${app.origin}${sessions}/${id}/configuration`)).status(), 404);
  assert.equal((await bob.request.post(`${app.origin}${sessions}/${id}/decisions`, { headers, data: { refused: [proposal.id] } })).status(), 404);
  await request(`${sessions}/${id}/decisions`, { refused: [randomUUID()] }, 404);
  await request(`${sessions}/${id}/decisions`, { refused: [proposal.id], extra: true }, 400);

  // Refused, then reconsidered: decisions only.
  assert.equal((await request(`${sessions}/${id}/decisions`, { refused: [proposal.id] })).session.history[1].proposals[0].status, "refused");
  assert.equal((await request(`${sessions}/${id}/decisions`, { reset: [proposal.id] })).session.history[1].proposals[0].status, "proposed");
  assert.deepEqual(await request(`/api/xiagents/${agentId}/watch`), policyBefore, "nothing written before validation");

  const { draft } = previewDraft(configuration.draft, [proposal], { [proposal.id]: ["limits"] }, {});
  const spec = draftToEditSpec(configuration.draft, draft, configuration.base);
  await request(`${sessions}/${id}/apply`, { deploymentId: randomUUID(), spec: { ...spec, agentId: randomUUID() }, accepted: [] }, 400);
  assert.equal((await bob.request.post(`${app.origin}${sessions}/${id}/apply`, { headers, data: { deploymentId: randomUUID(), spec, accepted: [] } })).status(), 404);
  const deploymentId = randomUUID();
  const applied = await request(`${sessions}/${id}/apply`, { deploymentId, spec, accepted: [proposal.id] });
  assert.equal(applied.session.history[1].proposals[0].status, "accepted");
  assert.equal((await request(`/api/xiagents/${agentId}/watch`)).policy.maxPerDay, policyBefore.policy.maxPerDay, "validated, not yet run");
  assert.equal((await request(`/api/xiagents/deployments/${deploymentId}`, { action: "run" })).deployment.state, "completed");
  const policy = await request(`/api/xiagents/${agentId}/watch`);
  assert.deepEqual([policy.policy.maxPerDay, policy.policy.visibility], [5, "private"]);
  assert.equal((await request(`${sessions}/${id}`)).session.history[1].proposals[0].status, "applied");
  // A second preview built on the same, now outdated, revisions: 409, review needed.
  const outdated = draftToEditSpec(configuration.draft, { ...draft, limits: { ...draft.limits, maxPerDay: 6 } }, configuration.base);
  const stale = await alice.request.post(`${app.origin}${sessions}/${id}/apply`, { headers, data: { deploymentId: randomUUID(), spec: outdated, accepted: [] } });
  assert.equal(stale.status(), 409);
  assert.match((await stale.json()).error, /revoyez les différences/);
  assert.equal((await request(`/api/xiagents/${agentId}/watch`)).policy.maxPerDay, 5);

  // ---------------------------------------------------------------- browser: new ΞAgent
  const page = await alice.newPage(); page.setDefaultTimeout(20_000);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${app.origin}/dashboard/xiagents`);
  const panel = page.locator('[data-konstruktor="new-agent"]');
  await panel.getByText("Discuter avec @konstruktor").click();
  await panel.getByLabel("Message pour Konstruktor").fill("Crée-moi un agent qui surveille les volcans, travaille entre 22 h et 2 h, prépare ses articles avant 3 h et publie pendant la nuit uniquement s'il trouve une actualité intéressante.");
  await panel.getByRole("button", { name: "Envoyer" }).click();
  await panel.locator('[data-turn="done"]').waitFor();
  await panel.getByRole("list", { name: "Demandes non prises en charge" }).getByText("Plage de préparation distincte avant 3 h.").waitFor();
  await panel.getByRole("button", { name: "Revoir et appliquer les propositions" }).click();
  const review = panel.getByRole("region", { name: "Aperçu avant application" });
  await review.getByRole("list", { name: "Propositions à valider" }).getByText("Créer @veille-nuit", { exact: true }).waitFor();
  // Partial: no autonomous publication.
  await review.getByRole("checkbox", { name: "publication autonome" }).uncheck();
  await review.getByRole("button", { name: "Valider et appliquer" }).click();
  await review.locator('[data-application="completed"]').waitFor({ timeout: 60_000 });
  await review.getByRole("link", { name: "Journal d’application" }).first().waitFor();
  await review.locator('li[data-status="applied"]').waitFor();
  const created = (await request("/api/accounts")).accounts.find((account: { handle: string }) => account.handle === "veille-nuit");
  assert.ok(created, "the ΞAgent exists after validation");
  const schedule = (await request(`/api/xiagents/${created.id}/schedule`)).schedule;
  assert.deepEqual(schedule.watch.week[2], [{ start: 1320, end: 120 }], "crosses midnight");
  const createdPolicy = await request(`/api/xiagents/${created.id}/watch`);
  assert.deepEqual([createdPolicy.policy.autoPublish, createdPolicy.policy.maxPerDay, createdPolicy.policy.visibility], [false, 2, "private"], "unchecked field left out");
  assert.equal((await bob.request.get(`${app.origin}/api/xiagents/${created.id}/watch`)).status(), 404);
  assert.deepEqual(errors, []);
});
