import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import Database from "better-sqlite3";
import { createTestServer } from "./helpers/next-server";
import { openVault } from "../src/lib/publications/vault";
import { createTopicStore } from "../src/lib/topics/store";
import { createSourceStore } from "../src/lib/watch/sources";
import { createPublicationStore } from "../src/lib/publications/store";
import { migrateWatchCandidates } from "../src/lib/watch/evaluate";

test("ΞAgent management page: owner renders identity, topics and history; missing and foreign agents stay 404", { timeout: 60_000 }, async t => {
  const app = await createTestServer(); t.after(() => app.dispose());
  await app.migrate(); await app.start();
  const signup = async (name: string) => {
    const response = await fetch(`${app.origin}/api/auth/sign-up/email`, { method: "POST", headers: { Origin: app.origin, "Content-Type": "application/json" }, body: JSON.stringify({ name, email: `${name}@page.test`, password: "test page password" }) });
    assert.equal(response.status, 200);
    return response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
  };
  const owner = await signup("owner"), other = await signup("other");
  const post = async (path: string, data: unknown) => {
    const response = await fetch(app.origin + path, { method: "POST", headers: { Cookie: owner, Origin: app.origin, "Content-Type": "application/json" }, body: JSON.stringify(data) });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  const { run: topic } = await post("/api/topics/runs", { intent: "Politique fictive" });
  await post(`/api/topics/runs/${topic.id}`, { action: "resume" });
  await post(`/api/topics/runs/${topic.id}`, { action: "confirm", relationsConfirmed: true, draft: { tag: "politiks", name: "Politique", description: "Test", scope: "Scénarios fictifs", parentId: null, relatedIds: [] } });
  const { run: allocated } = await post("/api/accounts/runs", { topicId: topic.topicId });
  const { run: ready } = await post(`/api/accounts/runs/${allocated.id}`, { action: "resume" });
  const { run: complete } = await post(`/api/accounts/runs/${allocated.id}`, { action: "confirm", draft: ready.draft, confirmed: true });
  assert.equal(complete.state, "completed");
  const path = `/dashboard/xiagents/${complete.accountId}`;
  const page = await fetch(app.origin + path, { headers: { Cookie: owner } });
  const html = (await page.text()).replace(/<!--[\s\S]*?-->/g, "");
  assert.equal(page.status, 200, app.output());
  for (const text of ["@politiks", "Politique", "Topics", "politiks", "Historique des publications", "Aucune publication", "Générer une publication"]) assert.ok(html.includes(text), text);
  assert.ok(!html.includes('"name":"TypeError"'));
  for (const [cookie, target] of [[owner, `/dashboard/xiagents/${randomUUID()}`], [other, path], [owner, "/dashboard/xiagents/invalid"]]) {
    const response = await fetch(app.origin + target, { headers: { Cookie: cookie } });
    assert.equal(response.status, 404, app.output());
    assert.ok(!(await response.text()).includes("Générer une publication"));
  }
  const catalog = await (await fetch(app.origin + "/api/accounts", { headers: { Cookie: owner } })).json();
  const agent = catalog.accounts.find((a: { id: string }) => a.id === complete.accountId);
  const endpoint = `/api/xiagents/${agent.id}/publications`;
  const choice = { seed: randomUUID(), count: 2, accountRevision: agent.editorial.revision };
  const privateId = (await post(endpoint, { ...choice, action: "publish", confirmed: true })).publication.id;
  const history = await fetch(app.origin + path, { headers: { Cookie: owner } });
  assert.equal(history.status, 200, app.output());
  assert.ok((await history.text()).includes("Contenu de test fictif"));
  assert.equal((await fetch(app.origin + path, { headers: { Cookie: other } })).status, 404);

  // Forged requests cannot publish publicly without the server-side confirmation, nor reuse a preview.
  const raw = (data: unknown, cookie = owner) => fetch(app.origin + endpoint, { method: "POST", headers: { Cookie: cookie, Origin: app.origin, "Content-Type": "application/json" }, body: JSON.stringify(data) });
  const publicChoice = { ...choice, seed: randomUUID(), action: "publish", confirmed: true, visibility: "public", publicConfirmed: true, messages: ["Texte **modifié**", "Suite modifiée"] };
  for (const forged of [
    { ...publicChoice, publicConfirmed: false }, { ...publicChoice, publicConfirmed: undefined }, { ...publicChoice, publicConfirmed: "true" },
    { ...publicChoice, confirmed: false }, { ...publicChoice, visibility: "PUBLIC" }, { ...publicChoice, visibility: "followers" },
    { ...publicChoice, action: "generate" }, { ...publicChoice, authorId: "owner" }, { ...publicChoice, status: "published" },
    { ...publicChoice, seed: choice.seed }, { ...publicChoice, messages: ["Un seul"] },
  ]) assert.equal((await raw(forged)).status, 400, JSON.stringify(forged));
  assert.equal((await raw(publicChoice, other)).status, 404);
  assert.equal((await (await fetch(app.origin + `/api/publications/${privateId}`, { headers: { Cookie: owner } })).json()).publication.visibility, "private");
  const publicId = (await post(endpoint, publicChoice)).publication.id;

  const read = (cookie: string, target: string) => fetch(app.origin + target, { headers: { Cookie: cookie } });
  async function checkAccess() {
    // The conversation page is a client shell for any id; its data comes from /api/conversations, checked below.
    assert.ok(!(await (await read(other, `/dashboard/publications/${privateId}/conversation/1`)).text()).includes("Contenu de test fictif"));
    for (const target of [`/api/publications/${privateId}`, `/dashboard/publications/${privateId}`, `/api/conversations?ref=${privateId}/2`, `/api/graph/message?ref=${privateId}/1`]) {
      const response = await read(other, target);
      assert.equal(response.status, 404, target);
      assert.ok(!(await response.text()).includes("Contenu de test fictif — 1/2"), target);
      assert.equal((await read(owner, target)).status, 200, target);
    }
    for (const target of [`/api/publications/${publicId}`, `/dashboard/publications/${publicId}`, `/dashboard/publications/${publicId}/conversation/1`, `/api/conversations?ref=${publicId}/2`, `/api/graph/message?ref=${publicId}/1`]) assert.equal((await read(other, target)).status, 200, target);
    const seen = await (await read(other, `/api/publications/${publicId}`)).json();
    assert.equal(seen.publication.visibility, "public"); assert.equal(seen.publication.authorType, "ai"); assert.equal(seen.publication.authorId, agent.id);
    assert.equal(seen.authors[agent.id].handle, "@politiks");
    assert.deepEqual(seen.publication.messages.map((m: { body: string }) => m.body), ["**Contenu de test fictif — 1/2**\n\nTexte **modifié**", "**Contenu de test fictif — 2/2**\n\nSuite modifiée"]);
    const conversation = await (await read(other, `/api/conversations?ref=${publicId}/2`)).json();
    assert.deepEqual(conversation.ancestors.map((entry: { ref: string }) => entry.ref), [`${publicId}/1`]);
  }
  await checkAccess();
  await app.stop(); await app.start();
  await checkAccess();

  // Watch policy: owner-only, Origin-checked, validated and revisioned; disabled by default.
  const watchPath = `${app.origin}/api/xiagents/${agent.id}/watch`;
  const patch = (cookie: string, data: unknown, origin = app.origin) => fetch(watchPath, { method: "PATCH", headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(data) });
  const initial = await (await read(owner, `/api/xiagents/${agent.id}/watch`)).json();
  assert.deepEqual(initial, { policy: { enabled: false, paused: false, maxPerDay: 3, minIntervalMinutes: 240, testMaxPerDay: 10, alertThreshold: 0.85, nightThreshold: 0.45, autoPublish: false, visibility: "private", maxImmediatePerDay: 1 }, revision: null, valid: true, publicConfirmedAt: null });
  assert.equal((await read(other, `/api/xiagents/${agent.id}/watch`)).status, 404);
  const policy = { enabled: true, paused: true, maxPerDay: 2, minIntervalMinutes: 360 };
  assert.equal((await patch(owner, { revision: null, policy }, "https://foreign.example")).status, 403);
  assert.equal((await patch(other, { revision: null, policy })).status, 404);
  for (const invalid of [{ revision: null, policy: { ...policy, maxPerDay: 0 } }, { revision: null, policy: { ...policy, publishNow: true } }, { revision: null, policy: { ...policy, visibility: "followers" } }, { policy }]) assert.equal((await patch(owner, invalid)).status, 400, JSON.stringify(invalid));
  const saved = await (await patch(owner, { revision: null, policy })).json();
  assert.deepEqual(saved.policy, { ...policy, testMaxPerDay: 10, alertThreshold: 0.85, nightThreshold: 0.45, autoPublish: false, visibility: "private", maxImmediatePerDay: 1 }, "defaults: autonomous mode off, private");
  assert.equal((await patch(owner, { revision: saved.revision, policy: { ...policy, alertThreshold: 0.5, nightThreshold: 0.6 } })).status, 400, "night threshold must stay below the alert threshold");
  assert.equal((await patch(owner, { revision: null, policy })).status, 409);
  assert.deepEqual(await (await read(owner, `/api/xiagents/${agent.id}/watch`)).json(), saved);
  // Public automatic publication: a separate, server-recorded confirmation.
  const autonomous = { ...policy, autoPublish: true, visibility: "public" };
  assert.equal((await patch(owner, { revision: saved.revision, policy: autonomous })).status, 400);
  assert.equal((await patch(owner, { revision: saved.revision, policy: autonomous, confirmPublic: false })).status, 400);
  assert.equal((await patch(owner, { revision: saved.revision, policy: autonomous, publicConfirmedAt: "2026-01-01T00:00:00.000Z" })).status, 400, "never supplied by the client");
  const publicPolicy = await (await patch(owner, { revision: saved.revision, policy: autonomous, confirmPublic: true })).json();
  assert.ok(publicPolicy.publicConfirmedAt);
  const privatePolicy = await (await patch(owner, { revision: publicPolicy.revision, policy: { ...autonomous, visibility: "private", autoPublish: false } })).json();
  assert.equal(privatePolicy.publicConfirmedAt, null);

  // Sources: proposals are fetched by the server through the SSRF guard; decisions are owner-only.
  const postJson = (cookie: string, target: string, data: unknown, origin = app.origin) => fetch(app.origin + target, { method: "POST", headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(data) });
  for (const url of ["http://127.0.0.1/rss", "http://169.254.169.254/latest/meta-data", `http://localhost:${new URL(app.origin).port}/api/accounts`, "file:///etc/passwd"]) {
    const response = await postJson(owner, `/api/xiagents/${agent.id}/sources`, { url });
    assert.equal(response.status, 422, url);
    assert.match((await response.json()).error, /Source inaccessible/);
  }
  assert.equal((await postJson(other, `/api/xiagents/${agent.id}/sources`, { url: "https://example.org/" })).status, 404);
  assert.equal((await postJson(owner, `/api/xiagents/${agent.id}/sources`, { url: "https://example.org/" }, "https://foreign.example")).status, 403);
  assert.equal((await postJson(owner, `/api/xiagents/${agent.id}/sources`, { url: "https://example.org/", extra: 1 })).status, 400);
  // A proposal written by the worker in the vault (here: directly, the server cannot reach a local fixture).
  const db = new Database(app.databasePath); db.pragma("busy_timeout = 5000");
  try {
    const vault = await openVault(app.vaultPath);
    const store = createSourceStore({ vault, topics: createTopicStore({ vault, db }) });
    const ownerId = (await (await read(owner, "/api/auth/get-session")).json()).user.id;
    const { source } = await store.propose(ownerId, { url: "https://feeds.example/rss", kind: "feed", site: null, publisher: "Le Quotidien", topicIds: [topic.topicId], reliability: { level: "inconnue", reasons: [], estimated: true } }, `agent:${agent.id}`);
    const decide = (cookie: string, data: unknown, origin?: string) => postJson(cookie, `/api/watch/sources/${source.id}`, data, origin);
    assert.equal((await decide(other, { action: "approve", revision: source.revision })).status, 404);
    assert.equal((await decide(owner, { action: "approve", revision: source.revision }, "https://foreign.example")).status, 403);
    assert.equal((await decide(owner, { action: "disable", revision: source.revision })).status, 409);
    assert.equal((await decide(owner, { action: "approve", revision: source.revision, edits: { topicIds: [randomUUID()] } })).status, 400);
    const approved = await (await decide(owner, { action: "approve", revision: source.revision, note: "Vérifiée", edits: { orientation: "Non déclarée" } })).json();
    assert.deepEqual([approved.status, approved.orientation, approved.history.at(-1).action], ["approved", "Non déclarée", "approved"]);
    assert.equal((await decide(owner, { action: "reject", revision: source.revision })).status, 409, "stale revision");
    const page = await (await read(owner, path)).text();
    for (const text of ["Veille autonome", "Paramètres de veille et de fréquence", "Le Quotidien", "Actives (1)", "Publication automatique", "Candidats éditoriaux", "Inférence locale", "non configurée", "Aucun service d’IA distant", "Mode autonome", "non autorisée (XI_WATCH_AUTOPUBLISH)", "Plafond d’alertes immédiates", "Journal des décisions de publication", "aucun passage enregistré"]) assert.ok(page.includes(text), text);
    assert.ok(!(await (await read(other, path)).text()).includes("Le Quotidien"));

    // A watch draft (written here as the worker would): private, reviewed by the owner only.
    const draftId = randomUUID();
    await createPublicationStore({ vault, db }).saveWatchDraft(ownerId, agent.id, {
      id: draftId, summary: "Le Parlement adopte la réforme.", topicIds: [topic.topicId],
      messages: [{ body: "Le Parlement a adopté jeudi la réforme des retraites.", sources: [0] }],
      sources: [{ url: "https://quotidien.example/a/1", title: "Le Parlement adopte la réforme", publisher: "Le Quotidien", accessedAt: "2026-01-15", facts: ["Le Parlement a adopté jeudi la réforme des retraites"], reservations: ["Seul le résumé publié dans le flux a été consulté."] }],
      watch: { story: "fictive" },
    });
    migrateWatchCandidates(db);
    db.prepare("INSERT INTO watch_candidate (agent_id, story_id, owner, story_version, status, stage, data, prompt_version, created_at, updated_at) VALUES (?, ?, ?, 1, 'drafted', 'done', ?, 'veille-3.1', 0, 0)").run(agent.id, randomUUID(), ownerId, JSON.stringify({ title: "Réforme des retraites", draft: { id: draftId } }));
    for (let i = 0; i < 50 && (await read(owner, `/api/publications/${draftId}`)).status !== 200; i++) await new Promise(resolve => setTimeout(resolve, 100));
    const stored = (await (await read(owner, `/api/publications/${draftId}`)).json()).publication;
    assert.deepEqual([stored.status, stored.visibility, stored.authorType], ["draft", "private", "ai"]);
    assert.equal((await read(other, `/api/publications/${draftId}`)).status, 404);
    const draftPage = await (await read(owner, path)).text();
    for (const text of ["Brouillons", "Brouillon réel non publié", "Le Parlement a adopté jeudi la réforme des retraites", "Approuver (publication privée)"]) assert.ok(draftPage.includes(text), text);
    const reviewPath = `/api/xiagents/${agent.id}/drafts/${draftId}`;
    assert.equal((await postJson(other, reviewPath, { action: "approve", revision: stored.revision })).status, 404);
    assert.equal((await postJson(owner, `/api/xiagents/${agent.id}/drafts/${randomUUID()}`, { action: "approve", revision: stored.revision })).status, 404);
    assert.equal((await postJson(owner, reviewPath, { action: "approve", revision: stored.revision }, "https://foreign.example")).status, 403);
    assert.equal((await postJson(owner, reviewPath, { action: "publish-public", revision: stored.revision })).status, 400);
    assert.equal((await postJson(owner, reviewPath, { action: "update", revision: stored.revision, messages: ["Le Parlement a adopté la réforme par 300 voix."] })).status, 400);
    assert.equal((await postJson(owner, reviewPath, { action: "approve", revision: "stale" })).status, 409);
    const published = await (await postJson(owner, reviewPath, { action: "approve", revision: stored.revision })).json();
    assert.deepEqual([published.status, published.visibility], ["published", "private"]);
    assert.equal((await read(other, `/api/publications/${draftId}`)).status, 404, "approval never makes it public");
  } finally { db.close(); }
});
