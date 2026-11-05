import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createTestServer } from "./helpers/next-server";
import { SYSTEM_AGENTS } from "../src/lib/system-agents/registry";

type Agent = { kind: string; id: string; handle: string; enabled: boolean; revision: string };

test("system agents over HTTP: session, instance owner, 404, 409, validation, tasks, categories and pins", { timeout: 90_000 }, async t => {
  const app = await createTestServer(); t.after(() => app.dispose());
  await app.migrate(); await app.start();
  const signup = async (name: string) => {
    const response = await fetch(`${app.origin}/api/auth/sign-up/email`, { method: "POST", headers: { Origin: app.origin, "Content-Type": "application/json" }, body: JSON.stringify({ name, email: `${name}@system.test`, password: "test system password" }) });
    assert.equal(response.status, 200);
    return response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
  };
  const get = (path: string, cookie?: string) => fetch(app.origin + path, { headers: cookie ? { Cookie: cookie } : {} });
  const send = (method: string, path: string, cookie: string | null, data: unknown, origin = app.origin) =>
    fetch(app.origin + path, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), Origin: origin, "Content-Type": "application/json" }, body: typeof data === "string" ? data : JSON.stringify(data) });

  // Without a session, nothing is readable or writable.
  for (const path of ["/api/system-agents", "/api/system-agents/konstruktor", "/api/xiagents?category=system"]) assert.equal((await get(path)).status, 401, path);
  assert.equal((await send("PATCH", "/api/system-agents/konstruktor", null, { revision: randomUUID(), enabled: false })).status, 401);

  // The first account becomes the instance owner, recorded at its first use: a later account never is.
  const owner = await signup("owner");
  const first = await (await get("/api/system-agents", owner)).json();
  assert.equal(first.canConfigure, true);
  assert.equal(first.owner, "ok");
  assert.ok(!JSON.stringify(first).includes('"ownerId"'), "the owner's identifier is never exposed");
  const other = await signup("other");
  const seen = await (await get("/api/system-agents", other)).json();
  assert.equal(seen.canConfigure, false);
  assert.deepEqual(seen.agents.map((agent: Agent) => agent.handle), SYSTEM_AGENTS.map(agent => agent.handle), "listed for every user");

  // Reads: one entry per kind, however many reads; unknown kinds are 404.
  for (let i = 0; i < 3; i++) assert.equal((await (await get("/api/system-agents", i % 2 ? owner : other)).json()).agents.length, SYSTEM_AGENTS.length);
  const konstruktor = (await (await get("/api/system-agents/konstruktor", other)).json()).agent as Agent;
  assert.equal(konstruktor.handle, "konstruktor");
  for (const kind of ["inconnu", "KONSTRUKTOR", "..%2Fkonstruktor"]) assert.equal((await get(`/api/system-agents/${kind}`, owner)).status, 404, kind);

  // Configuration: Origin checked, instance owner only (others see 404, like a foreign resource).
  const path = "/api/system-agents/konstruktor";
  assert.equal((await send("PATCH", path, owner, { revision: konstruktor.revision, enabled: false }, "https://evil.test")).status, 403);
  assert.equal((await send("PATCH", path, other, { revision: konstruktor.revision, enabled: false })).status, 404);
  assert.equal((await send("PATCH", "/api/system-agents/inconnu", owner, { revision: konstruktor.revision, enabled: false })).status, 404);
  for (const invalid of [
    { revision: konstruktor.revision }, { revision: "pas-un-uuid", enabled: false }, { revision: konstruktor.revision, enabled: "false" },
    { revision: konstruktor.revision, enabled: false, handle: "autre" }, { revision: konstruktor.revision, bloub: { version: 1, shape: "carré", expression: "neutre", color: "encre" } },
    "{not json",
  ]) assert.equal((await send("PATCH", path, owner, invalid)).status, 400, JSON.stringify(invalid));
  assert.equal((await send("PATCH", path, owner, { revision: konstruktor.revision, enabled: false, padding: "x".repeat(5_000) })).status, 413);
  assert.equal((await send("PATCH", path, owner, { revision: randomUUID(), enabled: false })).status, 409);

  const updated = await send("PATCH", path, owner, { revision: konstruktor.revision, enabled: false });
  assert.equal(updated.status, 200);
  const disabled = (await updated.json()).agent as Agent;
  assert.equal(disabled.enabled, false);
  assert.equal((await send("PATCH", path, owner, { revision: konstruktor.revision, enabled: true })).status, 409, "a stale revision is refused");

  // Categories: system agents as summaries for every user; their real activity follows activation.
  const system = await (await get("/api/xiagents?category=system", other)).json();
  assert.equal(system.category, "system");
  assert.deepEqual(system.agents.map((agent: { handle: string; category: string }) => `${agent.category}:${agent.handle}`), SYSTEM_AGENTS.map(agent => `system:${agent.handle}`));
  assert.equal(system.agents.find((agent: { handle: string }) => agent.handle === "konstruktor").bloub.activity, "unavailable");
  assert.equal(system.agents.find((agent: { handle: string }) => agent.handle === "arbitre").bloub.activity, "idle");
  assert.deepEqual((await (await get("/api/xiagents", owner)).json()).agents, [], "editorial by default: the owner's own agents only");
  assert.equal((await get("/api/xiagents?category=autre", owner)).status, 400);

  // Pins: any user pins a system agent for themselves only; malformed bodies are refused.
  const arbitre = SYSTEM_AGENTS.find(agent => agent.handle === "arbitre")!;
  const pinned = await send("PUT", `/api/xiagents/${arbitre.id}/pin`, other, { pinned: true });
  assert.equal(pinned.status, 200);
  assert.ok((await pinned.json()).agents.find((agent: { id: string }) => agent.id === arbitre.id).pinnedAt > 0);
  assert.equal((await (await get("/api/xiagents?category=system", owner)).json()).agents.find((agent: { id: string }) => agent.id === arbitre.id).pinnedAt, null, "pins are per user");
  assert.equal((await send("PUT", `/api/xiagents/${arbitre.id}/pin`, other, { pinned: "yes" })).status, 400);
  assert.equal((await send("PUT", `/api/xiagents/${randomUUID()}/pin`, other, { pinned: true })).status, 404);

  // Tasks: queued and started by the web server itself (no worker runs here); private to the requester.
  const tasks = "/api/system-agents/priority-arbiter/tasks";
  const task = { requestId: randomUUID(), task: "probe-model" };
  assert.equal((await send("POST", tasks, null, task)).status, 401);
  assert.equal((await send("POST", tasks, other, task, "https://evil.test")).status, 403);
  assert.equal((await send("POST", "/api/system-agents/inconnu/tasks", other, task)).status, 404);
  assert.equal((await send("POST", "/api/system-agents/konstruktor/tasks", other, task)).status, 409, "disabled agent");
  for (const invalid of [{ task: "probe-model" }, { ...task, task: "converse" }, { ...task, input: { prompt: "x" } }, "{not json"]) assert.equal((await send("POST", tasks, other, invalid)).status, 400, JSON.stringify(invalid));
  assert.equal((await send("POST", tasks, other, { ...task, padding: "x".repeat(20_000) })).status, 413);
  const queued = await send("POST", tasks, other, task);
  assert.equal(queued.status, 200);
  assert.equal((await queued.json()).created, true);
  assert.equal((await (await send("POST", tasks, other, task)).json()).created, false, "idempotent on requestId");
  let view: { state: string; message: string | null; runs: { status: string }[] } = { state: "pending", message: null, runs: [] };
  for (let i = 0; i < 50 && (view.state === "pending" || view.state === "running"); i++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    view = (await (await get(`${tasks}/${task.requestId}`, other)).json()).request;
  }
  // No local model configured in this server: an explicit failure, never a cloud fallback.
  assert.equal(view.state, "failed");
  assert.match(view.message!, /Aucune instance IA/);
  assert.deepEqual(view.runs.map(run => run.status), ["failed"]);
  assert.equal((await get(`${tasks}/${task.requestId}`, owner)).status, 404, "another user's request is unknown");
  assert.deepEqual((await (await get(tasks, owner)).json()).requests, []);
  assert.equal((await (await get(tasks, other)).json()).requests.length, 1);
  assert.equal((await get(`${tasks}/${task.requestId}`)).status, 401);

  // Pages: the category is carried by the URL; an unknown one is 404.
  const page = await get("/dashboard/xiagents?category=system", other);
  assert.equal(page.status, 200, app.output());
  const html = await page.text();
  for (const text of ["Agents systèmes", "@konstruktor", "@arbitre", 'id="agent-konstruktor"', "Désactivé"]) assert.ok(html.includes(text), text);
  const editorialPage = await (await get("/dashboard/xiagents", owner)).text();
  assert.ok(editorialPage.includes("Agents éditoriaux") && !editorialPage.includes('id="agent-konstruktor"'));
  assert.equal((await get("/dashboard/xiagents?category=autre", owner)).status, 404);

  // A restart keeps the configuration and the recorded owner, without duplicating anything.
  await app.stop(); await app.start();
  const after = await (await get("/api/system-agents", owner)).json();
  assert.equal(after.canConfigure, true);
  assert.equal(after.agents.length, SYSTEM_AGENTS.length);
  assert.equal(after.agents.find((agent: Agent) => agent.kind === "konstruktor").revision, disabled.revision);
});
