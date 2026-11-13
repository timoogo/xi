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
import { admit, SYSTEM_TASK_KIND } from "../src/lib/watch/orchestrator";
import { systemTaskHandler } from "../src/lib/system-agents/tasks";
import { createKnowledgePipelines } from "../src/lib/konstruktor/pipelines";
import { conceptProvenance, knowledgeGraph } from "../src/lib/konstruktor/knowledge-graph-data";
import { KNOWLEDGE_LIMITS, knowledgeHref, parseKnowledgeRequest, type KnowledgeRequest } from "../src/lib/konstruktor/knowledge-graph";

/** One concept pair and relation per « X verbe … Y. » sentence; « influence » makes an oriented relation. */
export const knowledgeModel = { complete: async ({ prompt }: { prompt: string }) => {
  const text = prompt.replace(/^Texte :\n/, "").split("\n")[0];
  const sentences = text.match(/[^.]+\./g)!.map(sentence => sentence.trim()).filter(sentence => /utilise|influence/.test(sentence));
  const pairs = sentences.map(sentence => { const words = sentence.replace(/\.$/, "").split(" "); return { sentence, from: words[0], to: words.at(-1)! }; });
  return JSON.stringify({
    concepts: pairs.flatMap(({ sentence, from, to }) => [{ label: from, quote: sentence }, { label: to, quote: sentence }]),
    relations: pairs.map(({ sentence, from, to }) => ({ from, to, type: sentence.includes("influence") ? "influences" : "related_to", quote: sentence, justification: "La publication affirme explicitement ce lien entre les deux.", confidence: 0.8 })),
  });
} };

async function world(t: { after: (fn: () => Promise<void>) => void }) {
  const path = await mkdtemp(join(tmpdir(), "xi-knowledge-graph-"));
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
  const publish = async (owner: string, agent: { id: string; topic: string }, text: string) => {
    const id = randomUUID();
    const draft = await publications.saveWatchDraft(owner, agent.id, { id, summary: text, topicIds: [agent.topic], messages: [{ body: text, sources: [0] }], sources: [{ url: "https://agence.example/depeche", title: "Dépêche spatiale", publisher: "Agence Orbitale", accessedAt: "2026-11-01", facts: [text], reservations: [] }], watch: {} });
    assert.ok((await publications.reviewWatchDraft({ id: owner }, agent.id, id, { action: "approve", revision: draft.revision })).ok);
    return id;
  };
  const binding = { ok: true as const, resolved: { model: "qwen3:1.7b" }, inference: knowledgeModel };
  const systemAgents = { get: async () => ({ id: "konstruktor", enabled: true }) };
  const queue = createJobQueue(db, now);
  const handlers = { [SYSTEM_TASK_KIND]: systemTaskHandler({ store: systemAgents as never, llm: () => binding as never, services: { db, accounts, topics, publications, relations, agentLLM: () => binding as never }, now }) };
  const control = { db, admit: async (job: Job) => admit(job, undefined, new Map(), now()), owner: async (job: Job) => (job.payload as { owner: string }).owner };
  /** A real knowledge pipeline run for one agent, drained to the end. */
  const learn = async (owner: string, agent: string, mode: "missing" | "force" = "missing") => {
    const started = await createKnowledgePipelines({ db, accounts, publications, systemAgents: systemAgents as never, queue, now }).start(owner, { agent, mode });
    assert.ok(started);
    for (let pass = 0; pass < 6; pass++) { await drainJobs({ queue, handlers, clock: now, control, maxJobs: 200 }); clock += 10 * 60_000; }
  };
  const stores = { accounts, topics, relations, publications };
  const graph = (viewer: string, request: Partial<KnowledgeRequest>) => knowledgeGraph(viewer, { agent: null, focus: null, open: [], excluded: false, ...request }, stores);
  return { agentOf, publish, learn, graph, stores, relations, topics };
}

test("connaissances : un graphe par ΞAgent, décisions humaines, provenance et isolation", async t => {
  const w = await world(t);
  const astronoxi = await w.agentOf("alice", "Astronoxi"), orbites = await w.agentOf("alice", "Orbites"), vide = await w.agentOf("alice", "Vide");
  const fusees = await w.agentOf("bob", "Fusees");
  const p1 = await w.publish("alice", astronoxi, "Asterion-47 utilise le moteur Helios-9. Helios-9 influence la trajectoire Orbite-3.");
  const p2 = await w.publish("alice", astronoxi, "Vega-2 utilise le moteur Helios-9. Lyra-5 utilise le capteur Kappa-1.");
  // Another agent of the same owner learns an overlapping relation, and a concept of its own.
  const p3 = await w.publish("alice", orbites, "Asterion-47 utilise le moteur Helios-9. Zeta-3 utilise le moteur Rho-1.");
  await w.publish("bob", fusees, "Secret-9 utilise le moteur Cache-4.");
  for (const [owner, agent] of [["alice", astronoxi.id], ["alice", orbites.id], ["bob", fusees.id]] as const) await w.learn(owner, agent);

  // Concepts are compared by tag: Konstruktor names the topics it opens after their tag (« Asterion 47 »).
  const names = (graph: Awaited<ReturnType<typeof w.graph>>) => graph.nodes.map(node => node.tag).sort();
  let graph = await w.graph("alice", { agent: astronoxi.id });
  // Only this agent's concepts; Helios-9, extracted from two of its publications, appears once.
  assert.deepEqual(names(graph), ["asterion-47", "helios-9", "kappa-1", "lyra-5", "orbite-3", "vega-2"]);
  assert.equal(graph.nodes.find(node => node.tag === "helios-9")!.publications, 2);
  assert.ok(graph.nodes.every(node => node.personal));
  assert.deepEqual(graph.counts, { concepts: 6, publications: 2, accepted: 0, proposed: 4, excluded: 0 });
  assert.deepEqual(graph.agents.map(agent => agent.name), ["Astronoxi", "Orbites", "Vide"]);
  const byName = new Map(graph.nodes.map(node => [node.tag, node.id]));
  const edge = (from: string, to: string) => graph.edges.find(e => [e.source, e.target].sort().join() === [byName.get(from), byName.get(to)].sort().join())!;
  // Oriented relation keeps its direction; symmetric ones carry none.
  const influence = edge("helios-9", "orbite-3");
  assert.deepEqual([influence.type, influence.directed, influence.source, influence.target, influence.status], ["influences", true, byName.get("helios-9"), byName.get("orbite-3"), "proposed"]);
  assert.equal(edge("asterion-47", "helios-9").directed, false);
  // The relation also learned by Orbites shows only Astronoxi's evidence here, and only Orbites' there.
  const shared = edge("asterion-47", "helios-9");
  assert.deepEqual(shared.evidence.map(e => e.publication), [p1]);
  assert.equal(shared.evidence[0].excerpt, "Asterion-47 utilise le moteur Helios-9.");
  const other = await w.graph("alice", { agent: orbites.id });
  assert.deepEqual(names(other), ["asterion-47", "helios-9", "rho-1", "zeta-3"]);
  assert.deepEqual(other.edges.find(e => e.id === shared.id)!.evidence.map(e => e.publication), [p3]);

  // Human decisions: correction, validation, exclusion and personal mask, as stored.
  await w.relations.correct("alice", edge("vega-2", "helios-9").id, { type: "part_of", reason: "Le moteur est un composant." });
  await w.relations.correct("alice", influence.id, { status: "accepted" });
  await w.relations.correct("alice", edge("lyra-5", "kappa-1").id, { status: "excluded", reason: "Lien trop vague." });
  await w.relations.correct("alice", shared.id, { status: "accepted" });
  await w.relations.hide("alice", shared.id, true);
  graph = await w.graph("alice", { agent: astronoxi.id });
  const ids = new Set(graph.edges.map(e => e.id));
  assert.equal(graph.edges.length, 2, "exclue et masquée n’apparaissent pas par défaut");
  assert.ok(!ids.has(shared.id));
  const corrected = graph.edges.find(e => e.type === "part_of")!;
  assert.deepEqual([corrected.status, corrected.directed, corrected.correction?.from, corrected.correction?.to, corrected.correction?.reason], ["proposed", true, "related_to", "part_of", "Le moteur est un composant."]);
  assert.deepEqual([graph.edges.find(e => e.id === influence.id)!.status, graph.edges.find(e => e.id === influence.id)!.decision?.action], ["accepted", "accepted"]);
  assert.deepEqual(graph.counts, { concepts: 6, publications: 2, accepted: 1, proposed: 1, excluded: 2 });
  const all = await w.graph("alice", { agent: astronoxi.id, excluded: true });
  const excluded = all.edges.find(e => e.status === "excluded")!;
  assert.deepEqual([excluded.decision?.action, excluded.decision?.reason, excluded.hidden], ["excluded", "Lien trop vague.", false]);
  assert.deepEqual([all.edges.find(e => e.id === shared.id)!.status, all.edges.find(e => e.id === shared.id)!.hidden], ["accepted", true]);
  // A later forced re-analysis neither duplicates concepts nor revives the exclusion.
  await w.learn("alice", astronoxi.id, "force");
  const again = await w.graph("alice", { agent: astronoxi.id, excluded: true });
  assert.deepEqual(names(again), names(all));
  assert.equal(again.edges.find(e => e.id === excluded.id)!.status, "excluded");

  // Provenance: publications, quotes and web sources of one concept, for its owner and agent only.
  const helios = byName.get("helios-9")!;
  const provenance = await conceptProvenance("alice", astronoxi.id, helios, w.stores);
  assert.deepEqual(provenance.publications.map(item => item.id).sort(), [p1, p2].sort());
  assert.equal(provenance.total, 2);
  const first = provenance.publications.find(item => item.id === p1)!;
  assert.deepEqual(first.quotes, ["Asterion-47 utilise le moteur Helios-9."]);
  assert.deepEqual(first.sources, [{ title: "Dépêche spatiale", url: "https://agence.example/depeche", publisher: "Agence Orbitale" }]);
  await assert.rejects(conceptProvenance("alice", orbites.id, byName.get("kappa-1")!, w.stores), /Concept introuvable/);
  await assert.rejects(conceptProvenance("bob", astronoxi.id, helios, w.stores), /ΞAgent introuvable/);
  await assert.rejects(conceptProvenance("alice", fusees.id, helios, w.stores), /ΞAgent introuvable/);

  // Empty agent, no agent, someone else's agent: nothing leaks.
  const empty = await w.graph("alice", { agent: vide.id });
  assert.deepEqual([empty.agent?.name, empty.nodes.length, empty.counts.concepts], ["Vide", 0, 0]);
  const foreign = await w.graph("alice", { agent: fusees.id });
  assert.deepEqual([foreign.agent, foreign.nodes.length, foreign.agents.some(agent => agent.id === fusees.id)], [null, 0, false]);
  const bob = await w.graph("bob", { agent: astronoxi.id });
  assert.deepEqual([bob.agent, bob.nodes.length, bob.agents.map(agent => agent.name)], [null, 0, ["Fusees"]]);
  assert.deepEqual(names(await w.graph("bob", {})), ["cache-4", "secret-9"]);
  assert.equal((await w.graph("carol", {})).agent, null);
});

test("connaissances : affichage progressif et exploration par voisinage", async t => {
  const w = await world(t);
  const agent = await w.agentOf("alice", "Constellations");
  // A hub linked to many concepts, more than the seeds: the graph starts limited, the hub's neighbours come on request.
  // Publications are short (summary ≤ 1 000 characters): the hub spans three of them.
  for (let part = 0; part < 3; part++) await w.publish("alice", agent, Array.from({ length: 10 }, (_, index) => `Satellite-${part * 10 + index + 1} utilise le relais Nexus-0.`).join(" "));
  await w.publish("alice", agent, Array.from({ length: 12 }, (_, index) => `Sonde-${index + 1} utilise le moteur Propulseur-${index + 1}.`).join(" "));
  await w.learn("alice", agent.id);
  const graph = await w.graph("alice", { agent: agent.id });
  assert.equal(graph.counts.concepts, 55);
  assert.equal(graph.nodes.length, KNOWLEDGE_LIMITS.seeds);
  assert.equal(graph.truncated, true);
  const nexus = graph.nodes.find(node => node.tag === "nexus-0")!;
  assert.equal(nexus.origin, "seed", "le concept le plus connecté est affiché en premier");
  assert.ok(graph.edges.every(e => graph.nodes.some(n => n.id === e.source) && graph.nodes.some(n => n.id === e.target)), "aucune arête vers un concept non affiché");
  const hidden = nexus.hiddenNeighbours;
  const explored = await w.graph("alice", { agent: agent.id, open: [nexus.id] });
  assert.ok(explored.nodes.length > graph.nodes.length);
  assert.equal(explored.nodes.find(node => node.id === nexus.id)!.hiddenNeighbours, Math.max(0, hidden - KNOWLEDGE_LIMITS.neighbours));
  // A focused concept outside the seeds is always displayed.
  const outside = (await w.graph("alice", { agent: agent.id, excluded: false, open: [] })).nodes.map(n => n.id);
  const focusTarget = explored.nodes.find(node => !outside.includes(node.id))!;
  const focused = await w.graph("alice", { agent: agent.id, focus: focusTarget.id });
  assert.equal(focused.nodes.find(node => node.id === focusTarget.id)!.origin, "focus");
  // The URL round-trips.
  const request = { agent: agent.id, focus: focusTarget.id, open: [nexus.id], excluded: true };
  assert.deepEqual(parseKnowledgeRequest(Object.fromEntries(new URL(knowledgeHref(request), "http://x").searchParams)), request);
  assert.deepEqual(parseKnowledgeRequest({ agent: "pas-un-uuid", open: "x,y" }), { agent: null, focus: null, open: [], excluded: false });
});
