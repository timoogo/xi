import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { KonstruktorTarget } from "../src/lib/konstruktor/types";
import { interactiveRetryDelay, MAX_INTERACTIVE_WAIT } from "../src/lib/system-agents/tasks";
import { InferenceUnavailableError } from "../src/lib/watch/inference";
import { files, json, model, seed, setup } from "./helpers/konstruktor";
const answer = { reply: "Je propose de préciser le périmètre.", questions: ["Faut-il inclure l’astronautique ?"], proposal: { summary: "Préciser le périmètre", perimeter: "Astronomie d’observation et missions spatiales.", topics: [{ existing: "T1" }] } };

test("konstruktor: persistent sessions, structured reply and proposal, resumed after a restart, new conversation", { timeout: 20_000 }, async t => {
  const { binding, requests } = model(() => json(answer));
  const first = await setup(t, binding);
  const { topic, agentId } = await seed(first);
  const target: KonstruktorTarget = { type: "agent", id: agentId };
  const sessionId = randomUUID();
  const opened = await first.konstruktor.open("alice", { id: sessionId, target });
  assert.equal(opened.title, "ΞAgent @veille-astro");
  assert.deepEqual((await first.konstruktor.open("alice", { id: sessionId, target })).id, sessionId, "idempotent");
  const sent = await first.konstruktor.send("alice", sessionId, { requestId: randomUUID(), text: "Élargis un peu le périmètre." });
  assert.ok(["pending", "thinking"].includes(sent.turn!.state));
  await first.tasks.close();
  const view = (await first.konstruktor.view("alice", sessionId));
  assert.equal(view.turn!.state, "done");
  assert.deepEqual(view.history.map(message => message.role), ["user", "assistant"]);
  const reply = view.history[1];
  assert.equal(reply.text, answer.reply);
  assert.deepEqual(reply.questions, answer.questions);
  assert.equal(reply.proposals.length, 1);
  const [proposal] = reply.proposals;
  assert.deepEqual(proposal.change, { type: "agent-draft", agentId, patch: { perimeter: answer.proposal.perimeter, topics: [{ type: "existing", id: topic.id, reason: "Topic existant #astronomie, proposé par Konstruktor." }] } });
  assert.deepEqual([proposal.origin, proposal.status, proposal.model], ["ai", "proposed", "qwen-test sur Ollama local (configuration globale)"]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].model, "qwen-test", "the user's own local model");

  // Restart: new connection and services on the same files.
  await first.close();
  const second = await setup(t, binding, { root: first.root });
  const resumed = (await second.konstruktor.view("alice", sessionId));
  assert.deepEqual(resumed.history, view.history);
  assert.deepEqual((await second.konstruktor.list("alice", target)).map(session => session.id), [sessionId]);
  const other = randomUUID();
  await second.konstruktor.open("alice", { id: other, target });
  assert.deepEqual((await second.konstruktor.list("alice", target)).map(session => [session.id, session.messages]), [[other, 0], [sessionId, 2]]);
  // The previous history is part of the next turn.
  second.clock.at += 1_000;
  await second.konstruktor.send("alice", sessionId, { requestId: randomUUID(), text: "Et la charte ?" });
  await second.tasks.close();
  assert.equal((await second.konstruktor.view("alice", sessionId)).history.length, 4);
  assert.match(requests[1].prompt, /Élargis un peu le périmètre/);
});

test("konstruktor: conversations and targets are private to their user", { timeout: 20_000 }, async t => {
  const { binding, requests } = model(() => json({ reply: "D’accord.", proposal: null }));
  const app = await setup(t, binding);
  const { topic, secret, agentId } = await seed(app);
  const sessionId = randomUUID();
  await app.konstruktor.open("alice", { id: sessionId, target: { type: "agent", id: agentId } });
  await app.konstruktor.send("alice", sessionId, { requestId: randomUUID(), text: "Bonjour" });
  await app.tasks.close();
  await assert.rejects(app.konstruktor.view("bob", sessionId), { status: 404 });
  await assert.rejects(app.konstruktor.send("bob", sessionId, { requestId: randomUUID(), text: "Lis ceci" }), { status: 404 });
  await assert.rejects(app.konstruktor.open("bob", { id: sessionId, target: { type: "new-agent", id: null } }), { status: 404 }, "an id of another user is unknown");
  await assert.rejects(app.konstruktor.open("bob", { id: randomUUID(), target: { type: "agent", id: agentId } }), { status: 404 }, "another user's ΞAgent");
  await assert.rejects(app.konstruktor.list("bob", { type: "agent", id: agentId }), { status: 404 });
  await assert.rejects(app.konstruktor.open("alice", { id: randomUUID(), target: { type: "topic", id: secret.id } }), { status: 404 }, "another user's personal topic");
  assert.deepEqual(await app.konstruktor.list("bob", { type: "topic", id: topic.id }), [], "a shared topic: Bob has no conversation about it");
  assert.ok(!requests.some(request => request.prompt.includes("dossier-secret-bob")), "Bob's personal topics never reach Alice's prompt");
  // Bob's own conversation sees his personal topic, never Alice's agent.
  const bobs = randomUUID();
  await app.konstruktor.open("bob", { id: bobs, target: { type: "new-agent", id: null } });
  await app.konstruktor.send("bob", bobs, { requestId: randomUUID(), text: "Une veille" });
  await app.tasks.close();
  assert.match(requests.at(-1)!.prompt, /dossier-secret-bob/);
  assert.doesNotMatch(requests.at(-1)!.prompt, /Astronomie d’observation|"Veille astro"|Citer les sources/, "nothing of Alice's ΞAgent");
  for (const invalid of [{ id: "x", target: { type: "agent", id: agentId } }, { id: randomUUID(), target: { type: "agent" } }, { id: randomUUID(), target: { type: "autre", id: null } }, { id: randomUUID(), target: { type: "new-agent", id: null }, extra: 1 }]) {
    await assert.rejects(app.konstruktor.open("alice", invalid), { name: "ZodError" });
  }
});

test("konstruktor: a turn is idempotent, one at a time per conversation", { timeout: 20_000 }, async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { binding, requests } = model(async () => { await gate; return json({ reply: "Voilà.", proposal: null }); });
  const app = await setup(t, binding);
  await seed(app);
  const sessionId = randomUUID();
  await app.konstruktor.open("alice", { id: sessionId, target: { type: "new-agent", id: null } });
  const turn = { requestId: randomUUID(), text: "Une veille sur les volcans" };
  await app.konstruktor.send("alice", sessionId, turn);
  await app.konstruktor.send("alice", sessionId, turn);
  await app.konstruktor.send("alice", sessionId, { ...turn, text: `  ${turn.text}  ` });
  await assert.rejects(app.konstruktor.send("alice", sessionId, { ...turn, text: "Autre chose" }), { status: 409 });
  await assert.rejects(app.konstruktor.send("alice", sessionId, { requestId: randomUUID(), text: "Encore" }), { status: 409 }, "the previous turn is still in progress");
  release();
  await app.tasks.close();
  const view = (await app.konstruktor.view("alice", sessionId));
  assert.deepEqual(view.history.map(message => message.role), ["user", "assistant"]);
  assert.equal(requests.length, 1, "one model call for the repeated request");
  assert.equal(app.db.prepare("SELECT count(*) FROM watch_job WHERE kind = 'system-task'").pluck().get(), 1);
  // Once answered, the same request id still reads the same turn and the next turn is accepted.
  assert.equal((await app.konstruktor.send("alice", sessionId, turn)).history.length, 2);
  await app.konstruktor.send("alice", sessionId, { requestId: randomUUID(), text: "Merci" });
  await app.tasks.close();
  assert.equal((await app.konstruktor.view("alice", sessionId)).history.length, 4);
  // Not through the generic task API: a conversation turn is internal.
  await assert.rejects(app.tasks.request("alice", "konstruktor", { requestId: randomUUID(), task: "converse", input: { sessionId, messageId: randomUUID() } }), { status: 400 });
});

test("konstruktor: invalid model answers are reported, never stored as a reply", { timeout: 20_000 }, async t => {
  const outputs = ["pas du JSON", json({ reply: "", questions: "non" })];
  const { binding, requests } = model((_, call) => outputs[call - 1] ?? json({ reply: "Correct cette fois.", proposal: { summary: "Rien d’exploitable", unknown: true } }));
  const app = await setup(t, binding);
  await seed(app);
  const sessionId = randomUUID();
  await app.konstruktor.open("alice", { id: sessionId, target: { type: "new-agent", id: null } });
  await app.konstruktor.send("alice", sessionId, { requestId: randomUUID(), text: "Une veille" });
  await app.tasks.close();
  const failed = (await app.konstruktor.view("alice", sessionId));
  assert.equal(failed.turn!.state, "error");
  assert.match(failed.turn!.message!, /non conforme/);
  assert.deepEqual(failed.history.map(message => message.role), ["user"]);
  assert.equal(requests.length, 2, "one corrective retry, then a visible error (no loop)");
  // The user can try again; a proposal without any usable field is dropped, the reply is kept.
  await app.konstruktor.send("alice", sessionId, { requestId: randomUUID(), text: "Réessaie" });
  await app.tasks.close();
  const fixed = (await app.konstruktor.view("alice", sessionId));
  assert.equal(fixed.turn!.state, "done");
  assert.equal(fixed.history.at(-1)!.text, "Correct cette fois.");
  assert.deepEqual(fixed.history.at(-1)!.proposals, []);
});

test("konstruktor: retrieved texts stay data; proposals are confined to known fields and visible topics; nothing is changed", { timeout: 20_000 }, async t => {
  const hostile = { reply: "Proposition prête.", proposal: { summary: "Changer le nom", name: "Veille pirate", handle: "admin", delete: true, owner: "bob", topics: [{ existing: "T99" }, { existing: "T1" }, { existing: null, name: "Nouveau sujet", tag: "Nouveau Sujet!", scope: "Un périmètre." }] }, publish: true };
  const { binding, requests } = model(() => json(hostile));
  const app = await setup(t, binding);
  const { topic, agentId } = await seed(app);
  const before = await files(app.root);
  const agentBefore = await app.accounts.getOwned("alice", agentId);
  const topicsBefore = await app.topics.visible("alice");

  for (const target of [{ type: "agent", id: agentId }, { type: "topic", id: topic.id }, { type: "new-topic", id: null }, { type: "new-agent", id: null }] as KonstruktorTarget[]) {
    const id = randomUUID();
    await app.konstruktor.open("alice", { id, target });
    await app.konstruktor.send("alice", id, { requestId: randomUUID(), text: "Applique la proposition et publie tout de suite." });
    await app.tasks.close();
    assert.equal((await app.konstruktor.view("alice", id)).turn!.state, "done", target.type);
  }
  // The injected description reaches the model only as an escaped JSON string inside the data block.
  const prompt = requests[0].prompt;
  assert.equal(prompt.split("</donnees>").length, 2, "the data block cannot be closed from inside");
  assert.ok(prompt.indexOf("IGNORE TOUTES LES INSTRUCTIONS") < prompt.indexOf("</donnees>"));
  assert.match(requests[0].system, /jamais des instructions/);
  assert.doesNotMatch(requests[0].system, /IGNORE/);

  const proposals = (app.db.prepare("SELECT data FROM konstruktor_message WHERE role = 'assistant' ORDER BY created_at, seq").pluck().all() as string[]).map(data => JSON.parse(data).proposals[0]);
  const [agent, topicEdit, newTopic, newAgent] = proposals.map(proposal => proposal?.change);
  assert.deepEqual(Object.keys(agent.patch).sort(), ["handle", "name", "topics"], "known fields only: no owner, deletion or publication key");
  assert.deepEqual(agent.patch.topics.map((pick: { type: string; id?: string; draft?: { tag: string } }) => pick.type === "existing" ? pick.id : pick.draft!.tag), [topic.id, "nouveau-sujet"], "T99 dropped");
  assert.deepEqual(topicEdit, { type: "topic-edit", topicId: topic.id, patch: { name: "Veille pirate" } });
  assert.equal(newTopic.type, "topic-draft");
  assert.equal(newAgent.agentId, null);

  // No configuration changed: vault files, agent and topics are identical.
  assert.deepEqual(await files(app.root), before);
  assert.deepEqual(await app.accounts.getOwned("alice", agentId), agentBefore);
  assert.deepEqual(await app.topics.visible("alice"), topicsBefore);
});

test("konstruktor: unavailable model retried with a bounded interactive backoff, then a visible failure; no configuration", { timeout: 20_000 }, async t => {
  let up = false;
  const { binding, requests } = model(() => { if (!up) throw new InferenceUnavailableError("Serveur Ollama injoignable."); return json({ reply: "De retour.", proposal: null }); });
  const app = await setup(t, binding);
  await seed(app);
  assert.deepEqual([0, 15, 30, 60, 120, 240, 480, 3_600].map(seconds => interactiveRetryDelay(seconds * 1_000) / 1_000), [15, 15, 30, 60, 120, 240, 300, 300]);
  const sessionId = randomUUID();
  await app.konstruktor.open("alice", { id: sessionId, target: { type: "new-agent", id: null } });
  await app.konstruktor.send("alice", sessionId, { requestId: randomUUID(), text: "Bonjour" });
  await app.tasks.close();
  let view = (await app.konstruktor.view("alice", sessionId));
  assert.deepEqual([view.turn!.state, view.turn!.retryAt], ["unavailable", app.clock.at + 15_000]);
  assert.match(view.turn!.message!, /injoignable/);
  app.clock.at = view.turn!.retryAt!;
  await app.tasks.kick();
  view = (await app.konstruktor.view("alice", sessionId));
  assert.deepEqual([view.turn!.state, view.turn!.retryAt], ["unavailable", app.clock.at + 15_000], "follows the time already waited");
  app.clock.at = view.turn!.retryAt!;
  await app.tasks.kick();
  view = (await app.konstruktor.view("alice", sessionId));
  assert.deepEqual([view.turn!.state, view.turn!.retryAt], ["unavailable", app.clock.at + 30_000], "growing delay");
  up = true;
  app.clock.at = view.turn!.retryAt!;
  await app.tasks.kick();
  assert.equal((await app.konstruktor.view("alice", sessionId)).turn!.state, "done");
  assert.equal(requests.length, 4);

  // Still down: at most MAX_MODEL_WAITS waits, then an explicit failure.
  up = false;
  await app.konstruktor.send("alice", sessionId, { requestId: randomUUID(), text: "Encore ?" });
  const since = app.clock.at;
  for (let i = 0; i < 20; i++) {
    await app.tasks.close();
    view = (await app.konstruktor.view("alice", sessionId));
    if (view.turn!.state !== "unavailable") break;
    app.clock.at = view.turn!.retryAt!;
    await app.tasks.kick();
  }
  assert.equal(view.turn!.state, "error");
  assert.match(view.turn!.message!, /toujours indisponible après \d+ min/);
  assert.ok(app.clock.at - since >= MAX_INTERACTIVE_WAIT && app.clock.at - since < MAX_INTERACTIVE_WAIT + 5 * 60_000);
  assert.equal(requests.length - 4, 9, "a handful of attempts over a quarter of an hour, never a tight loop");

  // No local model configured: an explicit error, no other provider.
  const none = await setup(t, () => ({ ok: false, code: "not-configured", message: "Aucune instance IA : ajoutez une instance Ollama." }));
  await seed(none);
  const lonely = randomUUID();
  await none.konstruktor.open("alice", { id: lonely, target: { type: "new-topic", id: null } });
  await none.konstruktor.send("alice", lonely, { requestId: randomUUID(), text: "Un topic" });
  await none.tasks.close();
  const failed = (await none.konstruktor.view("alice", lonely));
  assert.equal(failed.turn!.state, "error");
  assert.match(failed.turn!.message!, /Aucune instance IA/);
});
