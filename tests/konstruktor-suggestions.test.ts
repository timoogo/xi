import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { BUILTIN_PRESETS } from "../src/lib/accounts/types";
import { DEFAULT_BLOUB_CONFIG } from "../src/lib/bloub/config";
import { previewDraft, selectAll } from "../src/lib/konstruktor/preview";
import { planReviews } from "../src/lib/konstruktor/suggestions";
import { InferenceUnavailableError } from "../src/lib/watch/inference";
import { createJobQueue, type JobQueue } from "../src/lib/watch/jobs";
import { SYSTEM_TASK_KIND } from "../src/lib/watch/orchestrator";
import { tick } from "../src/lib/watch/worker";
import type { WatchObserver } from "../src/lib/watch/events";
import { systemTaskHandler } from "../src/lib/system-agents/tasks";
import type { DraftPatch } from "../src/lib/xiagents/draft";
import { draftToEditSpec } from "../src/lib/xiagents/edit";
import { scheduleSchema } from "../src/lib/xiagents/schedule";
import { files, json, model, seed, setup } from "./helpers/konstruktor";

type App = Awaited<ReturnType<typeof setup>>;
const DAY = 86_400_000;
const sourcesAnswer = { reply: "Voici des sources fiables pour cette veille.", proposal: { summary: "Ajouter des sources", sources: [{ url: "https://astro.example.org/feed.xml", rationale: "Flux spécialisé." }] } };

/** Alice's active ΞAgent with a broken model, a closed watch calendar and no source; an uncovered topic; Bob's own agent. */
async function scenario(app: App) {
  const { topic, agentId } = await seed(app);
  const preset = BUILTIN_PRESETS[0];
  const create = async (owner: string, handle: string, topicId: string) => {
    const id = randomUUID();
    await app.accounts.createAgent(owner, id, {
      draft: { handle, name: handle, description: "", primaryTopicId: topicId, secondaryTopicIds: [], presetId: preset.id, presetVersion: preset.version, settings: preset.settings, active: true, modelRef: null, validationMode: "human" },
      profile: { perimeter: "Astronomie.", charter: "" }, bloub: DEFAULT_BLOUB_CONFIG, llm: { instanceId: randomUUID(), model: null, options: {} },
    });
    const watch = await app.accounts.watchPolicy(owner, id);
    await app.accounts.setWatchPolicy(owner, id, { revision: watch.revision, policy: { ...watch.policy, enabled: true } });
    const schedule = await app.accounts.schedule(owner, id);
    const rest = scheduleSchema.strip().parse(schedule);
    await app.accounts.setSchedule(owner, id, { revision: schedule.revision, schedule: { ...rest, watch: { ...rest.watch, week: Array(7).fill([]) } } });
    return id;
  };
  const active = await create("alice", "astro-nuit", topic.id);
  const { topic: volcans } = await app.topics.create("alice", randomUUID(), { tag: "volcans", name: "Volcans", description: "", scope: "Volcanologie", parentId: null, relatedIds: [] });
  const { topic: bobTopic } = await app.topics.create("bob", randomUUID(), { tag: "jardin", name: "Jardin", description: "", scope: "Jardinage", parentId: null, relatedIds: [] });
  const bobAgent = await create("bob", "veille-jardin", bobTopic.id);
  return { topic, agentId, active, volcans, bobAgent };
}
async function review(app: App, owner = "alice") {
  const request = await app.konstruktor.review(owner);
  await app.tasks.close();
  return app.tasks.get(owner, "konstruktor", request.requestId);
}
const byKind = async (app: App, owner = "alice") => new Map((await app.konstruktor.suggestions(owner)).map(item => [`${item.kind}:${item.agents[0]?.handle ?? item.topics[0]?.tag}`, item]));

test("konstruktor L6: a review turns problems into linked suggestions, deduplicated by fingerprint; nothing is configured", { timeout: 30_000 }, async t => {
  const { binding, requests } = model(request => json(request.prompt.includes("Bilan automatique") ? sourcesAnswer : { reply: "?", proposal: null }));
  const app = await setup(t, binding);
  const { active, volcans, agentId } = await scenario(app);
  void agentId;
  app.clock.at += 2 * DAY;
  const before = await files(app.root);
  const configuration = JSON.stringify([await app.accounts.llm("alice", active), await app.accounts.schedule("alice", active), await app.accounts.watchPolicy("alice", active)]);

  const done = await review(app);
  assert.equal(done.state, "done", done.message ?? "");
  const found = await byKind(app);
  assert.deepEqual([...found.keys()].sort(), ["model-unavailable:astro-nuit", "no-sources:astro-nuit", "topic-uncovered:volcans", "watch-closed:astro-nuit"]);
  const broken = found.get("model-unavailable:astro-nuit")!;
  assert.equal(broken.status, "pending");
  assert.match(broken.reason, /n’existe plus ou est désactivée/);
  assert.deepEqual(broken.agents.map(agent => agent.id), [active]);
  assert.deepEqual(broken.proposals.map(proposal => proposal.summary), ["Revenir à la configuration locale globale"]);
  assert.deepEqual(found.get("topic-uncovered:volcans")!.target, { type: "new-agent", id: null });
  assert.deepEqual(found.get("topic-uncovered:volcans")!.topics, [{ id: volcans.id, tag: "volcans" }]);
  const noSources = found.get("no-sources:astro-nuit")!;
  assert.equal(noSources.awaitingModel, false);
  assert.deepEqual(noSources.proposals.map(proposal => proposal.summary), ["Ajouter des sources"], "content from the local model");
  assert.ok(requests.every(request => request.prompt.includes("Bilan automatique")), "the model is asked about findings only");
  assert.equal((await app.konstruktor.suggestions("alice", { type: "agent", id: agentId })).length, 0, "filtered by linked ΞAgent");
  assert.equal((await app.konstruktor.suggestions("alice", { type: "agent", id: active })).length, 3);
  assert.equal((await app.konstruktor.suggestions("alice", { type: "topic", id: volcans.id })).length, 1, "filtered by linked Topic");
  assert.deepEqual(await files(app.root), before, "a review writes no vault file");
  assert.equal(JSON.stringify([await app.accounts.llm("alice", active), await app.accounts.schedule("alice", active), await app.accounts.watchPolicy("alice", active)]), configuration, "nor any configuration");

  // Same state: the same review again is the same request; the next days plan nothing.
  const asked = requests.length;
  assert.equal((await app.konstruktor.review("alice")).requestId, done.requestId);
  const queue = createJobQueue(app.db, () => app.clock.at);
  const services = { db: app.db, accounts: app.accounts, topics: app.topics, sources: app.sources, models: app.models };
  // Bob's own review first: his agent's problems are his.
  await review(app, "bob");
  app.clock.at += DAY;
  assert.equal(await planReviews({ queue, systemAgents: app.store, services, now: app.clock.at }), 0, "no change: no review, no model call");
  assert.equal(requests.length, asked + 1, "only Bob's review asked the model");
  assert.equal((await app.konstruktor.suggestions("alice")).length, 4, "never repeated");

  // A refused suggestion stays refused for the same state.
  await app.konstruktor.decideSuggestion("alice", found.get("watch-closed:astro-nuit")!.id, { action: "refuse" });
  // A significant change: the model is fixed elsewhere, then broken another way.
  const llm = await app.accounts.llm("alice", active);
  await app.accounts.setLLM("alice", active, { revision: llm.revision, config: { instanceId: null, model: null, options: {} } });
  assert.equal(await planReviews({ queue, systemAgents: app.store, services, now: app.clock.at }), 1, "re-evaluation after a change");
  await app.tasks.kick();
  let now = await byKind(app);
  assert.equal(now.get("model-unavailable:astro-nuit")!.status, "obsolete");
  assert.equal(now.get("watch-closed:astro-nuit")!.status, "refused");
  const fixed = await app.accounts.llm("alice", active);
  await app.accounts.setLLM("alice", active, { revision: fixed.revision, config: { instanceId: randomUUID(), model: null, options: {} } });
  assert.equal(await planReviews({ queue, systemAgents: app.store, services, now: app.clock.at }), 1);
  await app.tasks.kick();
  now = await byKind(app);
  assert.equal((await app.konstruktor.suggestions("alice")).filter(item => item.kind === "model-unavailable").length, 2, "another fingerprint, another suggestion");
  assert.equal((await app.konstruktor.suggestions("alice")).filter(item => item.kind === "watch-closed").length, 1, "refused, same state: not suggested again");

  // Konstruktor disabled: nothing is planned, even after a change.
  const agent = await app.store.get("konstruktor");
  const disabled = { get: async () => ({ ...agent, enabled: false }) } as unknown as typeof app.store;
  const again = await app.accounts.llm("alice", active);
  await app.accounts.setLLM("alice", active, { revision: again.revision, config: { instanceId: randomUUID(), model: null, options: {} } });
  assert.equal(await planReviews({ queue, systemAgents: disabled, services, now: app.clock.at }), 0);
  assert.equal(await planReviews({ queue, systemAgents: app.store, services, now: app.clock.at }), 1, "enabled: the change is reviewed");
});

test("konstruktor L6: isolation, explicit validation through the L5 flow, resume after the model was unavailable", { timeout: 30_000 }, async t => {
  let up = false;
  const { binding } = model(request => {
    if (!up) throw new InferenceUnavailableError("Serveur Ollama injoignable.");
    return json(request.prompt.includes("Bilan automatique") ? sourcesAnswer : { reply: "?", proposal: null });
  });
  const app = await setup(t, binding);
  const { active, bobAgent } = await scenario(app);
  app.clock.at += 2 * DAY;

  // The model is down: rule-based suggestions are recorded at once, the others wait for it.
  const request = await app.konstruktor.review("alice");
  await app.tasks.close();
  assert.equal(app.tasks.get("alice", "konstruktor", request.requestId).state, "pending", "waiting for the model");
  let found = await byKind(app);
  assert.equal(found.get("model-unavailable:astro-nuit")!.proposals.length, 1);
  assert.equal(found.get("no-sources:astro-nuit")!.awaitingModel, true);
  assert.deepEqual(found.get("no-sources:astro-nuit")!.proposals, []);
  up = true;
  app.clock.at += 60_000;
  await app.tasks.kick();
  assert.equal(app.tasks.get("alice", "konstruktor", request.requestId).state, "done");
  found = await byKind(app);
  assert.equal(found.get("no-sources:astro-nuit")!.awaitingModel, false);
  assert.equal(found.get("no-sources:astro-nuit")!.proposals.length, 1, "completed after the interruption, once");
  assert.equal(found.size, 4, "nothing recorded twice");

  // Isolation: Bob sees none of Alice's suggestions, cannot decide on them nor open their conversation.
  const suggestion = found.get("model-unavailable:astro-nuit")!;
  assert.deepEqual((await app.konstruktor.suggestions("bob")).map(item => item.agents[0]?.id), [], "Bob has no review yet");
  await assert.rejects(app.konstruktor.decideSuggestion("bob", suggestion.id, { action: "refuse" }), { status: 404 });
  await assert.rejects(app.konstruktor.view("bob", suggestion.sessionId), { status: 404 });
  await assert.rejects(app.konstruktor.suggestions("alice", { type: "agent", id: "x" }), { name: "ZodError" });
  await app.konstruktor.review("bob");
  await app.tasks.close();
  assert.ok((await app.konstruktor.suggestions("bob")).every(item => item.agents.every(agent => agent.id === bobAgent)), "Bob's review reads Bob's agents only");

  // Validation is explicit: the suggestion is a conversation whose preview applies through a deployment.
  const llmBefore = await app.accounts.llm("alice", active);
  const configuration = await app.konstruktor.configuration("alice", suggestion.sessionId);
  if (configuration.kind !== "agent") throw new Error("agent");
  const proposals = (await app.konstruktor.view("alice", suggestion.sessionId)).history.flatMap(message => message.proposals);
  const { draft } = previewDraft(configuration.draft, proposals, selectAll(proposals), {});
  assert.deepEqual(await app.accounts.llm("alice", active), llmBefore, "nothing applied by the review");
  const { deployment } = await app.konstruktor.apply("alice", suggestion.sessionId, { deploymentId: randomUUID(), spec: draftToEditSpec(configuration.draft, draft, configuration.base), accepted: proposals.map(proposal => proposal.id) });
  assert.equal((await byKind(app)).get("model-unavailable:astro-nuit")!.status, "accepted");
  assert.equal((await app.deployments.run("alice", deployment.id)).state, "completed");
  assert.deepEqual((await app.accounts.llm("alice", active)).config, { instanceId: null, model: null, options: {} });
  assert.equal((await byKind(app)).get("model-unavailable:astro-nuit")!.status, "applied");
  await assert.rejects(app.konstruktor.decideSuggestion("alice", suggestion.id, { action: "refuse" }), { status: 409 });

  // Refuse and restore a suggestion without proposal decisions elsewhere.
  const closed = found.get("watch-closed:astro-nuit")!;
  assert.equal((await app.konstruktor.decideSuggestion("alice", closed.id, { action: "refuse" })).status, "refused");
  assert.equal((await app.konstruktor.decideSuggestion("alice", closed.id, { action: "restore" })).status, "pending");
});

test("konstruktor L5 consolidation: the preview in progress is saved per conversation and never configures anything", { timeout: 20_000 }, async t => {
  const app = await setup(t, model(() => json({ reply: "Je propose.", proposal: { summary: "Préciser", perimeter: "Astronomie et astronautique.", charter: "Dater." } })).binding);
  const { agentId } = await seed(app);
  const sessionId = randomUUID();
  await app.konstruktor.open("alice", { id: sessionId, target: { type: "agent", id: agentId } });
  await app.konstruktor.send("alice", sessionId, { requestId: randomUUID(), text: "Précise." });
  await app.tasks.close();
  const [proposal] = (await app.konstruktor.view("alice", sessionId)).history.flatMap(message => message.proposals);
  assert.equal(app.konstruktor.preview("alice", sessionId), null);
  assert.equal((await app.konstruktor.view("alice", sessionId)).previewSaved, false);
  const before = await files(app.root);
  const profile = await app.accounts.profile("alice", agentId);
  const state = { selection: { [proposal.id]: ["perimeter"] }, manual: { charter: "Ma charte à moi." }, topicManual: {}, seed: null, timeZone: null };
  app.konstruktor.savePreview("alice", sessionId, state);
  assert.deepEqual(app.konstruktor.preview("alice", sessionId)!.state, state, "found again after a reload");
  assert.equal((await app.konstruktor.view("alice", sessionId)).previewSaved, true);
  assert.deepEqual(await files(app.root), before, "no vault write");
  assert.deepEqual(await app.accounts.profile("alice", agentId), profile, "no configuration change");
  assert.throws(() => app.konstruktor.savePreview("bob", sessionId, state), { status: 404 });
  assert.throws(() => app.konstruktor.preview("bob", sessionId), { status: 404 });
  assert.throws(() => app.konstruktor.savePreview("alice", sessionId, { ...state, manual: { owner: "bob" } }), { name: "ZodError" });
  assert.throws(() => app.konstruktor.savePreview("alice", sessionId, { ...state, extra: 1 }), { name: "ZodError" });
  // Rebuilt from the saved state, the preview shows the same values and provenance.
  const configuration = await app.konstruktor.configuration("alice", sessionId);
  if (configuration.kind !== "agent") throw new Error("agent");
  const restored = app.konstruktor.preview("alice", sessionId)!.state;
  const { draft } = previewDraft(configuration.draft, [proposal], restored.selection, restored.manual as DraftPatch);
  assert.deepEqual([draft.perimeter, draft.provenance.perimeter, draft.charter, draft.provenance.charter], ["Astronomie et astronautique.", "ai", "Ma charte à moi.", "manual"]);
});

test("worker pass: Konstruktor's periodic reviews are planned and drained by tick, once per state, never blocking the pass", { timeout: 30_000 }, async t => {
  const { binding, requests } = model(request => json(request.prompt.includes("Bilan automatique") ? sourcesAnswer : { reply: "?", proposal: null }));
  const app = await setup(t, binding);
  await scenario(app);
  app.clock.at += 2 * DAY;
  const services = { db: app.db, accounts: app.accounts, topics: app.topics, sources: app.sources, models: app.models };
  // As scripts/watch-worker.ts wires them.
  const handlers = { [SYSTEM_TASK_KIND]: systemTaskHandler({ store: app.store, llm: binding, services, now: () => app.clock.at }) };
  const reviews = { plan: (queue: JobQueue, at: number) => planReviews({ queue, systemAgents: app.store, services, now: at }) };
  const pass = (plan = reviews, observer?: WatchObserver) => tick({ db: app.db, accounts: app.accounts, sources: app.sources, handlers, reviews: plan, now: () => new Date(app.clock.at), observer });
  const first = await pass();
  assert.equal(first.planned, 2, "one review per owner with findings");
  assert.equal(first.done, 2);
  assert.deepEqual([...(await byKind(app)).keys()].sort(), ["model-unavailable:astro-nuit", "no-sources:astro-nuit", "topic-uncovered:volcans", "watch-closed:astro-nuit"]);
  assert.equal((await app.konstruktor.suggestions("bob")).length > 0, true);
  const asked = requests.length;
  // The next passes, same state: no review, no model call, nothing repeated.
  app.clock.at += 10 * 60_000;
  const second = await pass();
  assert.deepEqual([second.planned, second.done, requests.length, (await app.konstruktor.suggestions("alice")).length], [0, 0, asked, 4]);
  // A failing planning is reported and never stops the editorial pass.
  const events: { event: string; kind?: string }[] = [];
  const third = await pass({ plan: async () => { throw new Error("registre illisible"); } }, event => events.push(event as { event: string; kind?: string }));
  assert.equal(third.planned, 0);
  assert.ok(events.some(event => event.event === "worker.error" && event.kind === "konstruktor-review"));
  assert.ok(events.some(event => event.event === "worker.end"));
});
