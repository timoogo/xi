import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createArbitration, createArbitrationStore } from "../src/lib/arbiter/arbitration";
import { acceptedIds, previewDraft, selectAll } from "../src/lib/konstruktor/preview";
import { createPublicationStore } from "../src/lib/publications/store";
import { systemTaskHandler } from "../src/lib/system-agents/tasks";
import type { ChatRequest } from "../src/lib/watch/inference";
import type { PoliteFetch } from "../src/lib/watch/net";
import { SYSTEM_TASK_KIND } from "../src/lib/watch/orchestrator";
import { migrateWatchCandidates } from "../src/lib/watch/evaluate";
import { migrateWatchDecisions, type PublishSettings } from "../src/lib/watch/publisher";
import { migrateWatchItems } from "../src/lib/watch/stories";
import { engineHandlers, tick } from "../src/lib/watch/worker";
import { draftToSpec, newDraft } from "../src/lib/xiagents/draft";
import { supervision } from "../src/lib/xiagents/supervision";
import { json, model, setup } from "./helpers/konstruktor";
import { bindTo } from "./helpers/llm";

const MIN = 60_000;
type App = Awaited<ReturnType<typeof setup>>;

/** Two independent voices on one event: same title, different wording, the claim quoted in each. */
type Event = { title: string; journalTitle: string; quotidien: string; journal: string; claim: string; quotes: [string, string]; importance: number };
const WATER: Event = {
  title: "Le Sénat adopte la loi sur l'eau", journalTitle: "Loi sur l'eau : le Sénat vote le texte", importance: 0.7,
  quotidien: "Le Sénat a adopté mardi la loi sur la gestion de l'eau, après un long débat.",
  journal: "Mardi, les sénateurs ont adopté la loi sur la gestion de l'eau.",
  claim: "Le Sénat a adopté mardi la loi sur la gestion de l'eau.",
  quotes: ["Le Sénat a adopté mardi la loi sur la gestion de l'eau", "Mardi, les sénateurs ont adopté la loi sur la gestion de l'eau"],
};
const RESIGNATION: Event = {
  title: "Le Premier ministre démissionne", journalTitle: "Démission du Premier ministre et de son gouvernement", importance: 1,
  quotidien: "Le Premier ministre a présenté mercredi soir la démission de son gouvernement au président.",
  journal: "Mercredi soir, le chef du gouvernement a remis sa démission au président de la République.",
  claim: "Le Premier ministre a présenté mercredi soir la démission de son gouvernement.",
  quotes: ["Le Premier ministre a présenté mercredi soir la démission de son gouvernement", "Mercredi soir, le chef du gouvernement a remis sa démission"],
};

const rss = (publisher: string, items: { title: string; text: string; url: string; at: number }[]) => Buffer.from(`<?xml version="1.0"?><rss version="2.0"><channel><title>${publisher}</title><link>https://example.org/</link>${items.map(item => `<item><title>${item.title.replace(/'/g, "&apos;")}</title><link>${item.url}</link><pubDate>${new Date(item.at).toUTCString()}</pubDate><description>${item.text.replace(/'/g, "&apos;")}</description></item>`).join("")}</channel></rss>`);

test("integration: Konstruktor → validation → deployment → collection → local evaluation → drafting → queue → central diffuser → off-hours @arbitre → feed and supervision, across restarts", { timeout: 120_000 }, async t => {
  const clock = { now: Date.parse("2026-10-28T10:00:00Z") }; // 11:00 Paris
  const events: { event: Event; at: number }[] = [];
  const fetches: string[] = [];
  const fetch = (async (url: string) => {
    fetches.push(url);
    const host = new URL(url).hostname;
    const [publisher, key] = host.startsWith("quotidien") ? ["Le Quotidien", "quotidien"] as const : ["Le Journal", "journal"] as const;
    return { status: 200, url, headers: { "content-type": "application/rss+xml" }, body: rss(publisher, events.map(({ event, at }, i) => ({ title: key === "quotidien" ? event.title : event.journalTitle, text: event[key], url: `https://${host}/article-${i}`, at }))) };
  }) as unknown as PoliteFetch;

  // One local model double for the whole platform: Konstruktor, the editorial steps, @arbitre.
  const stages: string[] = [];
  const answer = (request: ChatRequest) => {
    if (request.stage) {
      stages.push(request.stage);
      const event = [WATER, RESIGNATION].find(item => request.prompt.includes(item.title) || request.prompt.includes(item.claim)) ?? WATER;
      switch (request.stage) {
        case "relevance": return json({ relevant: true, score: 1, topic: "T1", justification: "Vie parlementaire.", outOfScope: [] });
        case "merge": return json({ sameEvent: null, justification: "Événements distincts." });
        case "novelty": return json({ kind: "new", related: null, score: 1, newFacts: [], justification: "Sujet non traité." });
        case "extraction": {
          // Source labels follow the prompt's order; each quote is taken from its own text.
          const labelOf = (text: string) => new RegExp(`\\[(I\\d+)\\] [^\\n]+\\nTitre : [^\\n]+\\nTexte : [^\\n]*${text.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).exec(request.prompt)?.[1] ?? "I9";
          return json({ claims: [{ text: event.claim, kind: "fact", attribution: null, evidence: [{ item: labelOf(event.quotidien), quote: event.quotes[0] }, { item: labelOf(event.journal), quote: event.quotes[1] }] }], contradictions: [], impact: { score: event.importance, reasons: ["Portée nationale."] } });
        }
        case "draft": return json({ format: "post", summary: event.title, messages: [{ text: event.claim, claims: ["A1"] }] });
        case "consistency": return json({ messages: [] });
      }
    }
    if (/seule question/.test(request.system)) return json({ priority: true, justification: "Conséquences immédiates pour tout le pays.", criteria: ["Portée nationale", "Urgence datée"] });
    const topic = (JSON.parse(/<donnees>\n([\s\S]*)\n<\/donnees>/.exec(request.prompt)![1]) as { topics: { ref: string; tag: string }[] }).topics.find(item => item.tag === "parlement")!.ref;
    return json({
      reply: "Voici un ΞAgent parlementaire : veille de 8 h à 20 h, publication de 9 h à 19 h, événements majeurs suivis hors horaires.",
      questions: [], unsupported: [],
      proposal: {
        summary: "Créer @veille-parlement", name: "Veille Parlement", handle: "veille-parlement", description: "Travaux parlementaires.",
        perimeter: "Votes, lois et gouvernement.", charter: "Des faits sourcés uniquement.", topics: [{ existing: topic }],
        sources: [{ url: "https://quotidien.example/rss", rationale: "Quotidien national." }, { url: "https://journal.example/rss", rationale: "Second titre indépendant." }],
        schedule: { timeZone: "Europe/Paris", watch: { ranges: [{ from: "08:00", to: "20:00" }] }, publish: { ranges: [{ from: "09:00", to: "19:00" }] }, graceMinutes: 30, majorEvents: true },
        publication: { autoPublish: true, maxPerDay: 4, minIntervalMinutes: 15 },
        model: { instance: "I1", model: "qwen-test" },
      },
    });
  };
  const local = model(answer);
  const inference = { complete: async (request: ChatRequest) => { local.requests.push(request); return answer(request); } };
  let app: App = await setup(t, local.binding);
  const root = app.root;
  /** A process restart: every store and connection reopened on the same SQLite file and vault. */
  const restart = async () => { await app.close(); app = await setup(t, local.binding, { root }); };

  // 1. Konstruktor: a conversation proposes, nothing is written before the owner's validation.
  await app.store.list();
  await app.topics.create("alice", randomUUID(), { tag: "parlement", name: "Parlement", description: "", scope: "Travaux parlementaires.", parentId: null, relatedIds: [] });
  const sessionId = randomUUID();
  await app.konstruktor.open("alice", { id: sessionId, target: { type: "new-agent", id: null } });
  await app.konstruktor.send("alice", sessionId, { requestId: randomUUID(), text: "Un agent qui suit le Parlement en journée et les événements majeurs la nuit." });
  await app.tasks.close();
  assert.deepEqual(await app.accounts.watchAgents(), [], "proposed, not created");
  const proposals = (await app.konstruktor.view("alice", sessionId)).history.flatMap(message => message.proposals);
  const configuration = await app.konstruktor.configuration("alice", sessionId);
  assert.equal(configuration.kind, "new-agent");
  const base = newDraft({ presets: configuration.presets, timeZone: "Europe/Paris" });
  const shown = previewDraft(base, proposals, selectAll(proposals), {}).draft;
  // 2. Explicit validation: the owner approves the suggested sources and applies the proposal.
  const { draft } = previewDraft(base, proposals, selectAll(proposals), { sources: shown.sources.map(row => ({ ...row, status: "approved" as const })) });
  const deploymentId = randomUUID();
  await app.konstruktor.apply("alice", sessionId, { deploymentId, spec: draftToSpec(draft), accepted: acceptedIds(proposals, selectAll(proposals)) });

  // Restart between validation and deployment: the recorded application runs once.
  await restart();
  const done = await app.deployments.run("alice", deploymentId);
  assert.equal(done.state, "completed", JSON.stringify(done.steps.find(step => step.error)));
  const agentId = done.ids.agentId!;
  assert.equal((await app.deployments.run("alice", deploymentId)).state, "completed", "idempotent");
  assert.equal((await app.accounts.watchAgents()).filter(agent => agent.owner === "alice").length, 1);
  const policy = (await app.accounts.watchPolicy("alice", agentId)).policy;
  assert.deepEqual([policy.autoPublish, policy.visibility], [true, "private"], "private by default; no public confirmation");
  assert.deepEqual((await app.sources.list("alice")).sources.map(source => [new URL(source.url).hostname, source.status]).sort(), [["journal.example", "approved"], ["quotidien.example", "approved"]]);

  // 3. The engine on the same stores, with the local model double; publications go to the temporary vault only.
  const settings: PublishSettings = { autoPublish: true, allowPublic: false, diffusion: "queue" };
  const engine = () => {
    const publications = createPublicationStore({ vault: app.vault, db: app.db, now: () => new Date(clock.now) });
    const arbitration = createArbitration({ db: app.db, systemAgents: app.store, now: () => clock.now });
    const handlers = {
      ...engineHandlers({ db: app.db, accounts: app.accounts, topics: app.topics, publications, sources: app.sources, fetch, llm: bindTo(inference, "qwen-test"), settings, arbitration, now: () => new Date(clock.now) }),
      [SYSTEM_TASK_KIND]: systemTaskHandler({ store: app.store, llm: local.binding, services: { db: app.db, accounts: app.accounts, topics: app.topics }, now: () => clock.now }),
    };
    const pass = () => tick({ db: app.db, accounts: app.accounts, sources: app.sources, handlers, canEvaluate: () => true, now: () => new Date(clock.now) });
    return { publications, pass };
  };
  const published = () => (app.db.prepare("SELECT story_id, lane, reason FROM watch_decision WHERE agent_id = ? AND outcome = 'published' ORDER BY at").all(agentId) as { story_id: string; lane: string; reason: string }[]);
  const candidate = (title: string) => app.db.prepare("SELECT c.status, c.lane FROM watch_candidate c JOIN watch_story s ON s.id = c.story_id WHERE c.agent_id = ? AND s.title = ?").get(agentId, title) as { status: string; lane: string } | undefined;
  /** Passes every 5 minutes until `until` holds; `between` runs after each pass (a restart, a check). */
  async function passes(until: () => boolean, max: number, between?: (i: number) => Promise<void>) {
    for (let i = 0; i < max && !until(); i++) {
      await engine().pass();
      if (between) await between(i);
      clock.now += 5 * MIN;
    }
    assert.ok(until(), `not reached in ${max} passes: ${JSON.stringify({ candidates: app.db.prepare("SELECT status, lane, reason FROM watch_candidate WHERE agent_id = ?").all(agentId), decisions: app.db.prepare("SELECT outcome, lane, reason FROM watch_decision").all(), jobs: app.db.prepare("SELECT kind, state, last_error FROM watch_job WHERE state != 'done'").all() })}`);
  }

  // The checks below read tables the worker creates on its first pass.
  migrateWatchItems(app.db); migrateWatchCandidates(app.db); migrateWatchDecisions(app.db);
  // In the watch and publish calendars (11:00 Paris): collected, evaluated, drafted, queued, diffused.
  events.push({ event: WATER, at: clock.now - 30 * MIN });
  let restartedWhileDrafted = false;
  await passes(() => published().length === 1, 12, async () => {
    // Restart as soon as a draft waits in the editorial queue, before the diffuser publishes it.
    if (!restartedWhileDrafted && candidate(WATER.title)?.status === "drafted") { restartedWhileDrafted = true; await restart(); }
  });
  assert.deepEqual(["relevance", "extraction", "draft"].filter(stage => !stages.includes(stage)), [], "every editorial step went through the local model");
  assert.ok(fetches.some(url => url.includes("quotidien.example")) && fetches.some(url => url.includes("journal.example")), "both approved feeds collected");
  assert.equal(candidate(WATER.title)?.status, "published");
  assert.equal(app.db.prepare("SELECT state FROM editorial_queue WHERE agent_id = ?").pluck().get(agentId), "published");

  // 4. Off hours (22:30 Paris): a major event, two voices, an alert outside the publish calendar → @arbitre decides → published.
  clock.now = Date.parse("2026-10-28T21:30:00Z");
  events.push({ event: RESIGNATION, at: clock.now - 10 * MIN });
  await passes(() => published().length === 2, 12);
  const [, alert] = published();
  assert.equal(alert.lane, "immediate");
  assert.match(alert.reason, /accordée par @arbitre/);
  const [request] = createArbitrationStore(app.db, () => clock.now).list("alice");
  assert.deepEqual([request.status, request.outcome?.result], ["favorable", "published"]);

  // Restart after publication: nothing asked, drafted or published twice.
  await restart();
  const before = { model: local.requests.length, jobs: app.db.prepare("SELECT count(*) FROM watch_job").pluck().get() };
  for (let i = 0; i < 3; i++) { await engine().pass(); clock.now += 5 * MIN; }
  assert.equal(published().length, 2);
  assert.equal(createArbitrationStore(app.db, () => clock.now).list("alice").length, 1);
  assert.equal(local.requests.length, before.model, "no new inference for content already handled");

  // 5. Feed: two private publications of the agent, readable by its owner only.
  const { publications } = engine();
  await publications.ensureIndexed();
  const posts = publications.agentPublications(agentId).filter(item => !item.test);
  assert.equal(posts.length, 2);
  for (const post of posts) {
    const full = await publications.get({ id: "alice" }, post.id);
    assert.deepEqual([full.status, full.visibility], ["published", "private"]);
    await assert.rejects(publications.get({ id: "bob" }, post.id), /introuvable/);
  }

  // 6. Supervision: the same story told from the database, scoped to its owner.
  const agents = await app.accounts.watchAgents();
  const queue = supervision(app.db, "alice", agents, { view: "queue" }, clock.now);
  assert.ok(queue.view === "queue");
  if (queue.view === "queue") assert.deepEqual(queue.counts, { ready: 0, published: 2, withdrawn: 0, expired: 0 });
  const activity = supervision(app.db, "alice", agents, { view: "activity", from: "2026-10-28", to: "2026-10-29" }, clock.now);
  assert.ok(activity.view === "activity");
  if (activity.view === "activity") {
    const kinds = new Set(activity.items.map(item => item.type === "run" ? item.kind : item.type));
    for (const kind of ["collect-source", "evaluate-story", "draft-candidate", "arbitration"]) assert.ok(kinds.has(kind), `${kind} in the activity (${[...kinds]})`);
    assert.ok(!activity.items.some(item => item.state === "error"), JSON.stringify(activity.items.filter(item => item.state === "error")));
  }
  const bob = supervision(app.db, "bob", agents, { view: "activity", from: "2026-10-28", to: "2026-10-29" }, clock.now);
  assert.ok(bob.view === "activity" && bob.items.length === 0 && bob.scoped.length === 0);
});
