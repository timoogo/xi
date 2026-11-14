import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { openVault } from "../src/lib/publications/vault";
import { createTopicStore } from "../src/lib/topics/store";
import { AUTO_VALIDATOR, createTopicRelationStore, humanDecision, validatedBy } from "../src/lib/topics/relations";
import { typeCue } from "../src/lib/topics/discovery";
import { KNOWLEDGE_TASK, migrateAgentKnowledge } from "../src/lib/konstruktor/knowledge";
import { explicitLink, knowledgeAnswerSchema, screenKnowledge, type KnowledgeAnswer } from "../src/lib/konstruktor/extraction";
import { knowledgeGraph } from "../src/lib/konstruktor/knowledge-graph-data";
import { edgePhrase, edgeStatus } from "../src/components/graph/knowledge-network";

// Semantic relations and conservative automatic validation (docs/konstruktor-relations.md). The sentences are those of
// Astronoxi's real publications, copied here; nothing reads the vault or the production database.
const X59 = "NASA test pilot Mike Lippert successfully completed a flight of the X-59 quiet supersonic research aircraft on Oct. 21, 2026, marking the first time the aircraft was flown by the agency.";
const TINGA = "La mission Perseverance a capturé une image de la région 'Tinga' en mars, selon NASA.";
const USDA = "L'accord entre NASA et l'USDA vise à moderniser les données agricoles du pays et explorer des idées risquées pour améliorer la science et la compétitivité américaine.";
const screen = (text: string, answer: unknown) => screenKnowledge(text, knowledgeAnswerSchema.parse(answer), typeCue);
const one = (text: string, from: string, link: string, to: string, others: string[] = [], type = "related_to") =>
  screen(text, { concepts: [from, to, ...others].map(name => ({ name })), relations: [{ from, link, to, type }] });

test("relations explicites : sens vérifié, mots exacts, en français et en anglais", () => {
  // English: the exact span from the subject to the object, adverb included, the object's article left out.
  const flight = one(X59, "Mike Lippert", "completed a flight of", "X-59", ["NASA"]);
  assert.deepEqual(flight.relations.map(r => [r.from, r.to, r.subject, r.explicit?.label]), [["Mike Lippert", "X-59", "Mike Lippert", "successfully completed a flight of"]]);
  // French, with an auxiliary and quoted name.
  const tinga = one(TINGA, "Perseverance", "a capturé une image de la région", "Tinga");
  assert.deepEqual(tinga.relations.map(r => r.explicit?.label), ["a capturé une image de la région"]);
  // A copula keeps its article; a passive reads in the sentence's order.
  assert.equal(one("Perseverance est un rover.", "Perseverance", "est un", "rover").relations[0].explicit?.label, "est un");
  const passive = one("Le X-59 est développé par la NASA.", "X-59", "est développé par", "NASA");
  assert.deepEqual(passive.relations.map(r => [r.subject, r.explicit?.label]), [["X-59", "est développé par"]]);
  // An oriented type with its cue, read from → to.
  const part = screen("Perseverance fait partie de la mission Mars 2020.", { concepts: [{ name: "Perseverance", kind: "engin" }, { name: "Mars 2020", kind: "mission" }], relations: [{ from: "Perseverance", link: "fait partie de la mission", to: "Mars 2020", type: "part_of" }] });
  assert.deepEqual(part.relations.map(r => [r.type, r.from, r.to, !!r.explicit]), [["part_of", "Perseverance", "Mars 2020", true]]);
});

test("relations ambiguës : gardées comme propositions, jamais validées", () => {
  const cases: [string, string, string, string, RegExp][] = [
    // The model's words leave out part of what links them: plausible, not demonstrated.
    [TINGA, "Perseverance", "capturé", "Tinga", /d’autres mots/],
    ["La NASA pourrait développer le X-59.", "NASA", "développer", "X-59", /hypothèse ou modalité/],
    ["La NASA ne développe pas le X-59.", "NASA", "développe", "X-59", /négation/],
    ["NASA doesn't develop the X-59.", "NASA", "develop", "X-59", /négation/],
    ["NASA will test the X-59.", "NASA", "test", "X-59", /modalité/],
    ["Does NASA develop the X-59?", "NASA", "develop", "X-59", /interrogative/],
    ["NASA, avec Boeing, développe le X-59.", "NASA", "développe", "X-59", /incise/],
    // « de la NASA » is a complement: the rover explores, not NASA.
    ["Le rover Perseverance de la NASA explore Mars.", "NASA", "explore", "Mars", /complément/],
    // The model reads it backwards: kept for review with the sentence's subject, never validated.
    ["La NASA développe le X-59.", "X-59", "développe", "NASA", /autre sens/],
  ];
  for (const [text, from, link, to, why] of cases) {
    const [relation] = one(text, from, link, to).relations;
    assert.ok(relation, `${text} : proposition conservée`);
    assert.equal(relation.explicit, null, text);
    assert.match(relation.why ?? "", why, text);
  }
  assert.equal(one("La NASA développe le X-59.", "X-59", "développe", "NASA").relations[0].subject, "NASA");
  // The model's confidence never validates anything by itself.
  const confident = screen(TINGA, { concepts: [{ name: "Perseverance" }, { name: "Tinga" }], relations: [{ from: "Perseverance", link: "capturé", to: "Tinga", type: "related_to", confidence: 1 }] });
  assert.equal(confident.relations[0].explicit, null);
});

test("deux concepts présents sans relation réelle, citation exacte mais relation fausse : rejetées", () => {
  // Coordinated or merely co-present: no relation at all.
  const usda = screen(USDA, { concepts: [{ name: "NASA" }, { name: "USDA" }], relations: [{ from: "NASA", link: "et", to: "USDA", type: "related_to" }, { from: "NASA", link: "vise", to: "USDA", type: "related_to" }] });
  assert.equal(usda.relations.length, 0);
  // The real Astronoxi proposal « X-59 → NASA : completed a flight of »: the sentence is quoted exactly, but Mike Lippert
  // flew the aircraft. Rejected, whichever direction the model gives.
  for (const [from, to] of [["X-59", "NASA"], ["NASA", "X-59"]]) {
    const wrong = one(X59, from, "completed a flight of", to, ["Mike Lippert"]);
    assert.equal(wrong.relations.length, 0);
    assert.match(wrong.rejected.at(-1)!.reason, /Mike Lippert » s’interpose/);
  }
  assert.equal(explicitLink("NASA et Boeing.", "NASA", "Boeing", "et", []).explicit, null);
});

/** A light world: real topic and relation stores on a temporary vault, publications and agents in memory. */
async function world(t: { after: (fn: () => Promise<void>) => void }) {
  const path = await mkdtemp(join(tmpdir(), "xi-konstruktor-relations-"));
  const db = new Database(":memory:");
  t.after(async () => { db.close(); await rm(path, { recursive: true, force: true }); });
  migrateAgentKnowledge(db);
  const vault = await openVault(path), topics = createTopicStore({ vault, db });
  const owner = "alice";
  const agents = [{ id: randomUUID(), owner, name: "Astronoxi", handle: "astronoxi" }, { id: randomUUID(), owner, name: "Orbites", handle: "orbites" }];
  type Publication = { id: string; authorId: string; status: string; revision: string; contentRevision: string; summary: string; messages: { body: string }[]; sources: { url: string; title: string; publisher: string | null }[]; publishedAt: string | null; visibility: string };
  const publications = new Map<string, Publication>();
  const publicationStore = {
    ensureIndexed: async () => {}, agentPublications: () => [],
    get: async (viewer: { id: string }, id: string) => { const item = publications.get(id); if (!item || viewer.id !== owner) throw new Error("Publication indisponible."); return item; },
    agentMemory: async (viewer: string, agent: string) => (db.prepare("SELECT publication, topic, excerpt, revision FROM xi_agent_knowledge WHERE owner = ? AND agent = ?").all(viewer, agent) as { publication: string; topic: string; excerpt: string; revision: string }[])
      .filter(row => publications.get(row.publication)?.contentRevision === row.revision),
  };
  const relations = createTopicRelationStore({ vault, db, topics, readable: async viewer => viewer === owner ? new Set(publications.keys()) : new Set() });
  const accounts = { watchAgents: async () => agents, list: async () => agents };
  const services = { db, topics, accounts, publications: publicationStore, relations };
  const publish = (agent: string, text: string, id: string = randomUUID()) => {
    const revision = randomUUID();
    publications.set(id, { id, authorId: agent, status: "published", revision, contentRevision: revision, summary: text, messages: [{ body: text }], sources: [{ url: "https://nasa.example", title: "NASA", publisher: "NASA" }], publishedAt: null, visibility: "private" });
    return id;
  };
  /** One Konstruktor analysis of a publication with the model's answer given. */
  const analyse = (agent: string, publication: string, answer: KnowledgeAnswer) => KNOWLEDGE_TASK.run({
    owner, input: { publication, agent, revision: publications.get(publication)!.contentRevision }, services,
    llm: () => ({ ok: true, resolved: { model: "local" }, inference: { complete: async () => JSON.stringify(answer) } }), log: () => {},
  } as never) as Promise<Record<string, unknown>>;
  /** The owner's recorded relations, as stored (every status). */
  const stored = async () => relations.learnedAmong(owner, new Set((await topics.visible(owner)).personal.map(topic => topic.id)), new Set(publications.keys()));
  const topicId = async (tag: string) => (await topics.visible(owner)).personal.find(topic => topic.tag === tag)!.id;
  const graph = (selected: string[], excluded = false) => knowledgeGraph(owner, { agents: selected, all: false, focus: null, open: [], excluded }, { accounts, topics, relations, publications: publicationStore } as never);
  return { owner, agents, publications, relations, topics, publish, analyse, stored, topicId, graph };
}
const answer = (from: string, link: string, to: string, type = "related_to"): KnowledgeAnswer => ({ concepts: [{ name: from }, { name: to }], relations: [{ from, link, to, type, confidence: 0.8 }] });

test("validation automatique : tracée, sans doublon, réanalyse idempotente, retirée si la publication change", async t => {
  const w = await world(t);
  const [astronoxi] = w.agents;
  const p = w.publish(astronoxi.id, "La NASA développe le X-59.");
  assert.deepEqual(await w.analyse(astronoxi.id, p, answer("NASA", "développe", "X-59")), { outcome: "done", concepts: 2, reused: 0, created: 2, ignored: 0, relations: 1, validated: 1, kept: 0 });
  let [relation] = await w.stored();
  assert.deepEqual([relation.status, validatedBy(relation), humanDecision(relation), relation.history.at(-1)?.by], ["accepted", "auto", null, AUTO_VALIDATOR]);
  assert.match(relation.history.at(-1)!.reason!, /« développe »/);
  assert.deepEqual([relation.evidence[0].label, relation.evidence[0].subject, relation.evidence[0].explicit], ["développe", await w.topicId("nasa"), true]);

  // Full re-analysis, with the model naming the ends the other way round: the same relation, the same evidence.
  await w.analyse(astronoxi.id, p, answer("NASA", "développe", "X-59"));
  await w.analyse(astronoxi.id, p, { concepts: [{ name: "X-59" }, { name: "NASA" }], relations: [{ from: "NASA", link: "développe", to: "X-59", type: "related_to" }] });
  const again = await w.stored();
  assert.deepEqual([again.length, again[0].id, again[0].evidence.length, again[0].history.length], [1, relation.id, 1, relation.history.length]);

  // The publication now hedges: the automatic validation is withdrawn, traced; the record is kept.
  w.publish(astronoxi.id, "La NASA pourrait développer le X-59.", p);
  const changed = await w.analyse(astronoxi.id, p, answer("NASA", "développer", "X-59"));
  assert.deepEqual([changed.validated, changed.relations], [0, 1]);
  [relation] = await w.stored();
  assert.deepEqual([relation.status, relation.evidence.length, relation.evidence[0].explicit, relation.history.at(-1)?.action, relation.history.at(-1)?.by], ["proposed", 1, undefined, "reproposed", AUTO_VALIDATOR]);
});

test("décisions humaines prioritaires : correction, exclusion, confirmation, toutes réversibles", async t => {
  const w = await world(t);
  const [astronoxi] = w.agents;
  const p = w.publish(astronoxi.id, "La NASA développe le X-59.");
  await w.analyse(astronoxi.id, p, answer("NASA", "développe", "X-59"));
  const [auto] = await w.stored();

  // Correction of the type: a re-analysis neither replaces it nor recreates the original type.
  await w.relations.correct(w.owner, auto.id, { type: "influences", reason: "La NASA conçoit l’appareil." });
  const kept = await w.analyse(astronoxi.id, p, answer("NASA", "développe", "X-59"));
  assert.deepEqual([kept.kept, kept.validated], [1, 0]);
  let all = await w.stored();
  assert.deepEqual(all.map(r => [r.id, r.type, r.status]), [[auto.id, "influences", "accepted"]]);
  // Another type proposed on a pair a human decided on stays a proposal, even explicit.
  const other = await w.relations.proposePersonal(w.owner, { source: auto.source, target: auto.target, type: "part_of", origin: "inference", createdBy: "local-model:test", confidence: 0.9, acceptable: true, justification: "La publication relie « NASA » à « X-59 » par « développe ».", evidence: [{ kind: "publication", ref: `publication:${p}`, publication: p, excerpt: "La NASA développe le X-59.", label: "développe", explicit: true }] });
  assert.equal(other.status, "proposed");
  // The correction can be undone explicitly: back to the original type, still a human decision.
  const undone = await w.relations.correct(w.owner, auto.id, { type: "related_to" });
  assert.deepEqual([undone.type, validatedBy(undone)], ["related_to", "human"]);

  // Exclusion: never revived nor validated by a re-analysis; restoring it is the human's to do.
  await w.relations.correct(w.owner, auto.id, { status: "excluded", reason: "Erroné." });
  await w.analyse(astronoxi.id, p, answer("NASA", "développe", "X-59"));
  all = await w.stored();
  assert.equal(all.find(r => r.id === auto.id)!.status, "excluded");
  assert.ok(!all.some(r => r.type === "related_to" && r.status !== "excluded"));
  const restored = await w.relations.correct(w.owner, auto.id, { status: "accepted" });
  assert.deepEqual([restored.status, restored.history.at(-1)?.action, restored.history.at(-1)?.by], ["accepted", "restored", w.owner]);

  // Confirming an automatic validation makes it a human decision.
  const q = w.publish(astronoxi.id, "Perseverance explore Mars.");
  await w.analyse(astronoxi.id, q, answer("Perseverance", "explore", "Mars"));
  const explored = (await w.stored()).find(r => r.evidence.some(e => e.publication === q))!;
  assert.equal(validatedBy(explored), "auto");
  const confirmed = await w.relations.correct(w.owner, explored.id, { status: "accepted" });
  assert.deepEqual([validatedBy(confirmed), confirmed.history.at(-1)?.by], ["human", w.owner]);
  // A re-analysis that no longer finds it never withdraws a human decision.
  w.publish(astronoxi.id, "Perseverance pourrait explorer Mars.", q);
  await w.analyse(astronoxi.id, q, answer("Perseverance", "explorer", "Mars"));
  const still = (await w.stored()).find(r => r.id === explored.id)!;
  assert.deepEqual([still.status, still.evidence.map(e => [e.excerpt, !!e.explicit])], ["accepted", [["Perseverance explore Mars.", true], ["Perseverance pourrait explorer Mars.", false]]]);
});

test("plusieurs ΞAgents : statut et preuves par agent, contradictions, aucune validation empruntée", async t => {
  const w = await world(t);
  const [astronoxi, orbites] = w.agents;
  const a = w.publish(astronoxi.id, "La NASA développe le X-59.");
  // Orbites' sentence links the same concepts without stating it: same relation, its own evidence, not explicit.
  const b = w.publish(orbites.id, "La NASA, selon Boeing, développe le X-59.");
  await w.analyse(astronoxi.id, a, answer("NASA", "développe", "X-59"));
  await w.analyse(orbites.id, b, answer("NASA", "développe", "X-59"));
  const stored = await w.stored();
  assert.equal(stored.length, 1, "un seul enregistrement : les mémoires ne sont pas fusionnées, les preuves sont séparées");

  const both = await w.graph([astronoxi.id, orbites.id]);
  const [edge] = both.edges;
  assert.deepEqual([edge.status, edge.validation], ["accepted", "auto"]);
  assert.deepEqual(edge.provenance.map(item => [item.agent, item.status, item.validation, item.evidence.map(e => e.explicit)]), [
    [astronoxi.id, "accepted", "auto", [true]], [orbites.id, "proposed", null, [false]],
  ]);
  // Orbites alone: its proposal does not become validated because Astronoxi's evidence is.
  const alone = (await w.graph([orbites.id])).edges[0];
  assert.deepEqual([alone.status, alone.validation, alone.provenance.map(item => item.agent)], ["proposed", null, [orbites.id]]);
  assert.deepEqual((await w.graph([orbites.id])).counts, { concepts: 2, publications: 1, accepted: 0, proposed: 1, excluded: 0 });
  const name = (id: string) => both.nodes.find(node => node.id === id)!.name;
  assert.equal(edgePhrase(edge, name), "NASA — développe → X-59");
  assert.equal(edgeStatus(edge).label, "Validée automatiquement");
  assert.equal(edgeStatus(alone).label, "Proposée, à examiner");

  // A contradiction (Orbites says the opposite): kept as its own evidence, never validated.
  const c = w.publish(orbites.id, "La NASA ne développe pas le X-59.");
  await w.analyse(orbites.id, c, answer("NASA", "ne développe pas", "X-59"));
  const contradicted = (await w.graph([astronoxi.id, orbites.id])).edges[0];
  assert.deepEqual(contradicted.provenance.map(item => [item.status, item.count]), [["accepted", 1], ["proposed", 2]]);
  assert.ok(contradicted.labels.some(label => label.text === "ne développe pas"), "la contradiction reste visible dans les mots du texte");

  // A human decision holds for every agent.
  await w.relations.correct(w.owner, edge.id, { status: "excluded", reason: "Contesté." });
  const decided = await w.graph([astronoxi.id, orbites.id], true);
  assert.deepEqual(decided.edges[0].provenance.map(item => [item.status, item.validation]), [["excluded", "human"], ["excluded", "human"]]);
  assert.equal((await w.graph([astronoxi.id, orbites.id])).edges.length, 0, "exclue : visible seulement sur demande");
});

test("anciennes relations : lues telles quelles, puis validées si une réanalyse établit leur preuve", async t => {
  const w = await world(t);
  const [astronoxi] = w.agents;
  const p = w.publish(astronoxi.id, "La NASA développe le X-59.");
  await w.analyse(astronoxi.id, p, { concepts: [{ name: "NASA" }, { name: "X-59" }], relations: [] });
  const [nasa, x59] = [await w.topicId("nasa"), await w.topicId("x-59")];
  // Recorded before labels and explicit checks existed: proposed, its words read back from the justification.
  const legacy = await w.relations.proposePersonal(w.owner, { source: nasa, target: x59, type: "related_to", origin: "inference", createdBy: "local-model:ancien", confidence: 0.6, acceptable: false, justification: "La publication relie « NASA » à « X-59 » par « développe ».", evidence: [{ kind: "publication", ref: `publication:${p}`, publication: p, excerpt: "La NASA développe le X-59." }] });
  const before = (await w.graph([astronoxi.id])).edges[0];
  assert.deepEqual([before.status, before.validation, before.labels.map(l => l.text)], ["proposed", null, ["développe"]]);
  // Same excerpt, now checked: the evidence is upgraded in place, no duplicate, and the relation validated.
  await w.analyse(astronoxi.id, p, answer("NASA", "développe", "X-59"));
  const [after] = await w.stored();
  assert.deepEqual([after.id, after.evidence.length, after.evidence[0].explicit, after.status, validatedBy(after)], [legacy.id, 1, true, "accepted", "auto"]);
});
