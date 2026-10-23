import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createTestServer } from "./helpers/next-server";

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
});
