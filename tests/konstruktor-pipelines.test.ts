import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { openVault } from "../src/lib/publications/vault";
import { createPublicationStore } from "../src/lib/publications/store";
import { createTopicStore } from "../src/lib/topics/store";
import { createTopicRelationStore } from "../src/lib/topics/relations";
import { createAccountStore } from "../src/lib/accounts/store";
import { createJobQueue, type Job } from "../src/lib/watch/jobs";
import { drainJobs } from "../src/lib/watch/worker";
import { admit, startRun, SYSTEM_TASK_KIND } from "../src/lib/watch/orchestrator";
import { systemTaskHandler } from "../src/lib/system-agents/tasks";
import { createKnowledgePipelines } from "../src/lib/konstruktor/pipelines";

/**
 * Pipelines on the real engine: the system-task queue, drainJobs with its run history, the system-task handler
 * and Konstruktor's `publication-knowledge` task. A fake clock drives retries and expired leases.
 */
async function setup(t: { after: (fn: () => Promise<void>) => void }) {
  const path = await mkdtemp(join(tmpdir(), "xi-pipelines-"));
  const db = new Database(":memory:");
  t.after(async () => { db.close(); await rm(path, { recursive: true, force: true }); });
  let clock = Date.parse("2026-11-13T09:00:00Z");
  const now = () => clock;
  const vault = await openVault(path), topics = createTopicStore({ vault, db });
  const accounts = createAccountStore({ vault, db, topics });
  const publications = createPublicationStore({ vault, db });
  const relations = createTopicRelationStore({ vault, db, topics, readable: publications.readableIds });
  const agentOf = async (owner: string, name: string) => {
    const run = await topics.propose(owner, `Espace ${name}`);
    await topics.confirm(owner, run.id, { tag: name.toLowerCase(), name, description: "", scope: "Espace", parentId: null, relatedIds: [] }, true);
    const proposal = await accounts.propose(owner, run.topicId), ready = await accounts.resume(owner, proposal.id);
    await accounts.confirm(owner, ready.id, ready.draft, true);
    return { id: ready.accountId, topic: run.topicId };
  };
  const alice = await agentOf("alice", "Propulsion"), other = await agentOf("alice", "Orbites"), bob = await agentOf("bob", "Fusees");
  const publish = async (agent: { id: string; topic: string }, text: string, owner = "alice") => {
    const id = randomUUID();
    const draft = await publications.saveWatchDraft(owner, agent.id, { id, summary: text, topicIds: [agent.topic], messages: [{ body: text, sources: [0] }], sources: [{ url: "https://agence.example/a", title: "Agence", publisher: "Agence", accessedAt: "2026-11-01", facts: [text], reservations: [] }], watch: {} });
    const result = await publications.reviewWatchDraft({ id: owner }, agent.id, id, { action: "approve", revision: draft.revision });
    assert.ok(result.ok);
    return id;
  };
  const p1 = await publish(alice, "Asterion-47 utilise le moteur Helios-9.");
  const p2 = await publish(alice, "Orion-12 observe la région Tinga.");
  const p3 = await publish(alice, "PANNE : Vega-2 utilise le moteur Kappa-5.");
  await publications.publishGenerated({ id: "alice" }, alice.id, { id: randomUUID(), summary: "Fixture", messages: ["Contenu de démonstration."], topicIds: [alice.topic] });
  await publish(other, "Zeta-3 utilise le moteur Rho-1.");
  await publish(bob, "Lyra-8 utilise le moteur Sigma-4.", "bob");

  const state = { broken: true, calls: 0 };
  // The local model: it fails on « PANNE » while `broken`, else names the two concepts and their explicit relation.
  const inference = { complete: async ({ prompt }: { prompt: string }) => {
    state.calls++;
    const sentence = prompt.replace(/^Texte :\n/, "").split("\n").find(line => /utilise|observe/.test(line))!;
    if (sentence.includes("PANNE") && state.broken) throw new Error("Modèle local en panne.");
    const [from, , ...rest] = sentence.replace("PANNE : ", "").replace(/\.$/, "").split(" ");
    const to = rest.at(-1)!;
    return JSON.stringify({ concepts: [{ label: from, quote: sentence }, { label: to, quote: sentence }], relations: [{ from, to, type: "related_to", quote: sentence, justification: "La publication affirme explicitement ce lien entre les deux.", confidence: 0.8 }] });
  } };
  const binding = { ok: true as const, resolved: { model: "local-test" }, inference };
  const systemAgents = { enabled: true, get: async () => ({ id: "konstruktor", enabled: systemAgents.enabled }) };
  const queue = createJobQueue(db, now);
  const handlers = { [SYSTEM_TASK_KIND]: systemTaskHandler({ store: systemAgents as never, llm: () => binding as never, services: { db, accounts, topics, publications, relations, agentLLM: () => binding as never }, now }) };
  const control = { db, admit: async (job: Job) => admit(job, undefined, new Map(), now()), owner: async (job: Job) => (job.payload as { owner: string }).owner };
  /** Worker passes until the queue is idle, the clock jumping past retry delays in between. */
  const drain = async () => { for (let pass = 0; pass < 12; pass++) { await drainJobs({ queue, handlers, clock: now, control, maxJobs: 50 }); clock += 10 * 60_000; } };
  const pipelines = () => createKnowledgePipelines({ db, accounts, publications, systemAgents: systemAgents as never, queue, now });
  return { db, queue, now, tick: (ms: number) => { clock += ms; }, topics, relations, publications, alice, other, bob, p1, p2, p3, state, systemAgents, drain, pipelines };
}

test("pipeline manuel : progression persistante, échecs, relance ciblée et réanalyse forcée sans perte de décisions", async t => {
  const env = await setup(t);
  const pipelines = env.pipelines();
  const started = await pipelines.start("alice", { agent: env.alice.id, mode: "missing" });
  assert.ok(started);
  const first = started.run;
  assert.equal(first.number, 1);
  assert.equal(first.trigger, "manual");
  assert.equal(first.status, "queued");
  assert.deepEqual(first.progress, { done: 1, total: 4 }, "le contenu de test compte comme ignoré dès la planification");
  assert.equal(first.jobs.find(job => job.status === "skipped")?.reason, "Contenu de test exclu.");

  await env.drain();
  // A new instance reads only SQLite: what a reload or a restarted server shows.
  let run = env.pipelines().get("alice", first.id);
  assert.equal(run.status, "partial");
  assert.deepEqual(run.counts, { queued: 0, running: 0, success: 2, failed: 1, skipped: 1, cancelled: 0 });
  assert.deepEqual(run.progress, { done: 4, total: 4 });
  assert.ok(run.startedAt && run.finishedAt && run.durationMs !== null && run.finishedAt >= run.startedAt);
  assert.deepEqual(run.stages.map(stage => [stage.name, stage.status]), [["Planification", "success"], ["Analyse Konstruktor", "partial"], ["Bilan", "partial"]]);
  const success = run.jobs.find(job => job.publication === env.p1)!;
  assert.equal(success.status, "success");
  assert.deepEqual(success.result, { outcome: "done", concepts: 2, reused: 0, created: 2, ignored: 0, relations: 1, kept: 0 });
  const logs = success.attempts.flatMap(attempt => attempt.logs.map(log => log.message));
  for (const expected of [/Analyse de la publication/, /Concept « Asterion-47 » : topic #asterion-47/, /Relation Asterion-47 → Helios-9 \(related_to\) proposée/, /Terminé : 2 concepts/]) assert.ok(logs.some(line => expected.test(line)), `log ${expected}`);
  const failed = run.jobs.find(job => job.publication === env.p3)!;
  assert.equal(failed.status, "failed");
  assert.equal(failed.attempts.length, 3, "trois tentatives du moteur, chacune journalisée");
  assert.ok(failed.attempts.every(attempt => attempt.status !== "running"));
  assert.match(failed.reason ?? "", /Modèle local en panne/);

  // The worker plans other agents' new work, but never retries this failure on its own.
  await pipelines.planAutomatic();
  assert.equal(pipelines.list("alice", { agent: env.alice.id }).length, 1, "aucun run automatique pour un échec");
  await env.drain();

  // Targeted retry: only the failed publication runs again; its earlier attempts remain in its history.
  env.state.broken = false;
  const calls = env.state.calls;
  run = pipelines.retry("alice", first.id);
  assert.equal(run.status, "running");
  assert.equal(run.jobs.find(job => job.publication === env.p3)!.status, "queued");
  await env.drain();
  run = pipelines.get("alice", first.id);
  assert.equal(run.status, "success");
  assert.equal(env.state.calls - calls, 1, "seule la publication en échec est réanalysée");
  assert.equal(run.jobs.find(job => job.publication === env.p3)!.attempts.length, 4);
  assert.throws(() => pipelines.retry("alice", first.id), /Aucun job en échec/);

  // Missing only: nothing left to analyse at these revisions.
  const missing = (await pipelines.start("alice", { agent: env.alice.id, mode: "missing" }))!;
  assert.equal(missing.enqueued, 0);
  assert.equal(missing.run.status, "success");
  assert.ok(missing.run.jobs.every(job => job.status === "skipped"));

  // Forced re-analysis: a human exclusion and topic deduplication survive it.
  const asterion = (await env.topics.visible("alice")).personal.find(topic => topic.tag === "asterion-47")!;
  const [proposal] = (await env.relations.relationsOf("alice", asterion.id)).proposed;
  await env.relations.correct("alice", proposal.id, { status: "excluded", reason: "Non pertinent." });
  const topicCount = (await env.topics.visible("alice")).personal.length;
  const forced = (await pipelines.start("alice", { agent: env.alice.id, mode: "force" }))!;
  assert.equal(forced.enqueued, 3);
  await env.drain();
  run = pipelines.get("alice", forced.run.id);
  assert.equal(run.status, "success");
  assert.equal(run.number, 4, "numérotation par propriétaire : le run automatique d’Orbites a pris le n° 2");
  assert.equal((await env.topics.visible("alice")).personal.length, topicCount, "aucun topic dupliqué");
  const view = await env.relations.relationsOf("alice", asterion.id);
  assert.equal(view.proposed.length, 0);
  assert.equal(view.excluded.length, 1);
  assert.ok(run.jobs.find(job => job.publication === env.p1)!.attempts.flatMap(attempt => attempt.logs).some(log => /non reproposée : exclue ou corrigée/.test(log.message)));

  // History: newest first, filterable by agent.
  assert.deepEqual(pipelines.list("alice", { agent: env.alice.id }).map(item => item.number), [4, 3, 1]);
  assert.deepEqual(pipelines.list("alice", { agent: env.other.id }).map(item => [item.number, item.trigger, item.status]), [[2, "automatic", "success"]]);
});

test("redémarrage pendant un traitement : tentative interrompue explicite puis reprise", async t => {
  const env = await setup(t);
  env.state.broken = false;
  const { run } = (await env.pipelines().start("alice", { agent: env.alice.id, mode: "missing" }))!;
  // A process claims a job, records its attempt, then dies before finishing.
  const job = env.queue.claim([SYSTEM_TASK_KIND], 60_000)!;
  startRun(env.db, { id: `${job.id}:${job.attempts}`, jobId: job.id, agentId: "konstruktor", owner: "alice", kind: job.kind, trigger: "manual", attempt: job.attempts, maxAttempts: job.maxAttempts }, env.now());
  assert.equal(env.pipelines().get("alice", run.id).status, "running");
  env.tick(2 * 60_000);
  const stalled = env.pipelines().get("alice", run.id);
  const interrupted = stalled.jobs.find(item => item.status === "interrupted");
  assert.ok(interrupted, "le bail expiré est affiché comme interrompu");
  await env.drain();
  const resumed = env.pipelines().get("alice", run.id);
  assert.equal(resumed.status, "success");
  const attempts = resumed.jobs.find(item => item.publication === interrupted.publication)!.attempts;
  assert.deepEqual(attempts.map(attempt => attempt.status), ["interrupted", "done"]);
  assert.ok(attempts[0].finishedAt !== null && attempts[0].logs.some(log => /interrompue/.test(log.message)));
});

test("concurrence entre runs, planification automatique, annulation, désactivation", async t => {
  const env = await setup(t);
  env.state.broken = false;
  const pipelines = env.pipelines(), other = env.pipelines();
  // Two simultaneous requests (two tabs, two processes): exactly one run.
  const raced = await Promise.allSettled([pipelines.start("alice", { agent: env.alice.id, mode: "force" }), other.start("alice", { agent: env.alice.id, mode: "force" })]);
  assert.equal(raced.filter(item => item.status === "fulfilled").length, 1);
  assert.match(String((raced.find(item => item.status === "rejected") as PromiseRejectedResult).reason), /déjà en cours/);
  // Another agent is independent; the worker's automatic planning skips the busy agent.
  const parallel = (await pipelines.start("alice", { agent: env.other.id, mode: "missing" }))!;
  assert.equal(parallel.enqueued, 1);
  assert.equal(await pipelines.planAutomatic(), 1, "seul l’agent de Bob a du travail nouveau");
  assert.deepEqual(pipelines.list("bob").map(run => run.trigger), ["automatic"]);
  assert.equal(await pipelines.planAutomatic(), 0, "aucun run vide ni doublon");

  // Cancelling withdraws queued jobs; the worker never runs them.
  const active = (raced.find(item => item.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof pipelines.start>>>).value!.run;
  const cancelled = pipelines.cancel("alice", active.id);
  assert.equal(cancelled.status, "cancelled");
  const calls = env.state.calls;
  await env.drain();
  assert.equal(env.state.calls - calls, 2, "seuls les runs non annulés (Orbites, Bob) s’exécutent");
  assert.equal(pipelines.get("alice", active.id).status, "cancelled");
  assert.equal(pipelines.get("alice", parallel.run.id).status, "success");

  env.systemAgents.enabled = false;
  await assert.rejects(pipelines.start("alice", { agent: env.alice.id, mode: "missing" }), /désactivé/);
  assert.equal(await pipelines.planAutomatic(), 0);
});

test("isolation : un autre utilisateur ne voit, ne lance ni ne modifie aucun run, extrait ou log", async t => {
  const env = await setup(t);
  env.state.broken = false;
  const pipelines = env.pipelines();
  const { run } = (await pipelines.start("alice", { agent: env.alice.id, mode: "missing" }))!;
  await env.drain();
  assert.deepEqual(pipelines.list("bob"), []);
  assert.throws(() => pipelines.get("bob", run.id), /introuvable/);
  assert.throws(() => pipelines.retry("bob", run.id), /introuvable/);
  assert.throws(() => pipelines.cancel("bob", run.id), /introuvable/);
  assert.throws(() => pipelines.get("alice", "pas-un-uuid"), /introuvable/);
  await assert.rejects(pipelines.start("bob", { agent: env.alice.id, mode: "force" }), /ΞAgent introuvable/);
  await assert.rejects(pipelines.start("alice", { agent: env.alice.id, mode: "tout" }));
  // Even the shared queue's history is owner-scoped: Bob's view of Alice's job ids is empty.
  const { jobRuns } = await import("../src/lib/watch/orchestrator");
  const jobIds = (env.db.prepare("SELECT id FROM watch_job").all() as { id: string }[]).map(row => row.id);
  assert.ok(jobIds.length > 0);
  assert.ok(jobIds.every(id => jobRuns(env.db, "bob", id).length === 0));
  assert.equal((await env.topics.visible("bob")).personal.length, 0);
});
