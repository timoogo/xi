import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { createAccountStore } from "../src/lib/accounts/store";
import { DEFAULT_WATCH_POLICY, type WatchAgent } from "../src/lib/accounts/types";
import { createLLMRuntime } from "../src/lib/llm/server";
import type { AgentLLMConfig } from "../src/lib/llm/types";
import { createPublicationStore } from "../src/lib/publications/store";
import { openVault } from "../src/lib/publications/vault";
import { createTopicStore } from "../src/lib/topics/store";
import { draftHandler, draftId } from "../src/lib/watch/drafting";
import { evaluateHandler, migrateWatchCandidates } from "../src/lib/watch/evaluate";
import { createJobQueue, type Job } from "../src/lib/watch/jobs";
import { agentLLMSettings, bindSafely } from "../src/lib/watch/llm-binding";
import { createSourceStore } from "../src/lib/watch/sources";
import { recordEntries } from "../src/lib/watch/stories";
import { drainJobs } from "../src/lib/watch/worker";

/**
 * End to end through the real runtime (store → resolution → Ollama client) against simulated
 * Ollama servers: each agent's analysis and writing reach its own instance, model and options.
 */
type Chat = { model: string; options: Record<string, unknown>; prompt: string };
async function ollama(t: test.TestContext, reply: (chat: Chat) => { status?: number; body: unknown }) {
  const chats: Chat[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", chunk => { raw += chunk; });
    req.on("end", () => {
      if (req.url !== "/api/chat") { res.writeHead(404).end(); return; }
      const body = JSON.parse(raw) as { model: string; options: Record<string, unknown>; messages: { role: string; content: string }[] };
      const chat = { model: body.model, options: body.options, prompt: body.messages.at(-1)!.content };
      chats.push(chat);
      const answer = reply(chat);
      res.writeHead(answer.status ?? 200, { "Content-Type": "application/json" }).end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, chats };
}
const content = (value: unknown) => ({ body: { message: { role: "assistant", content: JSON.stringify(value) }, done: true } });
const irrelevant = { relevant: false, score: 0.1, topic: null, justification: "Hors périmètre.", outOfScope: [] };

async function world(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "xi-llm-integration-"));
  const db = new Database(join(root, "app.sqlite"));
  db.pragma("journal_mode = WAL"); db.pragma("busy_timeout = 5000");
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  const vault = await openVault(root);
  const topics = createTopicStore({ vault, db });
  const accounts = createAccountStore({ vault, db, topics });
  const sources = createSourceStore({ vault, topics });
  const publications = createPublicationStore({ vault, db });
  const run = await topics.propose("alice", "Politique");
  await topics.confirm("alice", run.id, { tag: "politiks", name: "Politiks", description: "Test", scope: "Vie politique française.", parentId: null, relatedIds: [] }, true);
  const topicId = run.topicId;
  const runtime = createLLMRuntime({ db, env: {} });
  const agent = async (config: AgentLLMConfig | null) => {
    const proposed = await accounts.propose("alice", topicId);
    const ready = await accounts.resume("alice", proposed.id);
    await accounts.confirm("alice", ready.id, { ...ready.draft!, handle: `agent-${randomUUID().slice(0, 8)}`, modelRef: null }, true);
    await accounts.setWatchPolicy("alice", ready.accountId, { revision: null, policy: { ...DEFAULT_WATCH_POLICY, enabled: true } });
    if (config) await accounts.setLLM("alice", ready.accountId, { revision: null, config });
    return ready.accountId;
  };
  migrateWatchCandidates(db);
  const clock = Date.parse("2026-01-15T12:00:00Z");
  const items = [
    { publisher: "Le Quotidien", title: "Le Parlement adopte la réforme des retraites", summary: "Le Parlement a définitivement adopté jeudi la réforme des retraites." },
    { publisher: "Le Journal", title: "Réforme des retraites : vote définitif", summary: "Les parlementaires ont voté jeudi la réforme des retraites." },
  ];
  // Approved catalogue sources: evaluation only uses articles of the owner's catalogue (trust.ts).
  const feeds = await Promise.all(items.map(async (item, i) => {
    const { source } = await sources.propose("alice", { url: `https://${i}.example/rss`, kind: "feed", site: null, publisher: item.publisher, topicIds: [topicId], reliability: { level: "inconnue", reasons: [], estimated: true } }, "alice");
    return sources.decide("alice", source.id, { action: "approve", revision: source.revision });
  }));
  /** A collected story (shared by the owner's agents). */
  function story() {
    const ids: string[] = [];
    for (const [i, item] of items.entries()) {
      recordEntries(db, { owner: "alice", source: { id: feeds[i].id, publisher: item.publisher, ownerGroup: null, topicIds: [topicId] }, entries: [{ url: `https://${i}.example/${randomUUID()}`, guid: null, title: item.title, summary: item.summary, publishedAt: "2026-01-15T09:00:00.000Z", author: null, credits: [], links: [] }], now: clock });
      ids.push((db.prepare("SELECT id FROM watch_item ORDER BY rowid DESC LIMIT 1").get() as { id: string }).id);
    }
    const storyId = (db.prepare("SELECT story_id FROM watch_item WHERE id = ?").get(ids[0]) as { story_id: string }).story_id;
    const version = (db.prepare("SELECT item_count FROM watch_story WHERE id = ?").get(storyId) as { item_count: number }).item_count;
    return { storyId, version, ids };
  }
  /** The same story, evaluated and verified for `agentId` (as evaluation leaves it). */
  function accepted(agentId: string) {
    const { storyId, version, ids } = story();
    db.prepare("DELETE FROM watch_candidate WHERE agent_id = ? AND story_id = ?").run(agentId, storyId);
    db.prepare("INSERT INTO watch_candidate (agent_id, story_id, owner, story_version, status, stage, lane, topic_id, relevance, novelty, novelty_kind, importance, reason, data, model, prompt_version, created_at, updated_at) VALUES (?, ?, 'alice', ?, 'accepted', 'done', 'night', ?, 0.9, 1, 'new', 0.7, 'Vérifié.', ?, 'm', 'veille-3.1', ?, ?)")
      .run(agentId, storyId, version, topicId, JSON.stringify({ title: items[0].title }), clock, clock);
    db.prepare("INSERT INTO watch_claim VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(randomUUID(), agentId, storyId, 0, "Le Parlement a définitivement adopté la réforme des retraites jeudi.", "fact", null, "corroborated", "Vérifié.",
      JSON.stringify({ quotes: [{ itemId: ids[0], label: "I1", publisher: items[0].publisher, quote: "Le Parlement a définitivement adopté jeudi la réforme des retraites", lineage: 0, official: false, url: "https://x.example" }, { itemId: ids[1], label: "I2", publisher: items[1].publisher, quote: "Les parlementaires ont voté jeudi la réforme des retraites", lineage: 1, official: false, url: "https://x.example" }], rejectedQuotes: 0 }), 2);
    return { storyId, version };
  }
  const llm = (agent: WatchAgent) => runtime.bind(agent.owner, agentLLMSettings(agent));
  const evaluate = evaluateHandler({ db, accounts, topics, publications, sources, llm, now: () => clock });
  const draft = draftHandler({ db, accounts, topics, publications, llm, now: () => clock });
  const job = (kind: string, payload: Record<string, unknown>, attempts = 1, maxAttempts = 3): Job => ({ id: randomUUID(), kind, key: `${kind}:${randomUUID()}`, payload, state: "running", runAfter: 0, attempts, maxAttempts, leaseToken: "t", leaseUntil: 0, lastError: null, result: null, createdAt: 0, updatedAt: 0 });
  const instance = (name: string, key: string, url: string, defaultModel: string | null, options = {}) => runtime.store.create("alice", { type: "ollama", name, key, baseUrl: url, enabled: true, defaultModel, options });
  return { db, accounts, publications, runtime, agent, story, accepted, evaluate, draft, job, instance, clock, llm };
}

test("analysis and writing use each agent's resolved instance, model and options", { timeout: 30_000 }, async t => {
  const w = await world(t);
  const pi = await ollama(t, chat => content(chat.prompt.startsWith("Vérifie chaque message") ? { messages: [{ index: 1, supported: true, problems: [] }] } : chat.prompt.startsWith("Périmètre") ? irrelevant : {}));
  const mac = await ollama(t, chat => content(chat.prompt.startsWith("Vérifie chaque message") ? { messages: [{ index: 1, supported: true, problems: [] }] }
    : chat.prompt.startsWith("Périmètre") ? irrelevant
    : { format: "post", summary: "Le Parlement adopte la réforme des retraites.", messages: [{ text: "Le Parlement a définitivement adopté jeudi la réforme des retraites.", claims: ["A1"] }] }));
  const raspberry = w.instance("Ollama — Raspberry Pi", "raspberry-pi", pi.url, "petit-modele", { temperature: 0.1 });
  const macMini = w.instance("Ollama — Mac mini", "mac-mini", mac.url, "gros-modele", { contextSize: 8_192 });
  w.runtime.store.setDefault("alice", { revision: null, defaultInstanceId: raspberry.id });

  const inheriting = await w.agent(null);
  const otherModel = await w.agent({ instanceId: null, model: "modele-moyen", options: { maxTokens: 512 } });
  const otherInstance = await w.agent({ instanceId: macMini.id, model: null, options: { temperature: 0.3 } });

  // Analysis: the inheriting agent uses the global instance and its default model and options.
  const { storyId, version } = w.story();
  const first = await w.evaluate(w.job("evaluate-story", { agentId: inheriting, storyId, version }));
  assert.equal(first.status, "done");
  assert.deepEqual((first as { result: { llm: unknown } }).result.llm, { model: "petit-modele", instance: "Ollama — Raspberry Pi", instanceSource: "global" });
  assert.deepEqual([pi.chats[0].model, pi.chats[0].options.temperature, pi.chats[0].options.num_predict], ["petit-modele", 0.1, 2_048]);
  // Another model on the global instance, with its own generation limit.
  await w.evaluate(w.job("evaluate-story", { agentId: otherModel, storyId, version }));
  assert.deepEqual([pi.chats[1].model, pi.chats[1].options.num_predict, pi.chats[1].options.temperature], ["modele-moyen", 512, 0.1]);
  // Another instance: the Mac mini receives the request, never the Raspberry Pi.
  const before = pi.chats.length;
  await w.evaluate(w.job("evaluate-story", { agentId: otherInstance, storyId, version }));
  assert.equal(pi.chats.length, before);
  assert.deepEqual([mac.chats[0].model, mac.chats[0].options.temperature, mac.chats[0].options.num_ctx], ["gros-modele", 0.3, 8_192]);
  const models = w.db.prepare("SELECT agent_id, model FROM watch_candidate WHERE story_id = ?").all(storyId) as { agent_id: string; model: string }[];
  assert.deepEqual(Object.fromEntries(models.map(row => [row.agent_id, row.model])), { [inheriting]: "petit-modele", [otherModel]: "modele-moyen", [otherInstance]: "gros-modele" }, "the model used is recorded");

  // Writing: same resolution; the draft records model and portable instance key, and stays a private draft.
  const candidate = w.accepted(otherInstance);
  const drafted = await w.draft(w.job("draft-candidate", { agentId: otherInstance, storyId: candidate.storyId, version: candidate.version }));
  assert.equal((drafted as { result: { outcome: string } }).result.outcome, "drafted");
  assert.ok(mac.chats.some(chat => chat.prompt.includes("Affirmations vérifiées") && chat.model === "gros-modele"));
  const saved = await w.publications.get({ id: "alice" }, draftId(otherInstance, candidate.storyId, candidate.version));
  assert.deepEqual([saved.status, saved.visibility], ["draft", "private"], "generated text alone never publishes anything");
  assert.equal((await w.publications.agentPublications(otherInstance)).length, 0);
});

test("configuration problems wait visibly; failed inference fails the run and publishes nothing", { timeout: 30_000 }, async t => {
  const w = await world(t);
  let mode: "garbage" | "memory" = "garbage";
  const server = await ollama(t, () => mode === "memory" ? { status: 500, body: { error: "model requires more system memory (8 GiB) than is available (2 GiB)" } } : content("pas du JSON"));
  const local = w.instance("Ollama local", "local", server.url, "petit-modele");

  // Nothing configured: an explicit "not configured" problem, no request.
  const lonely = await w.agent(null);
  const { storyId, version } = w.story();
  const waiting = await w.evaluate(w.job("evaluate-story", { agentId: lonely, storyId, version }));
  assert.equal(waiting.status, "wait");
  assert.match((waiting as { reason: string }).reason, /not-configured/);

  // Disabled instance chosen by the agent: waits with the reason, never falls back to another instance.
  w.runtime.store.setDefault("alice", { revision: null, defaultInstanceId: local.id });
  const disabled = w.instance("Ollama éteint", "eteint", server.url, "autre");
  w.runtime.store.update("alice", disabled.id, { type: "ollama", name: "Ollama éteint", key: "eteint", baseUrl: server.url, enabled: false, defaultModel: "autre", options: {}, revision: disabled.revision });
  const pinned = await w.agent({ instanceId: disabled.id, model: null, options: {} });
  const blocked = await w.evaluate(w.job("evaluate-story", { agentId: pinned, storyId, version }));
  assert.equal(blocked.status, "wait");
  assert.match((blocked as { reason: string }).reason, /instance-disabled/);
  // A deleted instance is reported the same way.
  w.runtime.store.remove("alice", disabled.id);
  assert.match((await w.evaluate(w.job("evaluate-story", { agentId: pinned, storyId, version })) as { reason: string }).reason, /instance-missing/);
  assert.equal(server.chats.length, 0, "no request for a problem of configuration");
  // Planning still happens for real problems (so they reach the history), not for "nothing configured".
  const agents = await w.accounts.watchAgents();
  assert.equal(bindSafely(w.llm, agents.find(agent => agent.id === pinned)!).ok, false);

  // Invalid replies through the queue: retried, then the run fails; the candidate is held, nothing is drafted or published.
  const inherits = await w.agent(null);
  const queue = createJobQueue(w.db, () => w.clock);
  queue.enqueue({ kind: "evaluate-story", key: `evaluate:${inherits}`, payload: { agentId: inherits, storyId, version }, runAfter: w.clock, maxAttempts: 1 });
  const summary = await drainJobs({ queue, handlers: { "evaluate-story": w.evaluate }, clock: () => w.clock, control: { db: w.db, admit: async () => ({ allowed: true, deadline: null, trigger: "calendar" }), owner: async () => "alice" } });
  assert.equal(summary.failed, 1);
  const run = w.db.prepare("SELECT status, error FROM xiagent_run WHERE agent_id = ? AND kind = 'evaluate-story'").get(inherits) as { status: string; error: string };
  assert.equal(run.status, "failed", "a failed mandatory inference is never a success");
  assert.match(run.error, /InferenceOutputError/); assert.match(run.error, /petit-modele sur Ollama local/);
  assert.equal((w.db.prepare("SELECT status FROM watch_candidate WHERE agent_id = ?").get(inherits) as { status: string }).status, "held");
  assert.equal((await w.publications.agentPublications(inherits)).length, 0);

  // Out of memory: the server is unavailable for now, the job waits without consuming an attempt.
  mode = "memory";
  const memory = await w.agent(null);
  const result = await w.evaluate(w.job("evaluate-story", { agentId: memory, storyId, version }));
  assert.equal(result.status, "wait");
  assert.match((result as { reason: string }).reason, /Mémoire insuffisante/);
});
