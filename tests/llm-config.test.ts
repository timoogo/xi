import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import Database from "better-sqlite3";
import { createAccountStore } from "../src/lib/accounts/store";
import { BUILTIN_PRESETS } from "../src/lib/accounts/types";
import { DEFAULT_BLOUB_CONFIG } from "../src/lib/bloub/config";
import { resolveLLM } from "../src/lib/llm/resolve";
import { createLLMRuntime, deleteInstance, instanceDependencies } from "../src/lib/llm/server";
import { createLLMStore, LLMStoreError } from "../src/lib/llm/store";
import type { AgentLLMSettings, InstanceInput } from "../src/lib/llm/types";
import { openVault } from "../src/lib/publications/vault";
import { createTopicStore } from "../src/lib/topics/store";

const policy = { allow: [], hosts: null };
const input = (extra: Partial<InstanceInput> = {}): InstanceInput => ({ type: "ollama", name: "Ollama — Pi", key: "pi", baseUrl: "http://127.0.0.1:11434", enabled: true, defaultModel: "qwen3:1.7b", options: {}, ...extra });
const agent = (config: Partial<AgentLLMSettings["config"]> = {}, extra: Partial<AgentLLMSettings> = {}): AgentLLMSettings => ({ config: { instanceId: null, model: null, options: {}, ...config }, revision: null, valid: true, legacy: false, ...extra });
const status = (error: unknown) => (error as LLMStoreError).status;

/** Simulated Ollama: version, tags and chat; `chat` decides the reply. */
async function ollama(t: TestContext, chat: (body: Record<string, unknown>, res: http.ServerResponse) => void = (_, res) => res.end(JSON.stringify({ message: { content: '{"ok": true}' }, done_reason: "stop" }))) {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", chunk => { raw += chunk; });
    req.on("end", () => {
      requests.push(`${req.method} ${req.url}`);
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/api/version") return res.end(JSON.stringify({ version: "0.12.0" }));
      if (req.url === "/api/tags") return res.end(JSON.stringify({ models: [{ name: "qwen3:1.7b", size: 1_400_000_000, modified_at: "2026-10-01T00:00:00Z", details: { family: "qwen3", parameter_size: "2.0B", quantization_level: "Q4_K_M" } }] }));
      if (req.url === "/api/chat") return chat(JSON.parse(raw), res);
      res.statusCode = 404; res.end("{}");
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, requests };
}

async function accountsFixture(t: TestContext, db: Database.Database) {
  const root = await mkdtemp(join(tmpdir(), "xi-llm-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vault = await openVault(root);
  const topics = createTopicStore({ vault, db });
  const accounts = createAccountStore({ vault, db, topics });
  const topic = (await topics.create("alice", randomUUID(), { tag: "climat", name: "Climat", description: "", scope: "Climat", parentId: null, relatedIds: [] })).topic;
  const create = async (handle: string, owner = "alice", modelRef: string | null = null, llm?: AgentLLMSettings["config"]) => {
    const id = randomUUID();
    const preset = BUILTIN_PRESETS[0];
    await accounts.createAgent(owner, id, { draft: { handle, name: handle, description: "", primaryTopicId: topic.id, secondaryTopicIds: [], presetId: preset.id, presetVersion: preset.version, settings: preset.settings, active: true, modelRef, validationMode: "human" }, profile: { perimeter: "", charter: "" }, bloub: DEFAULT_BLOUB_CONFIG, ...(llm ? { llm } : {}) });
    return id;
  };
  return { accounts, create };
}

test("instances: create, edit with revision, disable, delete, unique key, URL policy", () => {
  const db = new Database(":memory:");
  const store = createLLMStore(db, { policy });
  const created = store.create("alice", input());
  assert.equal(created.baseUrl, "http://127.0.0.1:11434/");
  assert.deepEqual(created.status, { state: "unknown" });
  assert.throws(() => store.create("alice", input({ name: "Autre" })), error => status(error) === 409);
  // Another owner may reuse the same key.
  assert.equal(store.create("bob", input()).key, "pi");

  const edited = store.update("alice", created.id, { ...input({ name: "Pi salon", defaultModel: "qwen3:8b", options: { temperature: 0.2 } }), revision: created.revision });
  assert.equal(edited.name, "Pi salon"); assert.equal(edited.defaultModel, "qwen3:8b"); assert.deepEqual(edited.options, { temperature: 0.2 });
  assert.throws(() => store.update("alice", created.id, { ...input(), revision: created.revision }), error => status(error) === 409);
  const disabled = store.update("alice", created.id, { ...input({ enabled: false }), revision: edited.revision });
  assert.equal(disabled.enabled, false);

  // A new URL resets status and models.
  store.recordCheck("alice", created.id, { state: "ok", checkedAt: new Date().toISOString(), version: "1", latencyMs: 3 }, []);
  const moved = store.update("alice", created.id, { ...input({ baseUrl: "http://192.168.1.188:11434" }), revision: disabled.revision });
  assert.deepEqual(moved.status, { state: "unknown" }); assert.equal(moved.models, null);

  // URL policy: public addresses, link-local, credentials and other protocols are refused.
  for (const baseUrl of ["http://8.8.8.8:11434", "http://169.254.169.254/", "http://user:pw@127.0.0.1:11434", "ftp://127.0.0.1/", "pas une url"]) {
    assert.throws(() => store.create("alice", input({ key: `k${Math.random().toString(36).slice(2, 8)}`, baseUrl })), /refusée|invalide|uniquement|sans identifiants/, baseUrl);
  }
  assert.throws(() => store.create("alice", input({ key: "Majuscules" })));
  store.remove("alice", created.id);
  assert.equal(store.get("alice", created.id), null);
});

test("instances: owners are isolated", () => {
  const db = new Database(":memory:");
  const store = createLLMStore(db, { policy });
  const mine = store.create("alice", input());
  assert.equal(store.get("bob", mine.id), null);
  assert.deepEqual(store.list("bob"), []);
  assert.equal(store.byKey("bob", "pi"), null);
  assert.throws(() => store.update("bob", mine.id, { ...input(), revision: mine.revision }), error => status(error) === 404);
  assert.throws(() => store.remove("bob", mine.id), error => status(error) === 404);
  assert.throws(() => store.setDefault("bob", { revision: null, defaultInstanceId: mine.id }), error => status(error) === 404);
  assert.throws(() => store.recordCheck("bob", mine.id, { state: "unknown" }), error => status(error) === 404);
  assert.equal(store.get("alice", "not-a-uuid"), null);
});

test("instances and default persist across reopenings", async t => {
  const dir = await mkdtemp(join(tmpdir(), "xi-llm-db-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "app.sqlite");
  let db = new Database(path);
  const store = createLLMStore(db, { policy });
  const created = store.create("alice", input({ options: { timeoutMs: 60_000 } }));
  const settings = store.setDefault("alice", { revision: null, defaultInstanceId: created.id });
  assert.throws(() => store.setDefault("alice", { revision: null, defaultInstanceId: null }), error => status(error) === 409);
  db.close();
  db = new Database(path);
  t.after(() => db.close());
  const reopened = createLLMStore(db, { policy });
  assert.deepEqual(reopened.get("alice", created.id)?.options, { timeoutMs: 60_000 });
  assert.deepEqual(reopened.settings("alice"), settings);
  assert.equal(reopened.byKey("alice", "pi")?.id, created.id);
});

test("resolution: agent, global, environment, problems and merged options", () => {
  const db = new Database(":memory:");
  const store = createLLMStore(db, { policy });
  const env = { url: "http://127.0.0.1:11434", api: "ollama" as const, defaultModel: "env-model", timeoutMs: 90_000 };
  const resolve = (settings: AgentLLMSettings | null, environment: typeof env | null = null, owner = "alice") => resolveLLM({ store, owner, agent: settings, environment });

  assert.equal((resolve(agent()) as { code: string }).code, "not-configured");
  // Environment server only when no default instance is chosen.
  const fromEnv = resolve(agent(), env);
  assert.ok(fromEnv.ok);
  assert.equal(fromEnv.value.instanceSource, "environment"); assert.equal(fromEnv.value.model, "env-model"); assert.equal(fromEnv.value.options.timeoutMs, 90_000);

  const pi = store.create("alice", input({ options: { temperature: 0.1, maxTokens: 1_000 } }));
  const mac = store.create("alice", input({ key: "mac", name: "Mac mini", baseUrl: "http://127.0.0.2:11434", defaultModel: null }));
  store.setDefault("alice", { revision: null, defaultInstanceId: pi.id });

  const inherited = resolve(agent(), env);
  assert.ok(inherited.ok);
  assert.equal(inherited.value.instanceSource, "global"); assert.equal(inherited.value.instance.id, pi.id); assert.equal(inherited.value.model, "qwen3:1.7b"); assert.equal(inherited.value.modelSource, "instance");
  assert.deepEqual(inherited.value.options, { temperature: 0.1, maxTokens: 1_000, contextSize: null, timeoutMs: 180_000 });

  const model = resolve(agent({ model: "qwen3:8b", options: { temperature: 0.3, contextSize: 8_192 } }));
  assert.ok(model.ok);
  assert.equal(model.value.instance.id, pi.id); assert.equal(model.value.model, "qwen3:8b"); assert.equal(model.value.modelSource, "agent");
  assert.deepEqual(model.value.options, { temperature: 0.3, maxTokens: 1_000, contextSize: 8_192, timeoutMs: 180_000 });

  // Other instance without a model: no arbitrary model is picked.
  assert.equal((resolve(agent({ instanceId: mac.id })) as { code: string }).code, "no-model");
  const other = resolve(agent({ instanceId: mac.id, model: "llama3.1:70b" }));
  assert.ok(other.ok);
  assert.equal(other.value.instanceSource, "agent"); assert.equal(other.value.instance.name, "Mac mini");

  // Legacy modelRef acts as a model override on the global instance.
  const legacy = resolve(agent({ model: "ancien" }, { legacy: true }));
  assert.ok(legacy.ok && legacy.value.model === "ancien" && legacy.value.instance.id === pi.id);

  assert.equal((resolve(agent({}, { valid: false })) as { code: string }).code, "invalid-config");
  // Disabled or deleted: a problem, never a fallback (environment configured or not).
  store.update("alice", mac.id, { ...input({ key: "mac", name: "Mac mini", baseUrl: "http://127.0.0.2:11434", defaultModel: null, enabled: false }), revision: mac.revision });
  assert.equal((resolve(agent({ instanceId: mac.id, model: "x" }), env) as { code: string }).code, "instance-disabled");
  store.remove("alice", mac.id);
  assert.equal((resolve(agent({ instanceId: mac.id, model: "x" }), env) as { code: string }).code, "instance-missing");
  store.remove("alice", pi.id);
  assert.equal((resolve(agent(), env) as { code: string }).code, "instance-missing");
  // Another owner's instance is never resolved.
  const bobs = store.create("bob", input());
  assert.equal((resolve(agent({ instanceId: bobs.id, model: "x" })) as { code: string }).code, "instance-missing");
});

test("agents: llm key with revision, legacy modelRef, dependencies and reassignment on deletion", async t => {
  const db = new Database(":memory:");
  t.after(() => db.close());
  const { accounts, create } = await accountsFixture(t, db);
  const runtime = createLLMRuntime({ db, env: {} });
  const pi = runtime.store.create("alice", input());
  const mac = runtime.store.create("alice", input({ key: "mac", name: "Mac mini", baseUrl: "http://127.0.0.2:11434" }));
  runtime.store.setDefault("alice", { revision: null, defaultInstanceId: pi.id });

  const inheriting = await create("heritier");
  const legacy = await create("ancien", "alice", "qwen3:8b");
  const explicit = await create("explicite");
  const bobAgent = await create("bob-agent", "bob");

  assert.deepEqual(await accounts.llm("alice", inheriting), { config: { instanceId: null, model: null, options: {} }, revision: null, valid: true, legacy: false });
  assert.deepEqual((await accounts.llm("alice", legacy)).config.model, "qwen3:8b");
  assert.equal((await accounts.llm("alice", legacy)).legacy, true);
  await assert.rejects(accounts.llm("bob", inheriting), /introuvable/);

  const saved = await accounts.setLLM("alice", explicit, { revision: null, config: { instanceId: mac.id, model: "llama3.1:8b", options: { temperature: 0.2 } } });
  assert.ok(saved.revision);
  await assert.rejects(accounts.setLLM("alice", explicit, { revision: null, config: { instanceId: null, model: null, options: {} } }), /modifiée/);
  await assert.rejects(accounts.setLLM("bob", explicit, { revision: saved.revision, config: { instanceId: null, model: null, options: {} } }), /introuvable/);
  const watched = (await accounts.watchAgents()).find(item => item.id === explicit)!;
  assert.equal(watched.llm?.config.instanceId, mac.id);
  const resolved = runtime.resolve("alice", watched.llm!);
  assert.ok(resolved.ok && resolved.value.instance.id === mac.id && resolved.value.model === "llama3.1:8b");

  // Dependencies: explicit agent of mac; inheriting (and legacy) agents of the default instance.
  assert.deepEqual((await instanceDependencies(runtime, accounts, "alice", mac.id)).agents.map(agent => [agent.id, agent.reason]), [[explicit, "explicit"]]);
  const piDeps = await instanceDependencies(runtime, accounts, "alice", pi.id);
  assert.equal(piDeps.isDefault, true);
  assert.deepEqual(piDeps.agents.map(agent => agent.id).sort(), [inheriting, legacy].sort());
  await assert.rejects(instanceDependencies(runtime, accounts, "bob", mac.id), error => status(error) === 404);

  // No explicit decision: refused with the dependencies.
  await assert.rejects(deleteInstance(runtime, accounts, "alice", mac.id, { confirm: true }), error => status(error) === 409 && (error as LLMStoreError).data.dependencies !== undefined);
  await assert.rejects(deleteInstance(runtime, accounts, "alice", mac.id, { confirm: true, reassignTo: mac.id }), /autre instance/);
  await assert.rejects(deleteInstance(runtime, accounts, "bob", mac.id, { confirm: true, reassignTo: "global" }), error => status(error) === 404);
  // Back to the global configuration: model dropped, options kept.
  const removed = await deleteInstance(runtime, accounts, "alice", mac.id, { confirm: true, reassignTo: "global" });
  assert.deepEqual(removed.reassigned, [explicit]);
  assert.deepEqual((await accounts.llm("alice", explicit)).config, { instanceId: null, model: null, options: { temperature: 0.2 } });

  // Deleting the default instance moves the default to the chosen replacement.
  const nas = runtime.store.create("alice", input({ key: "nas", name: "NAS", baseUrl: "http://127.0.0.3:11434" }));
  await accounts.setLLM("alice", inheriting, { revision: null, config: { instanceId: pi.id, model: null, options: {} } });
  const moved = await deleteInstance(runtime, accounts, "alice", pi.id, { confirm: true, reassignTo: nas.id });
  assert.deepEqual(moved.reassigned, [inheriting]);
  assert.equal(moved.defaultInstanceId, nas.id);
  assert.equal((await accounts.llm("alice", inheriting)).config.instanceId, nas.id);

  // "none": references stay dangling and show a configuration problem; the default is cleared.
  await accounts.setLLM("alice", explicit, { revision: (await accounts.llm("alice", explicit)).revision, config: { instanceId: nas.id, model: null, options: {} } });
  const kept = await deleteInstance(runtime, accounts, "alice", nas.id, { confirm: true, reassignTo: "none" });
  assert.deepEqual(kept.reassigned, []); assert.equal(kept.defaultInstanceId, null); assert.ok(kept.notice);
  const problem = runtime.resolve("alice", await accounts.llm("alice", explicit));
  assert.equal(!problem.ok && problem.code, "instance-missing");
  // Bob's agent never moved.
  assert.deepEqual((await accounts.llm("bob", bobAgent)).config, { instanceId: null, model: null, options: {} });
});

test("createAgent writes an initial llm selection", async t => {
  const db = new Database(":memory:");
  t.after(() => db.close());
  const { accounts, create } = await accountsFixture(t, db);
  const id = await create("avec-llm", "alice", null, { instanceId: null, model: "qwen3:8b", options: { maxTokens: 512 } });
  const settings = await accounts.llm("alice", id);
  assert.deepEqual(settings.config, { instanceId: null, model: "qwen3:8b", options: { maxTokens: 512 } });
  assert.ok(settings.revision);
  assert.equal(settings.legacy, false);
});

test("runtime: check records version and models, failures are explicit, tests use the resolved options and are rate-limited", async t => {
  const db = new Database(":memory:");
  const sent: { num_predict: number; temperature: number; think: unknown }[] = [];
  const server = await ollama(t, (body, res) => {
    if (body.model === "absent") { res.statusCode = 404; return res.end(JSON.stringify({ error: `model "absent" not found, try pulling it first` })); }
    sent.push({ ...(body.options as { num_predict: number; temperature: number }), think: body.think });
    res.end(JSON.stringify({ message: { content: '{"ok": true}' }, done_reason: "stop" }));
  });
  let clock = new Date("2026-10-25T10:00:00Z");
  const runtime = createLLMRuntime({ db, env: {}, now: () => clock });
  const instance = runtime.store.create("alice", input({ baseUrl: server.url, options: { maxTokens: 1_024, temperature: 0.1 } }));

  const checked = await runtime.check("alice", instance.id);
  assert.equal(checked.status.state, "ok");
  assert.equal(checked.status.state === "ok" && checked.status.version, "0.12.0");
  assert.deepEqual(checked.models?.map(model => [model.name, model.family, model.parameterSize, model.quantization, model.contextLength]), [["qwen3:1.7b", "qwen3", "2.0B", "Q4_K_M", null]]);
  assert.equal(checked.revision, instance.revision);
  // Connectivity and discovery only: no inference, no pull.
  assert.deepEqual(server.requests, ["GET /api/version", "GET /api/tags"]);
  await assert.rejects(runtime.check("bob", instance.id), error => status(error) === 404);

  runtime.store.setDefault("alice", { revision: null, defaultInstanceId: instance.id });
  const ok = await runtime.testModel("alice", agent());
  assert.ok(ok.ok); assert.equal(ok.model, "qwen3:1.7b"); assert.equal(ok.instance, "Ollama — Pi"); assert.ok(ok.latencyMs >= 0);
  // The test sends the options the agent's runs use (account, then agent), never a limit of its own.
  const overridden = await runtime.testModel("alice", agent({ options: { maxTokens: 4_096 } }));
  assert.ok(overridden.ok);
  assert.deepEqual(sent.map(options => [options.num_predict, options.temperature, options.think]), [[1_024, 0.1, false], [4_096, 0.1, false]]);
  const missing = await runtime.testModel("alice", null, "absent", instance.id);
  assert.equal(!missing.ok && missing.code, "model-missing");
  const unresolved = await runtime.testModel("bob", agent());
  assert.equal(!unresolved.ok && unresolved.code, "not-configured");

  // Refused connection: recorded on the instance, never thrown.
  const dead = runtime.store.create("alice", input({ key: "dead", baseUrl: "http://127.0.0.1:9" }));
  const failed = await runtime.check("alice", dead.id);
  assert.equal(failed.status.state, "error");
  assert.equal(failed.status.state === "error" && failed.status.code, "unreachable");

  // 12 checks and tests per owner per 10 minutes (5 used so far by alice).
  for (let i = 0; i < 7; i++) await runtime.check("alice", instance.id);
  await assert.rejects(runtime.check("alice", instance.id), error => status(error) === 429);
  await assert.rejects(runtime.testModel("alice", agent()), error => status(error) === 429);
  // Bob is not affected; the window slides.
  const bobInstance = runtime.store.create("bob", input({ baseUrl: server.url }));
  assert.equal((await runtime.check("bob", bobInstance.id)).status.state, "ok");
  clock = new Date(clock.getTime() + 11 * 60_000);
  assert.equal((await runtime.check("alice", instance.id)).status.state, "ok");
});

test("runtime: environment server stays the installation default and never exposes its URL", () => {
  const db = new Database(":memory:");
  const runtime = createLLMRuntime({ db, env: { XI_INFERENCE_URL: "http://127.0.0.1:11434", XI_INFERENCE_MODEL: "env-model" } });
  assert.deepEqual(runtime.environment(), { configured: true, api: "ollama", defaultModel: "env-model", error: null });
  assert.ok(!JSON.stringify(runtime.environment()).includes("127.0.0.1"));
  const bound = runtime.bind("alice", agent());
  assert.ok(bound.ok && bound.resolved.instanceSource === "environment");
  const refused = createLLMRuntime({ db, env: { XI_INFERENCE_URL: "http://8.8.8.8:11434" } });
  assert.equal(refused.environment().configured, false);
  assert.ok(refused.environment().error);
  assert.equal(!refused.resolve("alice", agent()).ok && (refused.resolve("alice", agent()) as { code: string }).code, "not-configured");
});
