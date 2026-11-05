import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_WATCH_POLICY, type WatchPolicy } from "../src/lib/accounts/types";
import type { PublicationStore } from "../src/lib/publications/store";
import { DIFFUSION_KIND } from "../src/lib/watch/orchestrator";
import { DIFFUSION_SPACING } from "../src/lib/watch/publisher";
import { syncEditorialQueue } from "../src/lib/watch/queue";
import { planAgentJobs } from "../src/lib/watch/schedule";
import { HOUR, MIN, world } from "./helpers/publish-world";

type W = Awaited<ReturnType<typeof world>>;
/** 23:00 Paris the evening before, then the night window's opening (03:00 Paris = 02:00 UTC in winter). */
const EVENING = "2026-01-15T22:00:00Z";
const OPENING = Date.parse("2026-01-16T02:00:00Z");
const SAFE: Partial<WatchPolicy> = { maxPerDay: 2, minIntervalMinutes: 15 };

const queueRows = (w: W) => w.db.prepare("SELECT draft_id, agent_id, story_id, state, reason FROM editorial_queue ORDER BY ready_at, draft_id").all() as { draft_id: string; agent_id: string; story_id: string; state: string; reason: string | null }[];
const stateOf = (w: W, draftId: string) => queueRows(w).find(row => row.draft_id === draftId)?.state;
const publishedBy = (w: W) => (w.db.prepare("SELECT agent_id FROM watch_decision WHERE outcome = 'published' ORDER BY at, rowid").all() as { agent_id: string }[]).map(row => row.agent_id);
const jobsOf = (w: W, kind: string) => (w.db.prepare("SELECT count(*) AS n FROM watch_job WHERE kind = ?").get(kind) as { n: number }).n;
async function agentWith(w: W, changes: Partial<WatchPolicy>) {
  const id = await w.agent("alice");
  await w.accounts.setWatchPolicy("alice", id, { revision: null, policy: { ...DEFAULT_WATCH_POLICY, enabled: true, autoPublish: true, ...changes } });
  return id;
}

test("several agents, the same window: prepared the evening before, then a natural selection with diversity, ceilings and intervals as limits only", { timeout: 60_000 }, async t => {
  const w = await world(t, EVENING, { diffusion: "queue" });
  await w.policy(SAFE);
  const b = await agentWith(w, SAFE);
  const c = await agentWith(w, SAFE);
  const a1 = await w.drafted({ title: "Le Sénat adopte la loi sur l'eau", fact: "Le Sénat a adopté mardi la loi sur la gestion de l'eau", importance: 0.95 });
  const a2 = await w.drafted({ title: "Le budget de la culture augmente", fact: "Le ministère de la Culture disposera de crédits accrus en 2027", importance: 0.9 });
  const a3 = await w.drafted({ title: "Nouvelle ligne de tramway à Brest", fact: "La métropole de Brest inaugure une seconde ligne de tramway", importance: 0.85 });
  const b1 = await w.drafted({ title: "La Cour des comptes publie son rapport", fact: "La Cour des comptes a publié son rapport annuel sur les finances locales", importance: 0.7, agent: b });
  const c1 = await w.drafted({ title: "Le Défenseur des droits alerte", fact: "Le Défenseur des droits a alerté sur l'accès aux services publics", importance: 0.65, agent: c });
  // 23:00: prepared contents wait in the queue; no per-agent window job exists any more.
  await w.run();
  assert.deepEqual(queueRows(w).map(row => row.state), Array(5).fill("ready"));
  assert.equal(jobsOf(w, "publication-window"), 0);
  assert.deepEqual(publishedBy(w), []);
  for (const agent of await w.accounts.watchAgents()) assert.deepEqual(planAgentJobs(agent, new Date(w.clock.now), { queue: true }), [], "no slot planned outside Sundays");
  // From the opening, one publication per round, the agent that just published passing after the others.
  for (let round = 0; round < 5; round++) { w.clock.now = OPENING + round * DIFFUSION_SPACING; await w.run(); }
  assert.deepEqual(publishedBy(w), [w.agentId, b, w.agentId, c], "A, then B (diversity), A again, then C");
  assert.deepEqual([a1, a2, b1, c1].map(item => stateOf(w, item.id)), ["published", "published", "published", "published"]);
  // A's ceiling (2 a day) is a limit, not a quota: its third content waits, the feed stays silent.
  assert.equal(stateOf(w, a3.id), "ready");
  const times = (w.db.prepare("SELECT at FROM watch_decision WHERE outcome = 'published' ORDER BY at").all() as { at: number }[]).map(row => row.at - OPENING);
  assert.deepEqual(times, [0, 1, 2, 3].map(i => i * DIFFUSION_SPACING), "publication instants follow the queue, not agent slots");
  // The same round run twice (another worker): nothing more.
  await w.run();
  assert.equal(publishedBy(w).length, 4);
});

test("nothing ready: no diffusion, no publication, whatever the open window", { timeout: 60_000 }, async t => {
  const w = await world(t, EVENING, { diffusion: "queue" });
  await w.policy(SAFE);
  w.clock.now = OPENING;
  const pass = await w.run();
  assert.deepEqual([jobsOf(w, DIFFUSION_KIND), jobsOf(w, "publication-window"), publishedBy(w).length, pass.planned], [0, 0, 0, 0]);
  // A content below the agent's threshold is not worth a publication either.
  await w.drafted({ title: "Une vidéo virale d'un député", fact: "La vidéo d'un député a été vue des millions de fois", importance: 0.3 });
  await w.run();
  assert.deepEqual(publishedBy(w), []);
});

test("obsolete contents leave the queue; prepared contents wait for their window", { timeout: 60_000 }, async t => {
  const w = await world(t, EVENING, { diffusion: "queue" });
  await w.policy(SAFE);
  const old = await w.drafted({ title: "Accord trouvé sur les retraites", fact: "Les partenaires sociaux ont conclu un accord sur les retraites anticipées", hoursAgo: 35 });
  const fresh = await w.drafted({ title: "Le Sénat adopte la loi sur l'eau", fact: "Le Sénat a adopté mardi la loi sur la gestion de l'eau" });
  await w.run();
  assert.deepEqual([stateOf(w, old.id), stateOf(w, fresh.id)], ["ready", "ready"]);
  // Past 36 h, outside any window: withdrawn as expired, draft retired, the reason traced.
  w.clock.now += 2 * HOUR;
  await w.run();
  assert.equal(stateOf(w, old.id), "expired");
  assert.equal(w.candidate(old.story).status, "rejected");
  assert.equal((await w.publications.get({ id: "alice" }, old.id)).status, "draft");
  assert.match(w.decisions().find(d => d.story_id === old.story)!.reason, /retirée de la queue éditoriale/);
  w.clock.now = OPENING;
  await w.run();
  assert.deepEqual([stateOf(w, fresh.id), publishedBy(w).length], ["published", 1]);
});

test("@arbitre in the queue era: accepted alert goes first, refused one waits in the queue, in-calendar alerts are diffused", { timeout: 60_000 }, async t => {
  const w = await world(t, "2026-01-15T12:00:00Z", { diffusion: "queue" });
  await w.policy({ ...SAFE, maxPerDay: 3, maxImmediatePerDay: 2 });
  const accepted = await w.drafted({ title: "Le Premier ministre démissionne", fact: "Le Premier ministre a présenté jeudi la démission de son gouvernement", importance: 0.95, lane: "immediate" });
  w.clock.now = Date.parse("2026-01-15T14:00:00Z");
  await w.run();
  assert.equal(stateOf(w, accepted.id), "published", "favorable: published at once, outside the window, all checks done");
  assert.equal(w.decisions().find(d => d.outcome === "published")!.lane, "immediate");
  w.arbiter.answer = () => JSON.stringify({ priority: false, justification: "Rien ne presse.", criteria: ["Pas d’urgence"] });
  const refused = await w.drafted({ title: "Dissolution de l'Assemblée annoncée", fact: "Le président de la République a annoncé la dissolution de l'Assemblée nationale", importance: 0.93, lane: "immediate" });
  w.clock.now += 20 * MIN;
  await w.run();
  assert.deepEqual([stateOf(w, refused.id), w.candidate(refused.story).lane, publishedBy(w).length], ["ready", "night", 1]);
  // Next window: the diffuser publishes it, once.
  w.clock.now = OPENING;
  await w.run();
  w.clock.now += DIFFUSION_SPACING;
  await w.run();
  assert.deepEqual([stateOf(w, refused.id), publishedBy(w).length], ["published", 2]);
  // An alert inside the calendar: no arbitration, the diffuser takes it.
  const inside = await w.drafted({ title: "Le Conseil d'État annule un décret", fact: "Le Conseil d'État a annulé vendredi le décret sur les horaires d'ouverture", importance: 0.95, lane: "immediate" });
  w.clock.now += 20 * MIN;
  const calls = w.arbiter.requests.length;
  await w.run();
  assert.deepEqual([stateOf(w, inside.id), w.arbiter.requests.length], ["published", calls]);
  assert.equal(w.decisions().filter(d => d.outcome === "published").at(-1)!.lane, "night");
});

test("crash during publication and concurrent workers: one diffuser at a time, one publication per content", { timeout: 60_000 }, async t => {
  const w = await world(t, EVENING, { diffusion: "queue" });
  await w.policy(SAFE);
  const b = await agentWith(w, SAFE);
  const a = await w.drafted({ title: "Le gouvernement publie un décret", fact: "Le gouvernement a publié au Journal officiel le décret sur la formation", importance: 0.9 });
  const other = await w.drafted({ title: "La Cour des comptes publie son rapport", fact: "La Cour des comptes a publié son rapport annuel sur les finances locales", importance: 0.8, agent: b });
  await w.run();
  w.clock.now = OPENING;
  let crashed = false;
  const crashing = { ...w.publications, publishWatchDraft: (owner: string, agent: string, id: string, options: Parameters<PublicationStore["publishWatchDraft"]>[3]) =>
    w.publications.publishWatchDraft(owner, agent, id, { ...options, record: snapshot => { if (!crashed) { crashed = true; throw new Error("coupure"); } options.record(snapshot); } }) } as PublicationStore;
  await w.run(w.handlers(crashing));
  assert.equal((await w.publications.get({ id: "alice" }, a.id)).status, "published", "written before the crash");
  // Restart: the interruption is recognised, recorded once; then two workers at once publish only one more.
  w.clock.now += MIN;
  await w.run(w.handlers(w.store()));
  assert.deepEqual(publishedBy(w), [w.agentId], "recorded first; B waits for the pace instead of following within a minute");
  assert.equal(stateOf(w, a.id), "published");
  // The pace counts the recovered publication from its recording.
  w.clock.now = OPENING + MIN + DIFFUSION_SPACING;
  await Promise.all([w.run(w.handlers()), w.run(w.handlers(w.store()))]);
  await w.run();
  assert.deepEqual([publishedBy(w).sort(), stateOf(w, other.id)], [[w.agentId, b].sort(), "published"]);
  assert.equal((w.db.prepare("SELECT count(*) AS n FROM watch_decision WHERE outcome = 'published'").get() as { n: number }).n, 2);
});

test("migration: drafts prepared under the legacy windows join the queue unpublished; never two diffusers on one draft; rollback", { timeout: 60_000 }, async t => {
  const w = await world(t, EVENING);
  await w.policy(SAFE);
  const a = await w.drafted({ title: "Le Sénat adopte la loi sur l'eau", fact: "Le Sénat a adopté mardi la loi sur la gestion de l'eau", importance: 0.9 });
  // Legacy pass: a per-agent window job is planned for the night.
  await w.run();
  assert.equal(jobsOf(w, "publication-window"), 1);
  assert.equal(stateOf(w, a.id), "ready", "the queue follows the candidates in legacy mode too");
  // Switch to the queue before the night: nothing is published by the migration itself.
  w.settings.diffusion = "queue";
  await w.run();
  assert.deepEqual([publishedBy(w), jobsOf(w, "publication-window")], [[], 1]);
  // At the window both the old window job and the diffuser are due: one publication only.
  w.clock.now = OPENING + 3 * HOUR - 30 * MIN; // past the legacy slot, still inside 03:00–06:00
  const pass = await w.run();
  assert.equal(publishedBy(w).length, 1);
  assert.equal(stateOf(w, a.id), "published");
  const legacy = w.db.prepare("SELECT result FROM watch_job WHERE kind = 'publication-window'").get() as { result: string };
  assert.match(legacy.result, /remplacé par la queue éditoriale/);
  assert.ok(pass.done >= 2);
  // Rollback: the legacy windows publish again, the diffuser is no longer planned, the queue stays current.
  w.settings.diffusion = "legacy";
  const next = await w.drafted({ title: "Le budget de la culture augmente", fact: "Le ministère de la Culture disposera de crédits accrus en 2027", importance: 0.9 });
  w.clock.now = w.slot(new Date(OPENING + 24 * HOUR - 4 * HOUR));
  const before = jobsOf(w, DIFFUSION_KIND);
  await w.run();
  assert.equal(jobsOf(w, DIFFUSION_KIND), before);
  assert.deepEqual([stateOf(w, next.id), publishedBy(w).length], ["published", 2]);
});

test("existing checks hold in the queue: sources, pause, operator flags, public visibility", { timeout: 60_000 }, async t => {
  const w = await world(t, EVENING, { diffusion: "queue" });
  await w.policy(SAFE);
  const gone = await w.drafted({ title: "Le Sénat adopte la loi sur l'eau", fact: "Le Sénat a adopté mardi la loi sur la gestion de l'eau", importance: 0.95 });
  w.db.prepare("DELETE FROM watch_item WHERE url = ?").run(gone.items[0].url);
  await w.run();
  w.clock.now = OPENING;
  w.settings.autoPublish = false;
  await w.run();
  assert.deepEqual([publishedBy(w), stateOf(w, gone.id)], [[], "ready"], "XI_WATCH_AUTOPUBLISH off: contents wait");
  w.settings.autoPublish = true;
  await w.policy({ ...SAFE, paused: true });
  await w.run();
  assert.deepEqual([publishedBy(w), stateOf(w, gone.id)], [[], "ready"], "a paused agent is not eligible");
  await w.policy({ ...SAFE, visibility: "public" }, true);
  await w.run();
  assert.match(w.decisions().at(-1)!.reason, /XI_WATCH_AUTOPUBLISH_PUBLIC/);
  assert.equal(stateOf(w, gone.id), "ready");
  await w.policy(SAFE);
  w.clock.now += DIFFUSION_SPACING;
  await w.run();
  // The source article is gone: abandoned by the publication checks, withdrawn from the queue.
  assert.deepEqual([publishedBy(w), stateOf(w, gone.id)], [[], "withdrawn"]);
  assert.match(queueRows(w)[0].reason!, /Article source expiré/);
  // A sync alone never publishes.
  syncEditorialQueue(w.db, w.clock.now);
  assert.equal(publishedBy(w).length, 0);
});

test("@arbitre-approved alert just after a diffusion: not held by the diffuser's pace, published once", { timeout: 60_000 }, async t => {
  const w = await world(t, EVENING, { diffusion: "queue" });
  await w.policy(SAFE);
  const b = await agentWith(w, SAFE);
  const ordinary = await w.drafted({ title: "Le Sénat adopte la loi sur l'eau", fact: "Le Sénat a adopté mardi la loi sur la gestion de l'eau", importance: 0.9 });
  await w.run();
  w.clock.now = OPENING + 3 * HOUR - 2 * MIN; // 05:58 Paris, the window closes at 06:00
  await w.run();
  assert.equal(stateOf(w, ordinary.id), "published");
  const alert = await w.drafted({ title: "Le Premier ministre démissionne", fact: "Le Premier ministre a présenté jeudi la démission de son gouvernement", importance: 0.95, lane: "immediate", agent: b });
  w.clock.now = OPENING + 3 * HOUR + MIN; // 06:01: off-hours (the diffuser's grace never covers an alert)
  await w.run();
  assert.equal(stateOf(w, alert.id), "published", "favorable decision: published at once");
  const times = w.db.prepare("SELECT agent_id, lane, at FROM watch_decision WHERE outcome = 'published' ORDER BY at").all() as { agent_id: string; lane: string; at: number }[];
  assert.deepEqual(times.map(row => [row.agent_id, row.lane]), [[w.agentId, "night"], [b, "immediate"]]);
  assert.ok(times[1].at - times[0].at < DIFFUSION_SPACING, "3 minutes later, not after the 10-minute pace");
  assert.equal(w.arbiter.requests.length, 1);
  w.clock.now += DIFFUSION_SPACING;
  await w.run();
  assert.equal(publishedBy(w).length, 2, "no second publication by the other circuit");
});

test("an alert inside the calendar wakes a diffusion waiting for its pace, ordinary contents keep the pace", { timeout: 60_000 }, async t => {
  const w = await world(t, EVENING, { diffusion: "queue" });
  await w.policy({ maxPerDay: 3, minIntervalMinutes: 15 });
  const b = await agentWith(w, SAFE);
  const first = await w.drafted({ title: "Le Sénat adopte la loi sur l'eau", fact: "Le Sénat a adopté mardi la loi sur la gestion de l'eau", importance: 0.9 });
  const second = await w.drafted({ title: "Le budget de la culture augmente", fact: "Le ministère de la Culture disposera de crédits accrus en 2027", importance: 0.85, agent: b });
  await w.run();
  w.clock.now = OPENING;
  await w.run();
  assert.deepEqual([stateOf(w, first.id), stateOf(w, second.id)], ["published", "ready"]);
  const waiting = w.db.prepare("SELECT run_after FROM watch_job WHERE kind = ? AND state = 'pending'").get(DIFFUSION_KIND) as { run_after: number };
  assert.equal(waiting.run_after, OPENING + DIFFUSION_SPACING);
  const alert = await w.drafted({ title: "Le Conseil d'État annule un décret", fact: "Le Conseil d'État a annulé vendredi le décret sur les horaires d'ouverture", importance: 0.95, lane: "immediate", agent: b });
  w.clock.now = OPENING + 2 * MIN;
  await w.run();
  assert.deepEqual([stateOf(w, alert.id), stateOf(w, second.id)], ["published", "ready"], "the alert now, the ordinary content still paced");
  assert.equal(w.arbiter.requests.length, 0, "inside the calendar: no arbitration");
  // B's own minimum interval (15 min after its alert) is a safety limit, still applied.
  w.clock.now = OPENING + 2 * MIN + DIFFUSION_SPACING;
  await w.run();
  assert.equal(stateOf(w, second.id), "ready");
  w.clock.now = OPENING + 17 * MIN;
  await w.run();
  assert.equal(stateOf(w, second.id), "published");
  assert.equal(publishedBy(w).length, 3);
});
