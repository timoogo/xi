import { setOwnerFormat } from "../src/lib/watch/format-store";
import { DEFAULT_FORMAT } from "../src/lib/watch/format";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { createAccountStore, type AccountStore } from "../src/lib/accounts/store";
import { DEFAULT_WATCH_POLICY, type WatchPolicy } from "../src/lib/accounts/types";
import { createPublicationStore, type PublicationStore } from "../src/lib/publications/store";
import { openVault } from "../src/lib/publications/vault";
import { createTopicStore } from "../src/lib/topics/store";
import { watchDiagnostics } from "../src/lib/watch/diagnostics";
import { draftId, reviewDraft } from "../src/lib/watch/drafting";
import { migrateWatchCandidates } from "../src/lib/watch/evaluate";
import { createJobQueue } from "../src/lib/watch/jobs";
import { createPublisher, type PublishSettings } from "../src/lib/watch/publisher";
import { agentSlot, nightWindow } from "../src/lib/watch/schedule";
import { createSourceStore } from "../src/lib/watch/sources";
import { recordEntries } from "../src/lib/watch/stories";
import { tick, windowHandlers } from "../src/lib/watch/worker";

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

async function world(t: test.TestContext, start = "2026-01-15T12:00:00Z") {
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
  const settings: PublishSettings = { autoPublish: true, allowPublic: false };
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
  const handlers = (store: PublicationStore = publications, accountStore: AccountStore = accounts) => windowHandlers({ db, accounts: accountStore, sources, publications: store, settings, now: () => clock.now });
  const run = (h = handlers()) => tick({ db, accounts, handlers: h, now: () => new Date(clock.now) });
  const candidate = (story: string, agent = agentId) => db.prepare("SELECT status, lane, reason FROM watch_candidate WHERE agent_id = ? AND story_id = ?").get(agent, story) as { status: string; lane: string | null; reason: string };
  const decisions = (agent = agentId) => db.prepare("SELECT outcome, lane, reason, story_id, visibility FROM watch_decision WHERE agent_id = ? ORDER BY rowid").all(agent) as { outcome: string; lane: string; reason: string; story_id: string; visibility: string }[];
  const slot = (date: Date) => agentSlot(agentId, nightWindow(date)).getTime();
  return { root, db, vault, topics, accounts, sources, publications, store, topicId, agentId, agent, feeds, settings, clock, policy, drafted, handlers, run, candidate, decisions, slot };
}

test("night window: adaptive spacing, ceilings, idempotence, obsolete news, private by default", { timeout: 60_000 }, async t => {
  const w = await world(t);
  await w.policy({ maxPerDay: 2, minIntervalMinutes: 30 });
  const a = await w.drafted({ title: "Le Sénat adopte la loi sur l'eau", fact: "Le Sénat a adopté mardi la loi sur la gestion de l'eau", importance: 0.9 });
  const b = await w.drafted({ title: "Le budget de la culture augmente", fact: "Le ministère de la Culture disposera de crédits accrus en 2027", importance: 0.7 });
  const c = await w.drafted({ title: "Nouvelle ligne de tramway à Brest", fact: "La métropole de Brest inaugure une seconde ligne de tramway", importance: 0.5 });
  const slot = w.slot(new Date(w.clock.now));
  w.clock.now = slot;
  const job = { id: "x", kind: "publication-window", key: "x", payload: { agentId: w.agentId }, state: "running" as const, runAfter: 0, attempts: 1, maxAttempts: 3, leaseToken: "t", leaseUntil: 0, lastError: null, result: null, createdAt: 0, updatedAt: 0 };
  // Operator flag off: the window runs and publishes nothing.
  w.settings.autoPublish = false;
  assert.match(JSON.stringify(await w.handlers()["publication-window"](job)), /XI_WATCH_AUTOPUBLISH/);
  assert.equal(w.decisions().length, 0);
  // Flag on: the most important first, the next one after the interval, then the ceiling.
  w.settings.autoPublish = true;
  const first_run = await w.run();
  assert.equal(first_run.waiting, 1, "the window job waits for the interval");
  assert.deepEqual([w.candidate(a.story).status, w.candidate(b.story).status], ["published", "drafted"]);
  w.clock.now = slot + 30 * MIN;
  await w.run();
  assert.deepEqual([w.candidate(b.story).status, w.candidate(c.story).status], ["published", "drafted"]);
  // Every attempt is traced: the wait for the interval, then the ceiling.
  assert.deepEqual(w.decisions().map(d => d.outcome), ["published", "deferred", "published", "deferred"]);
  assert.match(w.decisions()[1].reason, /Intervalle/);
  assert.match(w.decisions()[3].reason, /Plafond/, "the binding constraint is reported, not the interval");
  const published = await w.publications.get({ id: "alice" }, a.id);
  assert.deepEqual([published.status, published.visibility], ["published", "private"]);
  await assert.rejects(w.publications.get({ id: "bob" }, a.id), /introuvable/);
  const index = await readFile(join(w.root, (w.db.prepare("SELECT path FROM publication WHERE id = ?").get(a.id) as { path: string }).path, "index.md"), "utf8");
  for (const field of ["review: auto-published", "decided_by: watch-auto", "lane: night", "visibility: private"]) assert.ok(index.includes(field), field);
  assert.ok(!index.includes("test_content"));
  // Re-running the same window (another worker, a restart): nothing published twice.
  const again = await w.handlers()["publication-window"](job);
  assert.equal(again.status, "done");
  assert.equal(w.publications.agentPublications(w.agentId).length, 2);
  // The following night the third one is too old (more than 36 h): abandoned, its draft retired.
  w.clock.now = w.slot(new Date(slot + DAY - 10 * MIN));
  await w.run();
  w.clock.now = w.slot(new Date(slot + DAY - 10 * MIN)) + 1;
  await w.run();
  assert.equal(w.candidate(c.story).status, "rejected");
  assert.match(w.decisions().at(-1)!.reason, /obsolète/);
  assert.match(await readFile(join(w.root, (w.db.prepare("SELECT path FROM publication WHERE id = ?").get(c.id) as { path: string }).path, "index.md"), "utf8"), /review: retired/);
  assert.equal((await w.publications.get({ id: "alice" }, c.id)).status, "draft");
});

test("immediate alerts: own ceiling, outside the window, freshness, one alert per event, popularity is not enough", { timeout: 60_000 }, async t => {
  const w = await world(t);
  await w.policy({ maxImmediatePerDay: 1, minIntervalMinutes: 15 });
  const alert = await w.drafted({ title: "Le Premier ministre démissionne", fact: "Le Premier ministre a présenté jeudi la démission de son gouvernement", importance: 0.95, lane: "immediate" });
  const second = await w.drafted({ title: "Dissolution de l'Assemblée annoncée", fact: "Le président de la République a annoncé la dissolution de l'Assemblée nationale", importance: 0.93, lane: "immediate" });
  const stale = await w.drafted({ title: "Accord trouvé sur les retraites", fact: "Les partenaires sociaux ont conclu un accord sur les retraites anticipées", importance: 0.9, lane: "immediate", hoursAgo: 7 });
  const popular = await w.drafted({ title: "Une vidéo virale d'un député", fact: "La vidéo d'un député a été vue des millions de fois", importance: 0.6, lane: "night" });
  w.clock.now += 2 * HOUR; // 14:00 UTC, outside the night window
  const result = await w.run();
  assert.equal(result.planned, 3 + 1, "three alerts (drafted immediate candidates) and the window job; none for the popular one");
  const outcome = (story: string) => w.decisions().filter(d => d.story_id === story).map(d => d.outcome);
  assert.deepEqual(outcome(alert.story), ["published"], JSON.stringify(w.decisions()));
  assert.equal(w.decisions().find(d => d.story_id === alert.story)!.lane, "immediate");
  assert.deepEqual([outcome(second.story), w.candidate(second.story).lane], [["deferred"], "night"]);
  assert.match(w.candidate(second.story).reason, /Plafond d’alertes/);
  assert.deepEqual([outcome(stale.story), /obsolète/.test(w.decisions().find(d => d.story_id === stale.story)!.reason)], [["abandoned"], true]);
  assert.deepEqual([outcome(popular.story), w.candidate(popular.story).status], [[], "drafted"]);
  // The same event comes back (one more article, re-evaluated and re-drafted): no second alert.
  const feed = w.feeds[0];
  recordEntries(w.db, { owner: "alice", source: { id: feed.id, publisher: feed.publisher, ownerGroup: null, topicIds: [w.topicId] }, entries: [{ url: `https://lequotidien.example/${randomUUID()}`, guid: null, title: "Le Premier ministre démissionne", summary: "Le Premier ministre a présenté jeudi la démission de son gouvernement, selon Le Quotidien.", publishedAt: new Date(w.clock.now - HOUR).toISOString(), author: null, credits: [], links: [] }], now: w.clock.now });
  const version = (w.db.prepare("SELECT item_count FROM watch_story WHERE id = ?").get(alert.story) as { item_count: number }).item_count;
  const items = w.db.prepare("SELECT url, publisher FROM watch_item WHERE story_id = ?").all(alert.story) as { url: string; publisher: string }[];
  const fact = "Le Premier ministre a présenté jeudi la démission de son gouvernement";
  const redraft = await w.publications.saveWatchDraft("alice", w.agentId, { id: draftId(w.agentId, alert.story, version), summary: `Démission : ${fact}.`, topicIds: [w.topicId], messages: [{ body: `${fact}.`, sources: [0] }], sources: [{ url: items[0].url, title: "Démission", publisher: items[0].publisher, accessedAt: "2026-01-15", facts: [fact], reservations: [] }], watch: {} });
  w.db.prepare("UPDATE watch_candidate SET status = 'drafted', lane = 'immediate', story_version = ?, data = ? WHERE story_id = ?").run(version, JSON.stringify({ draft: { id: redraft.id, revision: redraft.revision } }), alert.story);
  const publisher = createPublisher({ db: w.db, accounts: w.accounts, sources: w.sources, publications: w.publications, settings: w.settings, now: () => w.clock.now });
  assert.deepEqual(await publisher.attempt(w.agentId, alert.story, "immediate"), { outcome: "abandoned", reason: "Actualité déjà publiée cette semaine." });
  assert.equal(w.publications.agentPublications(w.agentId).length, 1);
});

test("configuration is re-checked at the exact moment: pause, autonomous mode, visibility, public confirmation", { timeout: 60_000 }, async t => {
  const w = await world(t);
  const a = await w.drafted({ title: "Le Conseil d'État annule un décret", fact: "Le Conseil d'État a annulé vendredi le décret sur les horaires d'ouverture" });
  await w.run();
  const slot = w.slot(new Date(w.clock.now));
  // Paused after planning: nothing published.
  await w.policy({ paused: true });
  w.clock.now = slot;
  await w.run();
  assert.equal(w.candidate(a.story).status, "drafted");
  // Autonomous mode off: nothing published.
  await w.policy({ autoPublish: false });
  const publisher = () => createPublisher({ db: w.db, accounts: w.accounts, sources: w.sources, publications: w.publications, settings: w.settings, now: () => w.clock.now });
  assert.match((await publisher().attempt(w.agentId, a.story, "night")).reason, /Mode autonome désactivé/);
  // Public needs its own explicit confirmation, recorded by the server.
  await assert.rejects(w.policy({ visibility: "public" }), /Confirmez explicitement/);
  const confirmed = await w.policy({ visibility: "public" }, true);
  assert.ok(confirmed.publicConfirmedAt);
  assert.ok((await w.policy({ visibility: "public", maxPerDay: 2 })).publicConfirmedAt, "kept while it stays public");
  // Operator flag for public off: deferred, never downgraded to private.
  const deferred = await publisher().attempt(w.agentId, a.story, "night");
  assert.deepEqual([deferred.outcome, /XI_WATCH_AUTOPUBLISH_PUBLIC/.test(deferred.reason)], ["deferred", true]);
  assert.equal((await w.publications.get({ id: "alice" }, a.id)).status, "draft");
  // Paused between the checks and the lock: the guard refuses.
  w.settings.allowPublic = true;
  let calls = 0;
  const racing = { ...w.accounts, watchAgents: async () => {
    const agents = await w.accounts.watchAgents();
    return ++calls === 1 ? agents : agents.map(agent => ({ ...agent, watch: { ...agent.watch, policy: { ...agent.watch.policy, paused: true } } }));
  } } as AccountStore;
  const raced = await createPublisher({ db: w.db, accounts: racing, sources: w.sources, publications: w.publications, settings: w.settings, now: () => w.clock.now }).attempt(w.agentId, a.story, "night");
  assert.deepEqual([raced.outcome, raced.reason], ["deferred", "Veille en pause."]);
  // Everything allowed: published publicly (temporary environment, fictitious content).
  const done = await publisher().attempt(w.agentId, a.story, "night");
  assert.equal(done.outcome, "published");
  const published = await w.publications.get({ id: "bob" }, a.id);
  assert.deepEqual([published.visibility, published.status], ["public", "published"]);
  assert.equal(w.decisions().at(-1)!.visibility, "public");
  // Back to private clears the confirmation; public again requires it again.
  assert.equal((await w.policy({ visibility: "private" })).publicConfirmedAt, null);
  await assert.rejects(w.policy({ visibility: "public" }), /Confirmez explicitement/);
});

test("weekly review: only verified material of real value, one post per subject, never after a recent publication", { timeout: 30_000 }, async t => {
  const w = await world(t, "2026-01-11T03:30:00Z"); // Sunday 04:30 Paris
  const insert = (title: string, importance: number) => {
    const story = randomUUID();
    w.db.prepare("INSERT INTO watch_story (id, owner, title, first_seen_at, last_seen_at, item_count, publisher_count, independent_count, topic_ids, updated_at) VALUES (?, 'alice', ?, ?, ?, 2, 2, 2, ?, ?)").run(story, title, w.clock.now - 2 * DAY, w.clock.now - 2 * DAY, JSON.stringify([w.topicId]), w.clock.now);
    w.db.prepare("INSERT INTO watch_candidate (agent_id, story_id, owner, story_version, status, stage, lane, topic_id, relevance, novelty, novelty_kind, importance, reason, data, prompt_version, created_at, updated_at) VALUES (?, ?, 'alice', 2, 'accepted', 'done', 'weekly', ?, 0.8, 1, 'new', ?, 'Hebdo.', ?, 'veille-3.1', ?, ?)")
      .run(w.agentId, story, w.topicId, importance, JSON.stringify({ title }), w.clock.now - DAY, w.clock.now - DAY);
    return story;
  };
  const job = { id: "w", kind: "weekly-review", key: "w", payload: { agentId: w.agentId }, state: "running" as const, runAfter: 0, attempts: 1, maxAttempts: 3, leaseToken: "t", leaseUntil: 0, lastError: null, result: null, createdAt: 0, updatedAt: 0 };
  const weekly = () => w.handlers()["weekly-review"](job);
  assert.deepEqual(await weekly(), { status: "done", result: { outcome: "no-material" } });
  assert.match(w.decisions()[0].reason, /non produit/);
  const water = insert("Gestion de l'eau : bilan des débats", 0.4);
  const transport = insert("Transports régionaux : nouvelles dessertes", 0.35);
  const trivial = insert("Anecdote de couloir", 0.1);
  assert.deepEqual(await weekly(), { status: "done", result: { outcome: "selected", selected: 2 } });
  const row = (story: string) => w.db.prepare("SELECT lane, status, json_extract(data, '$.weeklySelected') AS weekly FROM watch_candidate WHERE story_id = ?").get(story) as { lane: string; status: string; weekly: number | null };
  assert.deepEqual([row(water), row(transport)].map(r => [r.lane, r.status, r.weekly]), [["night", "accepted", 1], ["night", "accepted", 1]], "each subject becomes its own post");
  assert.deepEqual([row(trivial).lane, row(trivial).weekly], ["weekly", null], "below the value floor: never padded in");
  assert.equal(w.decisions().filter(d => d.outcome === "selected").length, 2);
  // Not Sunday, or a real publication this week: no review.
  w.clock.now += 3 * DAY;
  assert.equal(((await weekly()) as { result: { outcome: string } }).result.outcome, "skipped");
});

test("pre-publication checks: sources, quotes, edits, rejections, newer information, equivalent publication", { timeout: 60_000 }, async t => {
  const w = await world(t);
  const publisher = createPublisher({ db: w.db, accounts: w.accounts, sources: w.sources, publications: w.publications, settings: w.settings, now: () => w.clock.now });
  w.clock.now = w.slot(new Date(w.clock.now));
  // A source failing repeatedly: deferred, kept for later.
  const failing = await w.drafted({ title: "La piscine de Lille ferme", fact: "La mairie de Lille a fermé lundi la piscine municipale" });
  for (const feed of w.feeds) w.db.prepare("INSERT INTO watch_source_state (source_id, next_fetch_at, consecutive_errors) VALUES (?, 0, 3) ON CONFLICT(source_id) DO UPDATE SET consecutive_errors = 3").run(feed.id);
  assert.deepEqual([(await publisher.attempt(w.agentId, failing.story, "night")).outcome, w.candidate(failing.story).status], ["deferred", "drafted"]);
  w.db.prepare("UPDATE watch_source_state SET consecutive_errors = 0").run();
  // A quote that no longer matches its article.
  const altered = await w.drafted({ title: "Le maire de Nantes présente un plan", fact: "Le maire de Nantes a présenté un plan pour les mobilités" });
  w.db.prepare("UPDATE watch_item SET summary = 'Texte corrigé par l’éditeur.' WHERE id = ?").run(altered.items[0].id);
  assert.match((await publisher.attempt(w.agentId, altered.story, "night")).reason, /Citation introuvable/);
  // Owner edited the draft after validation: not published automatically, still approvable by hand.
  const edited = await w.drafted({ title: "Le préfet interdit une manifestation", fact: "Le préfet de police a interdit la manifestation prévue samedi" });
  const current = await w.publications.get({ id: "alice" }, edited.id);
  await reviewDraft({ db: w.db, publications: w.publications, owner: "alice", agentId: w.agentId, draftId: edited.id, format: DEFAULT_FORMAT, input: { action: "update", revision: current.revision, messages: ["Samedi, le préfet de police a interdit la manifestation prévue samedi."] } });
  const editedAttempt = await publisher.attempt(w.agentId, edited.story, "night");
  assert.deepEqual([editedAttempt.outcome, /approbation manuelle/.test(editedAttempt.reason), w.candidate(edited.story).status], ["skipped", true, "held"]);
  assert.equal((await w.publications.get({ id: "alice" }, edited.id)).status, "draft");
  // Rejected by the owner: the candidate is no longer drafted, nothing happens.
  const rejected = await w.drafted({ title: "Le conseil régional vote son budget", fact: "Le conseil régional de Bretagne a voté son budget primitif" });
  await reviewDraft({ db: w.db, publications: w.publications, owner: "alice", agentId: w.agentId, draftId: rejected.id, format: DEFAULT_FORMAT, input: { action: "reject", revision: (await w.publications.get({ id: "alice" }, rejected.id)).revision } });
  assert.equal((await publisher.attempt(w.agentId, rejected.story, "night")).outcome, "skipped");
  w.db.prepare("UPDATE watch_candidate SET status = 'drafted' WHERE story_id = ?").run(rejected.story); // even if the candidate were wrongly re-marked
  const forced = await publisher.attempt(w.agentId, rejected.story, "night");
  assert.deepEqual([forced.outcome, forced.reason], ["skipped", "Brouillon rejeté par le propriétaire."]);
  assert.equal((await w.publications.get({ id: "alice" }, rejected.id)).status, "draft");
  // A source disabled since the draft.
  const disabledSource = await w.drafted({ title: "Le tribunal administratif suspend un arrêté", fact: "Le tribunal administratif de Rennes a suspendu l'arrêté municipal" });
  for (const feed of (await w.sources.list("alice")).sources) await w.sources.decide("alice", feed.id, { action: "disable", revision: feed.revision });
  assert.match((await publisher.attempt(w.agentId, disabledSource.story, "night")).reason, /Source plus approuvée/);
  for (const feed of (await w.sources.list("alice")).sources) await w.sources.decide("alice", feed.id, { action: "approve", revision: feed.revision });
  // Newer information arrived after the draft: re-evaluated instead of published.
  const grown = await w.drafted({ title: "La ministre de la Santé annonce un plan", fact: "La ministre de la Santé a annoncé un plan contre les déserts médicaux" });
  w.db.prepare("UPDATE watch_story SET item_count = item_count + 1 WHERE id = ?").run(grown.story);
  const grownAttempt = await publisher.attempt(w.agentId, grown.story, "night");
  assert.deepEqual([grownAttempt.outcome, w.candidate(grown.story).status], ["abandoned", "accepted"]);
  // Publishable one, then an equivalent one: the second is abandoned.
  const ok = await w.drafted({ title: "Le Parlement européen adopte la directive", fact: "Le Parlement européen a adopté la directive sur le devoir de vigilance des entreprises" });
  assert.equal((await publisher.attempt(w.agentId, ok.story, "night")).outcome, "published");
  w.clock.now += 5 * HOUR;
  // Same news reworded, separate story (no lexical merge), published elsewhere: equivalent.
  const twin = await w.drafted({ title: "Vigilance des entreprises : vote final", fact: "La directive européenne sur la vigilance des entreprises a été votée par le Parlement européen" });
  await w.policy({ minIntervalMinutes: 15 });
  w.clock.now = w.slot(new Date(w.clock.now + DAY - 6 * HOUR));
  assert.match((await publisher.attempt(w.agentId, twin.story, "night")).reason, /équivalente/);
  assert.equal(w.publications.agentPublications(w.agentId).length, 1);
});

test("interruption during publication, concurrent workers, isolation between accounts, DST nights", { timeout: 60_000 }, async t => {
  const w = await world(t);
  await w.policy({ maxPerDay: 1, minIntervalMinutes: 15 });
  w.clock.now = w.slot(new Date(w.clock.now));
  // Crash after the folder is written, before the decision is stored: the retry records it once.
  const a = await w.drafted({ title: "Le gouvernement publie un décret", fact: "Le gouvernement a publié au Journal officiel le décret sur la formation" });
  let crashed = false;
  const crashing = { ...w.publications, publishWatchDraft: (owner: string, agent: string, id: string, options: Parameters<PublicationStore["publishWatchDraft"]>[3]) =>
    w.publications.publishWatchDraft(owner, agent, id, { ...options, record: snapshot => { if (!crashed) { crashed = true; throw new Error("coupure"); } options.record(snapshot); } }) } as PublicationStore;
  const job = { id: "j", kind: "publication-window", key: "j", payload: { agentId: w.agentId }, state: "running" as const, runAfter: 0, attempts: 1, maxAttempts: 3, leaseToken: "t", leaseUntil: 0, lastError: null, result: null, createdAt: 0, updatedAt: 0 };
  await assert.rejects(w.handlers(crashing)["publication-window"](job), /coupure/);
  assert.equal((await w.publications.get({ id: "alice" }, a.id)).status, "published");
  assert.equal(w.decisions().length, 0);
  const restarted = w.store();
  await w.handlers(restarted)["publication-window"](job);
  assert.deepEqual(w.decisions().map(d => d.outcome), ["published"]);
  assert.equal(w.candidate(a.story).status, "published");
  // Two workers at once with two drafts and a ceiling of one: exactly one more publication, the next night.
  const b = await w.drafted({ title: "La Cour des comptes publie son rapport", fact: "La Cour des comptes a publié son rapport annuel sur les finances locales" });
  const c = await w.drafted({ title: "Le Défenseur des droits alerte", fact: "Le Défenseur des droits a alerté sur l'accès aux services publics" });
  w.clock.now = w.slot(new Date(w.clock.now + DAY - 10 * MIN)) + MIN;
  const other = w.store();
  await Promise.all([w.handlers()["publication-window"](job), w.handlers(other)["publication-window"](job)]);
  const statuses = [w.candidate(b.story).status, w.candidate(c.story).status].sort();
  assert.deepEqual(statuses, ["drafted", "published"]);
  assert.equal(w.publications.agentPublications(w.agentId).length, 2);
  assert.equal(w.decisions().filter(d => d.outcome === "published").length, 2);
  // Another account: its agent never publishes alice's drafts, and it cannot use them.
  const bobAgent = await w.agent("bob");
  await w.accounts.setWatchPolicy("bob", bobAgent, { revision: null, policy: { ...DEFAULT_WATCH_POLICY, enabled: true, autoPublish: true } });
  const pending = [b, c].find(x => w.candidate(x.story).status === "drafted")!;
  const result = await w.publications.publishWatchDraft("bob", bobAgent, pending.id, { visibility: "public", revision: "x", details: {}, guard: async () => null, record: () => undefined });
  assert.equal(result.outcome, "missing");
  await w.handlers()["publication-window"]({ ...job, payload: { agentId: bobAgent } });
  assert.equal(w.candidate(pending.story).status, "drafted");
  await assert.rejects(watchDiagnostics({ db: w.db, accounts: w.accounts, sources: w.sources, publications: w.publications, owner: "bob", agentId: w.agentId, autoPublish: true }), /introuvable/);
  const diagnostics = await watchDiagnostics({ db: w.db, accounts: w.accounts, sources: w.sources, publications: w.publications, owner: "alice", agentId: w.agentId, autoPublish: true });
  assert.equal(diagnostics.decisions.filter(d => d.outcome === "published").length, 2);
  assert.equal((await watchDiagnostics({ db: w.db, accounts: w.accounts, sources: w.sources, publications: w.publications, owner: "bob", agentId: bobAgent, autoPublish: true })).decisions.length, 0);
  assert.equal((await readdir(join(w.root, "posts", "_generators", w.agentId))).filter(name => !name.startsWith(".")).length, 3);
});

test("DST: publications land inside 03:00–06:00 Paris on the spring-forward and fall-back nights", { timeout: 60_000 }, async t => {
  for (const [day, start, end] of [["2026-03-28T12:00:00Z", "2026-03-29T01:00:00.000Z", "2026-03-29T04:00:00.000Z"], ["2026-10-24T12:00:00Z", "2026-10-25T02:00:00.000Z", "2026-10-25T05:00:00.000Z"]]) {
    const w = await world(t, day);
    const story = await w.drafted({ title: `Vote au Sénat ${day}`, fact: "Le Sénat a voté la proposition de loi sur le logement étudiant" });
    await w.run();
    const key = (w.db.prepare("SELECT key FROM watch_job WHERE kind = 'publication-window'").get() as { key: string }).key;
    const runAfter = createJobQueue(w.db).get(key)!.runAfter;
    assert.ok(runAfter >= Date.parse(start) && runAfter < Date.parse(end), `${new Date(runAfter).toISOString()} in [${start}, ${end})`);
    w.clock.now = runAfter;
    await w.run();
    const published = w.publications.agentPublications(w.agentId)[0];
    assert.ok(published && published.publishedAt.getTime() >= Date.parse(start) && published.publishedAt.getTime() < Date.parse(end));
    assert.equal(w.candidate(story.story).status, "published");
  }
});

test("format limits re-checked at publication; weekly review can be turned off", { timeout: 30_000 }, async t => {
  const w = await world(t);
  const a = await w.drafted({ title: "Le Conseil constitutionnel valide la loi logement", fact: "Le Conseil constitutionnel a validé mardi la loi sur le logement" });
  // Limits tightened after drafting: the draft is not published, never truncated; held with the reason.
  setOwnerFormat(w.db, "alice", { revision: null, format: { ...DEFAULT_FORMAT, maxPostChars: 50, targetPostMin: 50, targetPostMax: 50 } });
  const refused = await createPublisher({ db: w.db, accounts: w.accounts, sources: w.sources, publications: w.publications, settings: w.settings, now: () => w.clock.now }).attempt(w.agentId, a.story, "night");
  assert.equal(refused.outcome, "abandoned");
  assert.match(refused.reason, /hors des limites de publication actuelles : Message 1 : 65 caractères, au-delà de la limite de 50/);
  assert.deepEqual([w.candidate(a.story).status, (await w.publications.get({ id: "alice" }, a.id)).status], ["held", "draft"]);
  assert.equal(w.publications.agentPublications(w.agentId).length, 0);
  assert.equal(w.decisions().at(-1)!.outcome, "abandoned");

  const sunday = await world(t, "2026-01-11T03:30:00Z");
  await sunday.policy({ weeklyReview: false });
  const job = { id: "w", kind: "weekly-review", key: "w", payload: { agentId: sunday.agentId }, state: "running" as const, runAfter: 0, attempts: 1, maxAttempts: 3, leaseToken: "t", leaseUntil: 0, lastError: null, result: null, createdAt: 0, updatedAt: 0 };
  assert.deepEqual(await sunday.handlers()["weekly-review"](job), { status: "done", result: { outcome: "skipped", reason: "Bilan hebdomadaire désactivé pour ce ΞAgent." } });
});
