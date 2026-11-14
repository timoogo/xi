import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { openVault } from "../src/lib/publications/vault";
import { createTopicStore } from "../src/lib/topics/store";
import { createTopicRelationStore } from "../src/lib/topics/relations";
import { typeCue } from "../src/lib/topics/discovery";
import { KNOWLEDGE_TASK } from "../src/lib/konstruktor/knowledge";
import { knowledgeAnswerSchema, MAX_CONCEPTS, screenKnowledge, sentences, type KnowledgeAnswer } from "../src/lib/konstruktor/extraction";

// The three Astronoxi publications, with the answers qwen3:1.7b actually gave to the new prompt (seed 0).
const USDA = "L'accord entre NASA et l'USDA vise à moderniser les données agricoles du pays et explorer des idées risquées pour améliorer la science et la compétitivité américaine.";
const TINGA = "La mission Perseverance a capturé une image de la région 'Tinga' en mars, selon NASA.";
const X59 = "NASA test pilot Mike Lippert successfully completed a flight of the X-59 quiet supersonic research aircraft on Oct. 21, 2026, marking the first time the aircraft was flown by the agency.";
const screen = (text: string, answer: unknown) => screenKnowledge(text, knowledgeAnswerSchema.parse(answer), typeCue);
const names = (result: ReturnType<typeof screen>) => result.concepts.map(item => item.name);
const links = (result: ReturnType<typeof screen>) => result.relations.map(item => `${item.from} > ${item.to} : ${item.type}`);

test("extraction : entités nommées gardées, fragments, verbes et dates écartés", () => {
  const usda = screen(USDA, { concepts: [
    { name: "NASA", kind: "organisation" }, { name: "l'USDA", kind: "organisation" }, { name: "données agricoles", kind: "notion" },
    { name: "explorer", kind: "verbe" }, { name: "moderniser les données agricoles", kind: "notion" },
    { name: "améliorer la science et la compétitivité américaine du pays", kind: "notion" },
  ], relations: [] });
  assert.deepEqual(names(usda), ["NASA", "USDA", "données agricoles"], "article retiré, nom tel qu’écrit");
  assert.deepEqual(usda.rejected.map(item => item.reason), ["verbe ou qualificatif, pas un concept", "action (verbe et complément), pas un concept", "fragment de phrase (plus de six mots)"]);

  const x59 = screen(X59, { concepts: [{ name: "Mike Lippert", kind: "person" }, { name: "X-59", kind: "engin" }, { name: "Oct. 21, 2026", kind: "date" }, { name: "21 octobre" }], relations: [] });
  assert.deepEqual(names(x59), ["Mike Lippert", "X-59"]);
  assert.equal(x59.rejected.length, 2);
  // A mission named with a number is not a date.
  assert.deepEqual(names(screen("Le rover fait partie de Mars 2020.", { concepts: [{ name: "Mars 2020", kind: "mission" }], relations: [] })), ["Mars 2020"]);
});

test("extraction : citation trouvée dans le texte, concept absent écarté, doublons fusionnés, plafond", () => {
  const result = screen(TINGA, { concepts: [{ name: "Perseverance" }, { name: "PERSEVERANCE" }, { name: "la mission Perseverance" }, { name: "Tinga" }, { name: "Curiosity" }], relations: [] });
  assert.deepEqual(names(result), ["Perseverance", "mission Perseverance", "Tinga"]);
  assert.ok(result.concepts.every(item => item.quote === TINGA), "la provenance est la phrase de la publication, pas un texte du modèle");
  assert.deepEqual(result.rejected, [{ item: "Curiosity", reason: "absent du texte" }]);
  // Quotes « 'Tinga' » or plural/accents differences do not block a name actually written in the text.
  assert.deepEqual(names(screen("Les régions observées.", { concepts: [{ name: "région observée" }], relations: [] })), ["région observée"]);
  // Sentences are not cut after abbreviations or inside dates.
  assert.deepEqual(sentences(`${X59} Le vol a duré une heure.`), [X59, "Le vol a duré une heure."]);
  const many = Array.from({ length: 15 }, (_, index) => `Sonde-${index}`);
  assert.equal(screen(many.join(" "), { concepts: many.map(name => ({ name })), relations: [] }).concepts.length, MAX_CONCEPTS);
});

test("extraction : relations ancrées dans le texte, orientées, jamais inventées", () => {
  const tinga = screen(TINGA, {
    concepts: [{ name: "Perseverance" }, { name: "Tinga" }, { name: "NASA" }],
    relations: [
      { from: "Perseverance", link: "a capturé une image de la région", to: "Tinga", type: "related_to" },
      { from: "Tinga", link: "selon", to: "NASA", type: "related_to" },
      { from: "Perseverance", link: "est opérée par", to: "NASA", type: "part_of" },
    ],
  });
  assert.deepEqual(links(tinga), ["Perseverance > Tinga : related_to"]);
  assert.deepEqual(tinga.rejected.map(item => item.reason), ["attribution d’une source, pas une relation", "aucune phrase ne relie les deux concepts par ces mots"]);

  // English text: the link is the text's own words; part_of without its cue is kept as related_to, not as a false nature.
  const x59 = screen(X59, {
    concepts: [{ name: "Mike Lippert" }, { name: "X-59" }, { name: "NASA" }],
    relations: [{ from: "Mike Lippert", link: "successfully completed a flight of the", to: "X-59", type: "part_of" }],
  });
  assert.deepEqual(links(x59), ["Mike Lippert > X-59 : related_to"]);
  assert.match(x59.relations[0].note ?? "", /non établi/);

  // A part_of written the other way round follows the sentence, whatever the model's direction.
  const reversed = screen("Le rover Perseverance fait partie de la mission Mars 2020.", {
    concepts: [{ name: "Perseverance", kind: "engin" }, { name: "Mars 2020", kind: "mission" }],
    relations: [{ from: "Mars 2020", link: "fait partie de la mission", to: "Perseverance", type: "part_of" }],
  });
  assert.deepEqual(links(reversed), ["Perseverance > Mars 2020 : part_of"]);

  // Two concepts merely coordinated, or a « link » that is not between them, are not a relation.
  const usda = screen(USDA, {
    concepts: [{ name: "NASA" }, { name: "USDA" }, { name: "données agricoles" }, { name: "idées risquées" }],
    relations: [
      { from: "NASA", link: "vise", to: "USDA", type: "related_to" },
      { from: "données agricoles", link: "explorer", to: "idées risquées", type: "similar_to" },
      { from: "NASA", link: "", to: "USDA", type: "related_to" },
      { from: "NASA", link: "développe", to: "X-59", type: "related_to" },
    ],
  });
  assert.equal(usda.relations.length, 0);
  assert.equal(usda.rejected.length, 4);
});

test("extraction : une publication qui n’affirme aucune relation n’en produit aucune", () => {
  const text = "La NASA publiera son rapport annuel la semaine prochaine.";
  const result = screen(text, { concepts: [{ name: "NASA" }, { name: "rapport annuel" }], relations: [{ from: "NASA", link: "publiera son", to: "rapport annuel", type: "influences" }] });
  // The words are there: a related_to is acceptable; « influences » has no cue and is not kept as such.
  assert.deepEqual(links(result), ["NASA > rapport annuel : related_to"]);
  assert.equal(screen(text, { concepts: [{ name: "NASA" }, { name: "rapport annuel" }], relations: [] }).relations.length, 0);
});

test("Konstruktor : texte anglais, nom affiché conservé, relation prouvée par la phrase, résumé non répété", async t => {
  const path = await mkdtemp(join(tmpdir(), "xi-extraction-"));
  const db = new Database(":memory:");
  t.after(async () => { db.close(); await rm(path, { recursive: true, force: true }); });
  const vault = await openVault(path), topics = createTopicStore({ vault, db });
  const agent = randomUUID(), id = randomUUID();
  const publication = { id, authorId: agent, status: "published", revision: "r1", contentRevision: "r1", summary: X59, messages: [{ body: X59 }], sources: [{ url: "https://nasa.example" }] };
  const publications = { ensureIndexed: async () => {}, agentPublications: () => [], get: async () => publication };
  const relations = createTopicRelationStore({ vault, db, topics, readable: async viewer => viewer === "alice" ? new Set([id]) : new Set() });
  const prompts: string[] = [];
  const answer: KnowledgeAnswer = {
    concepts: [{ name: "Mike Lippert", kind: "personne" }, { name: "X-59", kind: "engin" }, { name: "Oct. 21, 2026", kind: "date" }],
    relations: [{ from: "Mike Lippert", link: "successfully completed a flight of the", to: "X-59", type: "related_to", confidence: 0.9 }],
  };
  const llm = () => ({ ok: true, resolved: { model: "local" }, inference: { complete: async ({ prompt }: { prompt: string }) => { prompts.push(prompt); return JSON.stringify(answer); } } });
  const services = { db, topics, accounts: { watchAgents: async () => [{ id: agent, owner: "alice" }] }, publications, relations };
  const result = await KNOWLEDGE_TASK.run({ owner: "alice", input: { publication: id, agent, revision: "r1" }, services, llm, log: () => {} } as never);
  assert.deepEqual(result, { outcome: "done", concepts: 2, reused: 0, created: 2, ignored: 1, relations: 1, validated: 1, kept: 0 });
  assert.equal(prompts[0].split(X59).length - 1, 1, "le résumé identique au message n’est envoyé qu’une fois");
  const mine = (await topics.visible("alice")).personal;
  assert.deepEqual(mine.map(topic => [topic.tag, topic.name]).sort(), [["mike-lippert", "Mike Lippert"], ["x-59", "X-59"]]);
  const [relation] = (await relations.relationsOf("alice", mine.find(topic => topic.tag === "x-59")!.id)).visible;
  assert.equal(relation.evidence[0].excerpt, X59);
  // The label is the sentence's exact span, without the object's article.
  assert.match(relation.justification, /« successfully completed a flight of »/);
});
