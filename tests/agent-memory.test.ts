import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { request } from "playwright-core";
import { createTestServer } from "./helpers/next-server";
import { openVault } from "../src/lib/publications/vault";
import { createPublicationStore } from "../src/lib/publications/store";
import { createTopicStore } from "../src/lib/topics/store";
import { createTopicRelationStore } from "../src/lib/topics/relations";
import { createAccountStore } from "../src/lib/accounts/store";
import { KNOWLEDGE_TASK, MEMORY_LIMIT, migrateAgentKnowledge, recallAgentKnowledge } from "../src/lib/konstruktor/knowledge";

const FACT = "Asterion-47 utilise le moteur Helios-9.";

/**
 * Agent memory, end to end: Konstruktor learns a unique fictitious fact from a private publication of the agent,
 * then a new private comment conversation of its owner (another publication, no trace of the fact in its history)
 * must get it in the context sent to the model; a public conversation, or another user, must not.
 */
test("mémoire des ΞAgents : une nouvelle conversation retrouve une connaissance apprise, sans fuite", { timeout: 120_000 }, async t => {
  const calls: { system: string; prompt: string }[] = [];
  const ollama = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer);
    const data = JSON.parse(Buffer.concat(chunks).toString());
    res.writeHead(200, { "Content-Type": "application/json" });
    if (!data.stream) { res.end(JSON.stringify({ message: { content: '{"intervenir":false}' }, done: true })); return; }
    calls.push({ system: data.messages[0].content, prompt: data.messages[1].content });
    res.end(JSON.stringify({ message: { content: "Réponse de test." }, done: true }) + "\n");
  });
  ollama.listen(0, "127.0.0.1"); await once(ollama, "listening");
  const address = ollama.address(); assert.ok(address && typeof address !== "string");
  const app = await createTestServer({ XI_INFERENCE_URL: `http://127.0.0.1:${address.port}`, XI_INFERENCE_MODEL: "test" });
  const fixtureDb = new Database(":memory:");
  const alice = await request.newContext(), bob = await request.newContext();
  t.after(async () => { fixtureDb.close(); await alice.dispose(); await bob.dispose(); await app.dispose(); await new Promise<void>(resolve => ollama.close(() => resolve())); });
  await app.migrate(); await app.start();
  const signUp = async (context: typeof alice, name: string) => {
    const response = await context.post(`${app.origin}/api/auth/sign-up/email`, { headers: { Origin: app.origin }, data: { name, email: `${name.toLowerCase()}-memory@example.com`, password: "memory test password" } });
    assert.equal(response.status(), 200, await response.text());
    return (await response.json()).user.id as string;
  };
  const owner = await signUp(alice, "Alice");
  const stranger = await signUp(bob, "Bob");

  // An agent of Alice's, and one of its private publications stating the fact.
  const vault = await openVault(app.vaultPath);
  const topics = createTopicStore({ vault, db: fixtureDb });
  const accounts = createAccountStore({ vault, db: fixtureDb, topics });
  const publications = createPublicationStore({ vault, db: fixtureDb });
  const run = await topics.propose(owner, "Propulsion spatiale");
  await topics.confirm(owner, run.id, { tag: "propulsion", name: "Propulsion", description: "Moteurs", scope: "Propulsion spatiale", parentId: null, relatedIds: [] }, true);
  const proposal = await accounts.propose(owner, run.topicId), ready = await accounts.resume(owner, proposal.id);
  await accounts.confirm(owner, ready.id, ready.draft, true);
  const agent = ready.accountId;
  const handle = (await accounts.list(owner)).find(item => item.id === agent)!.handle.replace(/^@/, "");
  const source = randomUUID();
  const draft = await publications.saveWatchDraft(owner, agent, { id: source, summary: FACT, topicIds: [run.topicId], messages: [{ body: FACT, sources: [0] }], sources: [{ url: "https://agence.example/asterion", title: "Asterion", publisher: "Agence", accessedAt: "2026-11-01", facts: [FACT], reservations: [] }], watch: {} });
  const reviewed = await publications.reviewWatchDraft({ id: owner }, agent, source, { action: "approve", revision: draft.revision });
  assert.ok(reviewed.ok);
  assert.equal(reviewed.snapshot.visibility, "private");

  // Learning: Konstruktor's background task, as the worker runs it, writing into the application database.
  const appDb = new Database(app.databasePath);
  t.after(() => appDb.close());
  const relations = createTopicRelationStore({ vault, db: fixtureDb, topics, readable: async viewer => viewer === owner ? new Set([source]) : new Set() });
  const answer = { concepts: [{ label: "Asterion-47", quote: FACT }, { label: "Helios-9", quote: FACT }], relations: [{ from: "Asterion-47", to: "Helios-9", type: "related_to", quote: FACT, justification: "La publication affirme qu’Asterion-47 utilise le moteur Helios-9.", confidence: 0.8 }] };
  const learned = await KNOWLEDGE_TASK.run({ owner, input: { publication: source, agent, revision: reviewed.snapshot.revision }, services: { db: appDb, topics, accounts, publications, relations }, llm: () => ({ ok: true, resolved: { model: "test" }, inference: { complete: async () => JSON.stringify(answer) } }), log: () => {} } as never);
  assert.deepEqual(learned, { outcome: "done", concepts: 2, reused: 0, created: 2, ignored: 0, relations: 1, kept: 0 });
  const memory = appDb.prepare("SELECT excerpt FROM xi_agent_knowledge WHERE owner = ? AND agent = ?").all(owner, agent) as { excerpt: string }[];
  assert.ok(memory.length === 2 && memory.every(row => row.excerpt === FACT), "connaissance persistée avec sa citation");
  const helios = (await topics.visible(owner)).personal.find(topic => topic.tag === "helios-9")!;
  const [relation] = (await relations.relationsOf(owner, helios.id)).proposed;
  assert.equal(relation.status, "proposed");
  assert.equal(relation.evidence[0].publication, source);

  // A new conversation: another publication, whose history never contains the fact.
  const converse = async (context: typeof alice, viewer: string, question: string, visibility: "private" | "public") => {
    const id = await publications.create({ id: viewer });
    const editable = await publications.getEditable({ id: viewer }, id);
    const saved = await publications.save({ id: viewer }, id, { baseRevision: editable.revision, summary: "", visibility, messages: [{ key: "new", file: null, body: "Question sur la propulsion d’Asterion-47." }] });
    assert.ok(saved.ok); await publications.publish({ id: viewer }, id, saved.snapshot.revision);
    const endpoint = `${app.origin}/api/publications/${id}/comments`;
    let added = await context.post(endpoint, { headers: { Origin: app.origin }, data: { action: "add", body: question, parent: null } });
    for (let attempt = 0; added.status() === 404 && attempt < 30; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 500));
      added = await context.post(endpoint, { headers: { Origin: app.origin }, data: { action: "add", body: question, parent: null } });
    }
    assert.equal(added.status(), 200, await added.text());
    for (let attempt = 0; attempt < 40; attempt++) {
      const state = await (await context.get(endpoint)).json() as { comments: { agent: string | null; state: string; body: string }[] };
      const reply = state.comments.find(comment => comment.agent === agent && ["done", "error"].includes(comment.state));
      if (reply) {
        assert.equal(reply.state, "done");
        assert.ok(!state.comments.some(comment => comment.body.includes("Helios-9")), "le fait n’apparaît pas dans l’historique de la conversation");
        const call = calls.find(item => item.prompt.includes(question));
        assert.ok(call, "le modèle a été appelé pour cette conversation");
        return `${call.system}\n${call.prompt}`;
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.fail("aucune réponse de l’agent");
  };

  const context = await converse(alice, owner, `@${handle} Quel moteur utilise Asterion-47 ?`, "private");
  assert.match(context, /Helios-9/, "la connaissance apprise est transmise au modèle dans une nouvelle conversation");
  assert.match(context, new RegExp(source), "la connaissance arrive avec sa publication source");

  // Comments are readable by every reader of their publication: a public reply must not reveal a private source.
  const exposed = await converse(alice, owner, `@${handle} En public : quel moteur pour Asterion-47 ?`, "public");
  assert.doesNotMatch(exposed, /Helios-9/, "une connaissance privée ne nourrit pas une réponse publique");

  // Bob may mention Alice's public agent, but never receives what it learned from her private publication.
  const foreign = await converse(bob, stranger, `@${handle} Bob demande : quel moteur pour Asterion-47 ?`, "public");
  assert.doesNotMatch(foreign, /Helios-9/, "aucune fuite vers un autre utilisateur");
});

test("rappel de mémoire : pertinence, sources obsolètes ou non publiées, audience et plafond", async t => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const path = await mkdtemp(join(tmpdir(), "xi-memory-"));
  const db = new Database(":memory:");
  t.after(async () => { db.close(); await rm(path, { recursive: true, force: true }); });
  const vault = await openVault(path), topics = createTopicStore({ vault, db });
  const accounts = createAccountStore({ vault, db, topics }), publications = createPublicationStore({ vault, db });
  const run = await topics.propose("alice", "Propulsion spatiale");
  await topics.confirm("alice", run.id, { tag: "propulsion", name: "Propulsion", description: "", scope: "Propulsion", parentId: null, relatedIds: [] }, true);
  const proposal = await accounts.propose("alice", run.topicId), ready = await accounts.resume("alice", proposal.id);
  await accounts.confirm("alice", ready.id, ready.draft, true);
  const agent = ready.accountId;
  const draft = async (text: string) => {
    const id = randomUUID();
    const saved = await publications.saveWatchDraft("alice", agent, { id, summary: text, topicIds: [run.topicId], messages: [{ body: text, sources: [0] }], sources: [{ url: "https://agence.example/a", title: "Agence", publisher: "Agence", accessedAt: "2026-11-01", facts: [text], reservations: [] }], watch: {} });
    return { id, revision: saved.revision };
  };
  const publish = async (text: string, visibility: "private" | "public") => {
    const { id, revision } = await draft(text);
    const result = await publications.publishWatchDraft("alice", agent, id, { visibility, revision, details: {}, guard: async () => null, record: () => {} });
    assert.equal(result.outcome, "published");
    return { id, revision: (result as { snapshot: { revision: string } }).snapshot.revision };
  };
  migrateAgentKnowledge(db);
  const learn = async (publication: { id: string; revision: string }, tag: string, excerpt: string) => {
    const topic = (await topics.openPersonal("alice", tag)).topic;
    db.prepare("INSERT INTO xi_agent_knowledge VALUES ('alice', ?, ?, ?, ?, ?)").run(agent, publication.id, publication.revision, topic.id, excerpt);
  };
  const secret = await publish("Asterion-47 utilise le moteur Helios-9.", "private");
  const open = await publish("Asterion-47 décolle depuis Kourou.", "public");
  const other = await publish("Orion-12 utilise le moteur Vega-2.", "private");
  const pending = await draft("Asterion-47 embarque la sonde Kepler-3.");
  const stale = await publish("Asterion-47 vise l’orbite de Mars.", "private");
  await learn(secret, "asterion-47", "Asterion-47 utilise le moteur Helios-9.");
  await learn(open, "kourou", "Asterion-47 décolle depuis Kourou.");
  await learn(other, "orion-12", "Orion-12 utilise le moteur Vega-2.");
  await learn(pending, "kepler-3", "Asterion-47 embarque la sonde Kepler-3.");
  await learn({ ...stale, revision: "revision-precedente" }, "mars", "Asterion-47 vise l’orbite de Mars.");
  const stores = { publications, topics };
  const recall = async (audience: "private" | "public", text: string, owner = "alice") => (await recallAgentKnowledge(stores, owner, agent, audience, text)).map(item => item.excerpt);

  const question = "Asterion-47 décolle de Kourou, embarque Kepler-3 et vise Mars : quel moteur ?";
  const recalled = await recall("private", question);
  assert.ok(recalled.includes("Asterion-47 utilise le moteur Helios-9."));
  assert.ok(recalled.includes("Asterion-47 décolle depuis Kourou."));
  assert.ok(!recalled.some(item => /Kepler-3|Mars/.test(item)), "ni brouillon non publié, ni révision obsolète");
  assert.ok(!recalled.some(item => /Orion-12/.test(item)), "aucun concept non mentionné");
  assert.deepEqual(await recall("public", question), ["Asterion-47 décolle depuis Kourou."], "audience publique : sources publiques uniquement");
  assert.deepEqual(await recall("private", "Parlons d’autre chose."), [], "rien sans concept mentionné");
  assert.deepEqual(await recall("private", question, "bob"), [], "la mémoire d’Alice n’est jamais lue pour Bob");

  // The cap: many learned concepts named at once never inject more than MEMORY_LIMIT excerpts.
  const many = Array.from({ length: MEMORY_LIMIT + 5 }, (_, n) => `lot-${n}`);
  for (const tag of many) await learn(secret, tag, `Extrait ${tag} de la publication.`);
  assert.equal((await recall("private", `${many.map(tag => tag.replace("-", " ")).join(", ")}.`)).length, MEMORY_LIMIT);
});
