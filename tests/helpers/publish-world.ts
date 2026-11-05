import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { test } from "node:test";
import Database from "better-sqlite3";
import { createArbitration } from "../../src/lib/arbiter/arbitration";
import { createAccountStore, type AccountStore } from "../../src/lib/accounts/store";
import { DEFAULT_WATCH_POLICY, type WatchPolicy } from "../../src/lib/accounts/types";
import { createPublicationStore, type PublicationStore } from "../../src/lib/publications/store";
import { openVault } from "../../src/lib/publications/vault";
import { createSystemAgentStore } from "../../src/lib/system-agents/store";
import { systemTaskHandler } from "../../src/lib/system-agents/tasks";
import { createTopicStore } from "../../src/lib/topics/store";
import { draftId } from "../../src/lib/watch/drafting";
import { migrateWatchCandidates } from "../../src/lib/watch/evaluate";
import { InferenceUnavailableError, type ChatRequest } from "../../src/lib/watch/inference";
import type { LLMBinding } from "../../src/lib/watch/llm-binding";
import { SYSTEM_TASK_KIND } from "../../src/lib/watch/orchestrator";
import type { PublishSettings } from "../../src/lib/watch/publisher";
import { agentSlot, nightWindow } from "../../src/lib/watch/schedule";
import { createSourceStore } from "../../src/lib/watch/sources";
import { recordEntries } from "../../src/lib/watch/stories";
import { tick, windowHandlers, type Handler } from "../../src/lib/watch/worker";

export const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

/** An agent with two approved feeds, drafted candidates on demand, the publisher and a simulated @arbitre. */
/** `diffusion`: the publishing path under test (legacy per-agent windows unless asked). */
export async function world(t: test.TestContext, start = "2026-01-15T12:00:00Z", { diffusion = "legacy" }: { diffusion?: "queue" | "legacy" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "xi-watch-publish-"));
  const db = new Database(join(root, "app.sqlite"));
  db.pragma("journal_mode = WAL"); db.pragma("busy_timeout = 5000");
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  const vault = await openVault(root);
  const topics = createTopicStore({ vault, db });
  const accounts = createAccountStore({ vault, db, topics });
  const sources = createSourceStore({ vault, topics });
  const clock = { now: Date.parse(start) };
  // Every store follows the simulated clock: publication instants are compared with it.
  const store = () => createPublicationStore({ vault, db, now: () => new Date(clock.now) });
  const publications = store();
  const topicRun = await topics.propose("alice", "Politique");
  await topics.confirm("alice", topicRun.id, { tag: "politiks", name: "Politiks", description: "Test", scope: "Vie politique française.", parentId: null, relatedIds: [] }, true);
  const topicId = topicRun.topicId;
  const agent = async (owner: string) => {
    const proposed = await accounts.propose(owner, topicId);
    const ready = await accounts.resume(owner, proposed.id);
    await accounts.confirm(owner, ready.id, ready.draft!, true);
    return ready.accountId;
  };
  const agentId = await agent("alice");
  const approved = async (publisher: string) => {
    const { source } = await sources.propose("alice", { url: `https://${publisher.toLowerCase().replace(/\W+/g, "")}.example/rss`, kind: "feed", site: null, publisher, topicIds: [topicId], reliability: { level: "inconnue", reasons: [], estimated: true } }, "alice");
    return sources.decide("alice", source.id, { action: "approve", revision: source.revision });
  };
  const feeds = [await approved("Le Quotidien"), await approved("Le Journal")];
  const settings: PublishSettings = { autoPublish: true, allowPublic: false, diffusion };
  migrateWatchCandidates(db);
  const policy = async (changes: Partial<WatchPolicy>, confirmPublic = false) => {
    const current = await accounts.watchPolicy("alice", agentId);
    return accounts.setWatchPolicy("alice", agentId, { revision: current.revision, policy: { ...DEFAULT_WATCH_POLICY, enabled: true, autoPublish: true, ...changes }, ...(confirmPublic ? { confirmPublic: true } : {}) });
  };
  await policy({});
  /** A verified, drafted candidate on fictitious news (two independent sources). */
  async function drafted({ title, fact, importance = 0.8, lane = "night", hoursAgo = 1, owner = "alice", agent: forAgent = agentId }: { title: string; fact: string; importance?: number; lane?: string; hoursAgo?: number; owner?: string; agent?: string }) {
    const items = [];
    for (const feed of feeds) {
      const url = `https://${feed.publisher.toLowerCase().replace(/\W+/g, "")}.example/${randomUUID()}`;
      recordEntries(db, { owner, source: { id: feed.id, publisher: feed.publisher, ownerGroup: null, topicIds: [topicId] }, entries: [{ url, guid: null, title, summary: `${fact}, selon ${feed.publisher}.`, publishedAt: new Date(clock.now - hoursAgo * HOUR).toISOString(), author: null, credits: [], links: [] }], now: clock.now });
      items.push({ url, publisher: feed.publisher, ...(db.prepare("SELECT id, story_id FROM watch_item WHERE url = ?").get(url) as { id: string; story_id: string }) });
    }
    const story = items[0].story_id;
    assert.ok(items.every(item => item.story_id === story));
    const version = (db.prepare("SELECT item_count FROM watch_story WHERE id = ?").get(story) as { item_count: number }).item_count;
    db.prepare("INSERT INTO watch_candidate (agent_id, story_id, owner, story_version, status, stage, lane, topic_id, relevance, novelty, novelty_kind, importance, reason, data, model, prompt_version, created_at, updated_at) VALUES (?, ?, ?, ?, 'drafted', 'done', ?, ?, 0.9, 1, 'new', ?, 'Brouillon prêt.', '{}', 'modele-local', 'veille-3.1', ?, ?)")
      .run(forAgent, story, owner, version, lane, topicId, importance, clock.now, clock.now);
    db.prepare("INSERT INTO watch_claim VALUES (?, ?, ?, 0, ?, 'fact', NULL, 'corroborated', '2 voix.', ?, 2)").run(randomUUID(), forAgent, story, `${fact}.`, JSON.stringify({ quotes: items.map(item => ({ itemId: item.id, publisher: item.publisher, quote: fact })), rejectedQuotes: 0 }));
    const id = draftId(forAgent, story, version);
    const draft = await publications.saveWatchDraft(owner, forAgent, {
      id, summary: `${title} : ${fact}.`, topicIds: [topicId], messages: [{ body: `${fact}.`, sources: [0, 1] }],
      sources: items.map(item => ({ url: item.url, title, publisher: item.publisher, accessedAt: "2026-01-15", facts: [fact], reservations: [] })), watch: { story },
    });
    db.prepare("UPDATE watch_candidate SET data = ? WHERE agent_id = ? AND story_id = ?").run(JSON.stringify({ title, draft: { id, revision: draft.revision } }), forAgent, story);
    return { story, id, items };
  }
  // @arbitre on the requester's (simulated) local model: favorable unless a test says otherwise.
  const systemAgents = createSystemAgentStore({ vault, db });
  const arbitration = createArbitration({ db, systemAgents, now: () => clock.now });
  const arbiter = {
    requests: [] as ChatRequest[], available: true as boolean,
    answer: ((): string | Promise<string> => JSON.stringify({ priority: true, justification: "Conséquences immédiates pour tout le pays.", criteria: ["Portée nationale", "Urgence datée"] })) as (request: ChatRequest) => string | Promise<string>,
  };
  const arbiterLLM = (): LLMBinding => ({
    ok: true, resolved: { model: "qwen-test", instance: { name: "Ollama local" }, instanceSource: "global", modelSource: "global" } as never,
    inference: { complete: async request => { arbiter.requests.push(request); if (!arbiter.available) throw new InferenceUnavailableError("Ollama injoignable."); return arbiter.answer(request); } },
  });
  const systemTasks = systemTaskHandler({ store: systemAgents, llm: arbiterLLM, services: { db, accounts, topics }, now: () => clock.now });
  const handlers = (store: PublicationStore = publications, accountStore: AccountStore = accounts): Record<string, Handler> => ({ ...windowHandlers({ db, accounts: accountStore, sources, publications: store, settings, arbitration, now: () => clock.now }), [SYSTEM_TASK_KIND]: systemTasks });
  const run = (h = handlers()) => tick({ db, accounts, handlers: h, now: () => new Date(clock.now) });
  const candidate = (story: string, agent = agentId) => db.prepare("SELECT status, lane, reason FROM watch_candidate WHERE agent_id = ? AND story_id = ?").get(agent, story) as { status: string; lane: string | null; reason: string };
  const decisions = (agent = agentId) => db.prepare("SELECT outcome, lane, reason, story_id, visibility FROM watch_decision WHERE agent_id = ? ORDER BY rowid").all(agent) as { outcome: string; lane: string; reason: string; story_id: string; visibility: string }[];
  const slot = (date: Date) => agentSlot(agentId, nightWindow(date)).getTime();
  return { root, db, vault, topics, accounts, sources, publications, store, topicId, agentId, agent, feeds, settings, clock, policy, drafted, handlers, run, candidate, decisions, slot, systemAgents, arbitration, arbiter };
}
