import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { DEFAULT_WATCH_POLICY } from "../src/lib/accounts/types";
import { acceptedIds, previewDraft, previewTopic, selectAll } from "../src/lib/konstruktor/preview";
import type { KonstruktorTarget, Proposal } from "../src/lib/konstruktor/types";
import type { ChatRequest } from "../src/lib/watch/inference";
import { draftToSpec, newDraft, type AgentDraft, type DraftPatch } from "../src/lib/xiagents/draft";
import { draftToEditSpec, topicEditSpec } from "../src/lib/xiagents/edit";
import { publishOpen, watchOpen } from "../src/lib/xiagents/schedule";
import { files, INSTANCE_ID, json, model, seed, setup } from "./helpers/konstruktor";

type App = Awaited<ReturnType<typeof setup>>;
/** One conversation turn, drained to its end. */
async function turn(app: App, owner: string, sessionId: string, text: string) {
  await app.konstruktor.send(owner, sessionId, { requestId: randomUUID(), text });
  await app.tasks.close();
  return app.konstruktor.view(owner, sessionId);
}
async function open(app: App, owner: string, target: KonstruktorTarget) {
  const id = randomUUID();
  await app.konstruktor.open(owner, { id, target });
  return id;
}
const proposalsOf = async (app: App, owner: string, id: string) => (await app.konstruktor.view(owner, id)).history.flatMap(message => message.proposals);
/** The topic labelled `tag` in the catalogue the prompt shows (T#). */
const label = (request: ChatRequest, tag: string) => {
  const data = JSON.parse(/<donnees>\n([\s\S]*)\n<\/donnees>/.exec(request.prompt)![1]) as { topics: { ref: string; tag: string }[] };
  return data.topics.find(topic => topic.tag === tag)!.ref;
};
const paris = (iso: string) => Date.parse(`${iso}+01:00`);

test("konstruktor L5: « robotique humanoïde de 22 h à 2 h, prête avant 3 h, publie la nuit » → proposals, preview, validation, real agent; nothing written before", { timeout: 30_000 }, async t => {
  const { binding, requests } = model(request => json({
    reply: "Voici un ΞAgent nocturne : veille de 22 h à 2 h, une heure de tolérance pour finir les brouillons avant 3 h, publication de 2 h à 6 h uniquement pour les actualités jugées pertinentes.",
    questions: ["Quelles sources suivez-vous déjà ?"],
    unsupported: ["Plage de préparation distincte : elle suit la fin de la veille plus la tolérance.", "Publication sur les réseaux sociaux."],
    proposal: {
      summary: "Créer @veille-humanoides", name: "Veille humanoïdes", handle: "Veille-Humanoides", description: "Robotique humanoïde : recherche, industrie, démonstrations.",
      perimeter: "Robots humanoïdes : locomotion, manipulation, IA incarnée.", charter: "Distinguer démonstrations et produits.",
      topics: [{ existing: null, name: "Robotique humanoïde", tag: "humanoide", scope: "Robots humanoïdes et leurs usages.", parent: label(request, "robotique") }, { existing: "T99" }],
      style: { depth: "approfondi" },
      sources: [{ url: "https://robots.example.org/feed.xml", rationale: "Flux spécialisé." }, { url: "javascript:alert(1)" }],
      schedule: { timeZone: "Europe/Paris", watch: { ranges: [{ from: "22:00", to: "02:00" }] }, publish: { ranges: [{ from: "02:00", to: "06:00" }] }, graceMinutes: 60 },
      publication: { autoPublish: true, maxPerDay: 2, minIntervalMinutes: 60 },
      model: { instance: "I1", model: "mistral-small" },
      avatar: { shape: "hexagone", expression: "curieux", color: "turquoise" },
      visibility: "public", owner: "bob",
    },
  }));
  const app = await setup(t, binding);
  await seed(app);
  await app.topics.create("alice", randomUUID(), { tag: "robotique", name: "Robotique", description: "", scope: "Robots et automatisation.", parentId: null, relatedIds: [] });
  const before = await files(app.root);
  const sessionId = await open(app, "alice", { type: "new-agent", id: null });
  const view = await turn(app, "alice", sessionId, "Crée-moi un agent qui surveille la robotique humanoïde, travaille entre 22 h et 2 h, prépare ses articles avant 3 h et publie pendant la nuit uniquement s'il trouve une actualité intéressante.");
  assert.match(requests[0].system, /Il n’existe pas de plage de préparation distincte/);
  const reply = view.history[1];
  assert.deepEqual(reply.unsupported, ["Plage de préparation distincte : elle suit la fin de la veille plus la tolérance.", "Publication sur les réseaux sociaux."], "said, never configured");
  const [proposal] = reply.proposals;
  assert.equal(proposal.status, "proposed");
  assert.equal(proposal.change.type, "agent-draft");
  const patch = proposal.change.patch;
  assert.deepEqual(Object.keys(patch).sort(), ["about", "autoPublish", "bloub", "charter", "handle", "limits", "llm", "name", "perimeter", "schedule", "settings", "sources", "topics"], "no visibility, no owner");
  assert.equal(patch.handle, "veille-humanoides");
  assert.deepEqual(patch.topics!.map(pick => pick.type === "new" ? pick.draft.tag : pick.type), ["robotique.humanoide"], "under its parent; T99 dropped");
  assert.deepEqual(patch.schedule!.watch.week, Array(7).fill([{ start: 22 * 60, end: 2 * 60 }]), "crosses midnight");
  assert.deepEqual([patch.schedule!.graceMinutes, patch.schedule!.publish.week[0]], [60, [{ start: 120, end: 360 }]]);
  assert.deepEqual(patch.llm, { instanceId: INSTANCE_ID, unresolvedKey: null, model: "mistral-small", options: {} }, "an available local model only");
  assert.deepEqual(patch.sources!.map(row => [row.domain, row.status]), [["robots.example.org", "undecided"]], "suggested sources wait for the owner's approval");
  assert.ok(proposal.notes.some(note => note.includes("T99")));
  assert.deepEqual(await files(app.root), before, "the conversation wrote nothing");

  // Preview: proposals over a new draft, the suggested source approved by the owner, then validation.
  const configuration = await app.konstruktor.configuration("alice", sessionId);
  assert.equal(configuration.kind, "new-agent");
  const proposals = await proposalsOf(app, "alice", sessionId);
  const base = newDraft({ presets: configuration.presets, timeZone: "Europe/Paris" });
  const shown = previewDraft(base, proposals, selectAll(proposals), {}).draft;
  const { draft } = previewDraft(base, proposals, selectAll(proposals), { sources: shown.sources.map(row => ({ ...row, status: "approved" as const })) });
  assert.equal(draft.provenance.schedule, "ai");
  assert.equal(draft.provenance.sources, "manual");
  const deploymentId = randomUUID();
  const { deployment } = await app.konstruktor.apply("alice", sessionId, { deploymentId, spec: draftToSpec(draft), accepted: acceptedIds(proposals, selectAll(proposals)) });
  assert.equal(deployment.state, "pending");
  assert.deepEqual(await files(app.root).then(after => Object.keys(after).filter(path => !path.includes(".xi-deployments") && !(path in before))), [], "validated, not yet applied: only the application log exists");
  assert.equal((await proposalsOf(app, "alice", sessionId))[0].status, "accepted");
  const done = await app.deployments.run("alice", deploymentId);
  assert.equal(done.state, "completed", JSON.stringify(done.steps.find(step => step.error)));
  assert.equal((await proposalsOf(app, "alice", sessionId))[0].status, "applied");

  const agent = (await app.accounts.watchAgents()).find(item => item.id === done.ids.agentId)!;
  assert.equal(agent.handle, "veille-humanoides");
  for (const [at, open] of [["2026-10-28T22:30:00", true], ["2026-10-29T01:30:00", true], ["2026-10-29T02:30:00", false], ["2026-10-28T12:00:00", false]] as const) assert.equal(watchOpen(agent, paris(at)), open, `watch ${at}`);
  assert.equal(publishOpen(agent, paris("2026-10-29T03:00:00")), true);
  assert.equal(publishOpen(agent, paris("2026-10-28T23:00:00")), false);
  const policy = await app.accounts.watchPolicy("alice", agent.id);
  assert.deepEqual([policy.policy.autoPublish, policy.policy.visibility, policy.publicConfirmedAt, policy.policy.maxPerDay, policy.policy.minIntervalMinutes], [true, "private", null, 2, 60]);
  assert.deepEqual((await app.accounts.llm("alice", agent.id)).config, { instanceId: INSTANCE_ID, model: "mistral-small", options: {} });
  assert.deepEqual((await app.accounts.avatar("alice", agent.id)).config, { version: 1, shape: "hexagone", expression: "curieux", color: "turquoise" });
  assert.equal((await app.topics.list()).find(topic => topic.tag === "robotique.humanoide")?.parentId, (await app.topics.list()).find(topic => topic.tag === "robotique")!.id);
  assert.deepEqual((await app.sources.list("alice")).sources.map(source => [new URL(source.url).hostname, source.status]), [["robots.example.org", "approved"]]);
  assert.ok(done.steps.flatMap(step => step.logs).some(log => log.level === "warn" && /non autorisée par l’opérateur/.test(log.message)), "operator gate kept and said");
});

test("konstruktor L5: existing ΞAgent — partial validation, refusal, manual edits kept, stale revision 409 then review, idempotent application", { timeout: 30_000 }, async t => {
  const answers = [
    { reply: "Deux pistes.", proposal: { summary: "Élargir la veille", perimeter: "Astronomie et astronautique.", charter: "Citer et dater.", publication: { maxPerDay: 5 }, schedule: { watch: { days: [1, 2, 3, 4, 5], ranges: [{ from: "08:00", to: "12:00" }] } }, avatar: { color: "rouge" } } },
    { reply: "Et un nouveau nom.", proposal: { summary: "Renommer", name: "Veille cosmos" } },
  ];
  const { binding } = model((_, call) => json(answers[call - 1]));
  const app = await setup(t, binding);
  const { agentId } = await seed(app);
  const sessionId = await open(app, "alice", { type: "agent", id: agentId });
  await turn(app, "alice", sessionId, "Élargis la veille.");
  await turn(app, "alice", sessionId, "Et le nom ?");
  let [widen, rename] = await proposalsOf(app, "alice", sessionId);
  const scheduleBefore = await app.accounts.schedule("alice", agentId);

  // Refusal writes only the decision.
  await app.konstruktor.decide("alice", sessionId, { refused: [rename.id] });
  [widen, rename] = await proposalsOf(app, "alice", sessionId);
  assert.deepEqual([widen.status, rename.status], ["proposed", "refused"]);

  // Partial validation: perimeter and limits only; the owner's own perimeter wins over the proposal.
  let configuration = await app.konstruktor.configuration("alice", sessionId);
  assert.equal(configuration.kind, "agent");
  if (configuration.kind !== "agent") return;
  assert.equal(configuration.draft.provenance.perimeter, "existing");
  const selection = { [widen.id]: ["perimeter", "limits"] };
  const manual = { perimeter: "Astronomie d’observation, avec les missions habitées." };
  let preview = previewDraft(configuration.draft, [widen, rename], selection, manual);
  assert.deepEqual(preview.conflicts.map(conflict => conflict.field), ["perimeter"], "the disagreement is shown");
  assert.equal(preview.draft.perimeter, manual.perimeter, "never overwritten silently");
  assert.equal(preview.draft.provenance.perimeter, "manual");
  assert.equal(preview.draft.name, "Veille astro", "refused proposal left out");
  let spec = draftToEditSpec(configuration.draft, preview.draft, configuration.base);
  assert.deepEqual(Object.keys(spec.changes).sort(), ["profile", "publication"]);

  // Someone changes the watch policy meanwhile: 409, nothing written, nothing decided.
  const current = await app.accounts.watchPolicy("alice", agentId);
  await app.accounts.setWatchPolicy("alice", agentId, { revision: current.revision, policy: { ...current.policy, maxPerDay: 4 } });
  const profileBefore = await app.accounts.profile("alice", agentId);
  await assert.rejects(app.konstruktor.apply("alice", sessionId, { deploymentId: randomUUID(), spec, accepted: [widen.id] }), (error: Error & { status?: number }) => error.status === 409 && /Publication/.test(error.message));
  assert.deepEqual(await app.accounts.profile("alice", agentId), profileBefore);
  assert.equal((await proposalsOf(app, "alice", sessionId))[0].status, "proposed");

  // Review the differences: the preview starts again from the current configuration, with the same choices.
  configuration = await app.konstruktor.configuration("alice", sessionId);
  if (configuration.kind !== "agent") return;
  assert.equal(configuration.draft.limits.maxPerDay, 4);
  preview = previewDraft(configuration.draft, [widen, rename], selection, manual);
  spec = draftToEditSpec(configuration.draft, preview.draft, configuration.base);
  const deploymentId = randomUUID();
  const applied = await app.konstruktor.apply("alice", sessionId, { deploymentId, spec, accepted: acceptedIds([widen, rename], selection) });
  assert.equal(applied.deployment.target, "edit");
  // Idempotent: the same validation again is the same deployment; another configuration under its id is refused.
  assert.equal((await app.konstruktor.apply("alice", sessionId, { deploymentId, spec, accepted: [widen.id] })).deployment.createdAt, applied.deployment.createdAt);
  await assert.rejects(app.konstruktor.apply("alice", sessionId, { deploymentId, spec: { ...spec, changes: { profile: { perimeter: "x", charter: "" } } }, accepted: [widen.id] }), { status: 409 });
  const done = await app.deployments.run("alice", deploymentId);
  assert.equal(done.state, "completed", JSON.stringify(done.steps.find(step => step.error)));
  assert.equal((await app.deployments.run("alice", deploymentId)).updatedAt, done.updatedAt, "a completed application never runs again");
  assert.deepEqual(await app.accounts.profile("alice", agentId), { perimeter: manual.perimeter, charter: "Citer les sources." }, "charter not accepted: unchanged");
  const policy = await app.accounts.watchPolicy("alice", agentId);
  assert.deepEqual([policy.policy.maxPerDay, policy.policy.enabled, policy.policy.paused, policy.policy.visibility], [5, DEFAULT_WATCH_POLICY.enabled, false, "private"], "only the limits");
  assert.deepEqual(await app.accounts.schedule("alice", agentId), scheduleBefore, "schedule not accepted");
  assert.equal((await app.accounts.getOwned("alice", agentId)).name, "Veille astro");
  [widen, rename] = await proposalsOf(app, "alice", sessionId);
  assert.deepEqual([widen.status, rename.status, widen.deploymentId], ["applied", "refused", deploymentId]);
  await assert.rejects(app.konstruktor.decide("alice", sessionId, { refused: [widen.id] }), { status: 409 }, "an applied proposal stays applied");
  assert.equal((await app.deployments.list("alice")).length, 1, "one application");
});

test("konstruktor L5: an interrupted application resumes without rewriting; a section changed before it runs is never overwritten", { timeout: 30_000 }, async t => {
  const app = await setup(t, model(() => json({ reply: "ok", proposal: null })).binding);
  const { agentId } = await seed(app);
  const read = async () => {
    const sessionId = await open(app, "alice", { type: "agent", id: agentId });
    const configuration = await app.konstruktor.configuration("alice", sessionId);
    if (configuration.kind !== "agent") throw new Error("agent");
    return configuration;
  };
  const night = (draft: AgentDraft): AgentDraft => ({ ...draft, schedule: { ...draft.schedule, timeZone: "Europe/Paris", watch: { ...draft.schedule.watch, week: Array(7).fill([{ start: 1320, end: 120 }]) } }, bloub: { ...draft.bloub, color: "vert" } });

  // Crash right after the calendar write, before the step is recorded.
  let configuration = await read();
  const id = randomUUID();
  await app.deployments.create("alice", id, draftToEditSpec(configuration.draft, night(configuration.draft), configuration.base));
  const setSchedule = app.accounts.setSchedule;
  app.accounts.setSchedule = async (...args) => { const saved = await setSchedule(...args); app.accounts.setSchedule = setSchedule; throw Object.assign(new Error("coupure"), { saved }); };
  const failed = await app.deployments.run("alice", id);
  assert.equal(failed.state, "failed");
  assert.deepEqual(failed.steps.filter(step => step.status === "completed").map(step => step.key), ["validate", "check", "topics", "identity", "sources"]);
  const written = await app.accounts.schedule("alice", agentId);
  const avatar = await app.accounts.avatar("alice", agentId);
  const resumed = await app.deployments.run("alice", id);
  assert.equal(resumed.state, "completed", JSON.stringify(resumed.steps.find(step => step.error)));
  assert.equal((await app.accounts.schedule("alice", agentId)).revision, written.revision, "not rewritten");
  assert.equal((await app.accounts.avatar("alice", agentId)).revision, avatar.revision, "completed steps are not replayed");
  assert.ok(resumed.steps.find(step => step.key === "calendars")!.logs.some(log => /déjà à jour/.test(log.message)));

  // Validated, then the owner edits the charter elsewhere before it runs: the check refuses (409), nothing is overwritten.
  configuration = await read();
  const stale = randomUUID();
  await app.deployments.create("alice", stale, draftToEditSpec(configuration.draft, { ...configuration.draft, charter: "Charte de Konstruktor." }, configuration.base));
  await app.accounts.setProfile("alice", agentId, { perimeter: configuration.draft.perimeter, charter: "Charte modifiée à la main." });
  const refused = await app.deployments.run("alice", stale);
  assert.equal(refused.state, "failed");
  assert.match(refused.steps.find(step => step.key === "check")!.error!, /modifiée depuis l’aperçu \(Périmètre et charte\)/);
  assert.equal((await app.accounts.profile("alice", agentId))!.charter, "Charte modifiée à la main.");
});

test("konstruktor L5: users and targets stay isolated; topics only by their creator; publication controls are never bypassed", { timeout: 30_000 }, async t => {
  const { binding } = model((_, call) => json(call === 1
    ? { reply: "Nom plus clair.", proposal: { summary: "Renommer le topic", name: "Astronomie et espace", parent: "T1" } }
    : { reply: "Rien.", proposal: null }));
  const app = await setup(t, binding);
  const { topic, agentId } = await seed(app);
  const sessionId = await open(app, "alice", { type: "topic", id: topic.id });
  await turn(app, "alice", sessionId, "Renomme ce topic.");
  const [rename] = await proposalsOf(app, "alice", sessionId);
  assert.deepEqual(rename.change, { type: "topic-edit", topicId: topic.id, patch: { name: "Astronomie et espace" } });
  assert.ok(rename.notes.some(note => /hiérarchie/.test(note)));

  // Another user: unknown conversation, unknown agent.
  await assert.rejects(app.konstruktor.configuration("bob", sessionId), { status: 404 });
  await assert.rejects(app.konstruktor.decide("bob", sessionId, { refused: [rename.id] }), { status: 404 });
  const configuration = await app.konstruktor.configuration("alice", sessionId);
  if (configuration.kind !== "topic") throw new Error("topic");
  const preview = previewTopic(configuration.topic, [rename], selectAll([rename]), { description: "Astronomie, astronautique." });
  const spec = topicEditSpec(configuration.topic, preview.patch, preview.model);
  await assert.rejects(app.konstruktor.apply("bob", sessionId, { deploymentId: randomUUID(), spec, accepted: [rename.id] }), { status: 404 });
  const agentSession = await open(app, "alice", { type: "agent", id: agentId });
  await assert.rejects(app.konstruktor.apply("alice", agentSession, { deploymentId: randomUUID(), spec, accepted: [] }), /ne correspond pas à la cible/, "a conversation applies to its own target only");
  await assert.rejects(app.konstruktor.apply("alice", agentSession, { deploymentId: randomUUID(), spec, accepted: [rename.id] }), { status: 404 }, "a proposal of another conversation");
  const agent = await app.konstruktor.configuration("alice", agentSession);
  if (agent.kind !== "agent") throw new Error("agent");
  await assert.rejects(app.deployments.create("bob", randomUUID(), draftToEditSpec(agent.draft, { ...agent.draft, charter: "Prise de contrôle." }, agent.base)), { status: 404 }, "another owner's ΞAgent is unknown");

  // A shared topic is changed by its creator only.
  const bobSession = await open(app, "bob", { type: "topic", id: topic.id });
  const forBob = await app.konstruktor.configuration("bob", bobSession);
  assert.equal(forBob.kind === "topic" && forBob.editable, false);
  await assert.rejects(app.konstruktor.apply("bob", bobSession, { deploymentId: randomUUID(), spec, accepted: [] }), { status: 403 });
  const { deployment } = await app.konstruktor.apply("alice", sessionId, { deploymentId: randomUUID(), spec, accepted: [rename.id] });
  assert.equal((await app.deployments.run("alice", deployment.id)).state, "completed");
  const edited = (await app.topics.list()).find(item => item.id === topic.id)!;
  assert.deepEqual([edited.name, edited.description, edited.tag], ["Astronomie et espace", "Astronomie, astronautique.", "astronomie"]);

  // Publication: visibility is not part of an edit; a paused agent stays paused; no public confirmation is recorded.
  const policy = await app.accounts.watchPolicy("alice", agentId);
  await app.accounts.setWatchPolicy("alice", agentId, { revision: policy.revision, policy: { ...policy.policy, enabled: true, paused: true } });
  const fresh = await app.konstruktor.configuration("alice", agentSession);
  if (fresh.kind !== "agent") throw new Error("agent");
  const publication = draftToEditSpec(fresh.draft, { ...fresh.draft, autoPublish: true }, fresh.base);
  await assert.rejects(app.konstruktor.apply("alice", agentSession, { deploymentId: randomUUID(), spec: { ...publication, changes: { publication: { ...publication.changes.publication, visibility: "public" } } }, accepted: [] }), { name: "ZodError" });
  await assert.rejects(app.konstruktor.apply("alice", agentSession, { deploymentId: randomUUID(), spec: { ...publication, changes: { ...publication.changes, watch: { enabled: true } } }, accepted: [] }), { name: "ZodError" });
  const { deployment: autonomous } = await app.konstruktor.apply("alice", agentSession, { deploymentId: randomUUID(), spec: publication, accepted: [] });
  const ran = await app.deployments.run("alice", autonomous.id);
  assert.equal(ran.state, "completed");
  const after = await app.accounts.watchPolicy("alice", agentId);
  assert.deepEqual([after.policy.autoPublish, after.policy.paused, after.policy.enabled, after.policy.visibility, after.publicConfirmedAt], [true, true, true, "private", null]);
  assert.ok(ran.steps.flatMap(step => step.logs).some(log => /XI_WATCH_AUTOPUBLISH/.test(log.message)), "the operator's gate is still required");
});

test("konstruktor L5: preview — fields accepted one by one, proposals taken in order, manual edits always win", () => {
  const base = newDraft({ presets: [], timeZone: "Europe/Paris" });
  const proposal = (id: string, patch: DraftPatch): Proposal =>
    ({ id, summary: id, origin: "ai", model: "qwen", status: "proposed", notes: [], change: { type: "agent-draft", agentId: null, patch } });
  const first = proposal("a", { name: "Alpha", perimeter: "P-a", autoPublish: true });
  const second = proposal("b", { name: "Beta" });
  const refused = { ...proposal("c", { name: "Gamma" }), status: "refused" as const };
  const all = [first, second, refused];
  assert.equal(previewDraft(base, all, selectAll(all), {}).draft.name, "Beta", "later proposals over earlier ones; refused ones ignored");
  const partial = previewDraft(base, all, { a: ["perimeter"] }, {}).draft;
  assert.deepEqual([partial.name, partial.perimeter, partial.autoPublish, partial.provenance.perimeter], ["", "P-a", false, "ai"]);
  const kept = previewDraft(base, all, selectAll(all), { name: "Le mien" });
  assert.deepEqual([kept.draft.name, kept.draft.provenance.name], ["Le mien", "manual"]);
  assert.deepEqual(kept.conflicts.map(conflict => [conflict.proposalId, conflict.field]), [["a", "name"], ["b", "name"]]);
  assert.deepEqual(acceptedIds(all, { a: [], b: ["name"], c: ["name"] }), ["b"]);
});
