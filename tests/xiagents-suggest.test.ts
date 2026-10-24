import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { BUILTIN_PRESETS } from "../src/lib/accounts/types";
import { GENERATOR_SLUG } from "../src/lib/graph/types";
import { draftSchema, tagSchema, type Topic } from "../src/lib/topics/types";
import { applySuggestion, draftIssues, editDraft, newDraft, presetKey, type DraftPatch } from "../src/lib/xiagents/draft";
import type { AgentProposal } from "../src/lib/xiagents/proposal";
import { extractConcepts, normalizeTerm, proposalToPatch, suggestDraft } from "../src/lib/xiagents/suggest";

const now = "2026-10-01T00:00:00.000Z";
const topic = (tag: string, name: string, scope: string, extra: Partial<Topic> = {}): Topic => ({
  id: randomUUID(), tag, name, description: "", scope, parentId: null, relatedIds: [], aliases: [], createdAt: now, updatedAt: now, createdBy: "alice", updatedBy: "alice", revision: randomUUID(), ...extra,
});

function assertShapes(patch: DraftPatch, catalog: Topic[]) {
  assert.equal(patch.sources, undefined, "jamais de sources inventées");
  assert.ok(patch.handle && GENERATOR_SLUG.test(patch.handle), `handle invalide : ${patch.handle}`);
  for (const pick of patch.topics ?? []) {
    if (pick.type === "existing") assert.ok(catalog.some(t => t.id === pick.id));
    else {
      assert.ok(pick.type === "new", "les suggestions ne produisent jamais de référence non résolue");
      assert.ok(tagSchema.safeParse(pick.draft.tag).success, pick.draft.tag);
      assert.ok(draftSchema.safeParse(pick.draft).success);
      assert.ok(pick.draft.scope.trim().length > 0);
      assert.ok(!catalog.some(t => t.tag === pick.draft.tag || t.aliases.includes(pick.draft.tag)), "pas de collision");
      assert.match(pick.key, /^[a-z0-9-]{1,40}$/);
    }
  }
  const keys = (patch.topics ?? []).flatMap(pick => pick.type === "new" ? [pick.key] : []);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok((patch.topics ?? []).length <= 5);
}
const draftWith = (patch: DraftPatch) => applySuggestion(newDraft({ presets: BUILTIN_PRESETS, timeZone: "Europe/Paris" }), patch, "rules");

test("normalizeTerm : accents, casse, ponctuation, espaces", () => {
  assert.equal(normalizeTerm("  Exoplanètes ! "), "exoplanetes");
  assert.equal(normalizeTerm("ÉNERGIE—Renouvelable"), "energie renouvelable");
  assert.equal(normalizeTerm("Cœur   de\tl’Europe"), "coeur de l europe");
  assert.deepEqual(extractConcepts("EXOPLANÈTES").map(c => c.canonical), extractConcepts("exoplanetes").map(c => c.canonical));
});

test("un seul mot connu ou inconnu", () => {
  const known = suggestDraft({ text: "IA", catalog: [], presets: BUILTIN_PRESETS });
  assert.equal(known.concepts[0].kind, "synonym");
  assert.equal(known.concepts[0].canonical, "Intelligence artificielle");
  assert.equal(known.patch.name, "Veille Intelligence artificielle");
  assert.equal(known.patch.topics?.[0].type, "new");
  assertShapes(known.patch, []);

  const unknown = suggestDraft({ text: "Ornithologie", catalog: [], presets: BUILTIN_PRESETS });
  assert.equal(unknown.concepts[0].kind, "keyword");
  const pick = unknown.patch.topics?.[0];
  assert.ok(pick?.type === "new" && pick.draft.tag === "ornithologie" && pick.draft.name === "Ornithologie");
  assert.equal(unknown.patch.handle, "veille-ornithologie");
  assert.ok(unknown.notes.some(note => note.includes("conservé tel quel")));
  assertShapes(unknown.patch, []);
  assert.deepEqual(draftIssues(draftWith(unknown.patch), []), []);
});

test("plusieurs mots-clés : Astronomie, NASA, JWST, exoplanètes", () => {
  const { patch, concepts, notes } = suggestDraft({ text: "Astronomie, NASA, JWST, exoplanètes", catalog: [], presets: BUILTIN_PRESETS });
  assert.deepEqual(concepts.map(c => c.term), ["Astronomie", "NASA", "JWST", "exoplanètes"]);
  assert.ok(concepts.every(c => c.kind === "synonym"));
  assert.equal(patch.name, "Veille Astronomie");
  assert.equal(patch.handle, "veille-astronomie");
  const names = (patch.topics ?? []).map(pick => pick.type === "new" ? pick.draft.name : "");
  assert.deepEqual(names, ["Astronomie", "Exploration spatiale", "Exoplanètes"]);
  assert.ok(notes.some(note => note.includes("JWST") && note.includes("James Webb Space Telescope") && note.includes("catalogue local")));
  assert.match(patch.perimeter!, /Couvre : .*JWST \(James Webb Space Telescope\)/);
  assert.match(patch.perimeter!, /Exclut : rumeurs, contenus non sourcés/);
  assert.equal(patch.presetKey, presetKey(BUILTIN_PRESETS[0]));
  assert.deepEqual(patch.settings, BUILTIN_PRESETS[0].settings);
  assertShapes(patch, []);
  assert.deepEqual(draftIssues(draftWith(patch), [], BUILTIN_PRESETS), []);
});

test("description longue : mots vides retirés, dédoublonnage, plafond", () => {
  const text = "Je voudrais suivre l’actualité de l’intelligence artificielle et des grands modèles de langage, notamment la régulation européenne, la recherche académique, les usages dans la santé et l’éducation, les risques, la sécurité, les startups françaises, les investissements, les puces et les centres de données, sans oublier l’IA générative et l’impact sur l’emploi et le travail des journalistes.";
  const { patch, concepts } = suggestDraft({ text, catalog: [], presets: BUILTIN_PRESETS });
  assert.ok(concepts.length <= 12);
  const normals = concepts.map(c => c.normalized);
  for (const stop of ["je", "voudrais", "suivre", "actualite", "les", "des", "et"]) assert.ok(!normals.includes(stop), stop);
  assert.equal(concepts.filter(c => c.canonical === "Intelligence artificielle").length, 1, "dédoublonné");
  assert.ok(concepts.some(c => c.kind === "keyword"));
  assert.equal(patch.name, "Veille Intelligence artificielle");
  // Unknown words of a long description are not turned into topics.
  assert.ok((patch.topics ?? []).every(pick => pick.type === "existing" || (pick.type === "new" && ["Intelligence artificielle", "Santé"].includes(pick.draft.name))));
  assertShapes(patch, []);
});

test("un topic existant est préféré à un nouveau", () => {
  const science = topic("science", "Science", "Recherche scientifique");
  const astro = topic("science.astronomie", "Astronomie", "Observations et découvertes astronomiques", { parentId: science.id });
  const catalog = [science, astro, topic("cuisine", "Cuisine", "Recettes")];
  const { patch, matches, notes } = suggestDraft({ text: "Astronomie, NASA, JWST, exoplanètes", catalog, presets: BUILTIN_PRESETS });
  const [primary, ...secondary] = patch.topics ?? [];
  assert.deepEqual(primary, { type: "existing", id: astro.id, reason: "Étiquette ou nom identique à un mot-clé." });
  assert.ok(matches[0].id === astro.id);
  assert.ok(notes.some(note => note.includes("Topic existant réutilisé : science.astronomie")));
  const fresh = secondary.flatMap(pick => pick.type === "new" ? [pick.draft] : []);
  const space = fresh.find(d => d.name === "Exploration spatiale");
  assert.equal(space?.tag, "science.espace");
  assert.equal(space?.parentId, science.id);
  const exo = fresh.find(d => d.name === "Exoplanètes");
  assert.equal(exo?.tag, "science.astronomie.exoplanetes");
  assert.equal(exo?.parentId, astro.id);
  assert.ok(!(patch.topics ?? []).some(pick => pick.type === "new" && pick.draft.name === "Astronomie"));
  assertShapes(patch, catalog);
  assert.deepEqual(draftIssues(draftWith(patch), catalog, BUILTIN_PRESETS), []);
});

test("collision d’alias : le topic existant est réutilisé", () => {
  const ai = topic("tech-ia", "IA et société", "Usages de l’IA", { aliases: ["intelligence-artificielle"] });
  const { patch } = suggestDraft({ text: "intelligence artificielle", catalog: [ai], presets: BUILTIN_PRESETS });
  assert.equal(patch.topics?.length, 1);
  assert.deepEqual(patch.topics?.[0], { type: "existing", id: ai.id, reason: "Étiquette ou nom identique à un mot-clé." });
  const keyword = topic("ornithologie", "Oiseaux", "Ornithologie");
  const second = suggestDraft({ text: "Ornithologie", catalog: [keyword], presets: [] });
  assert.equal(second.patch.topics?.[0].type, "existing");
  assert.equal(second.patch.presetKey, undefined);
});

test("aucun mot exploitable : aucune invention", () => {
  const { patch, concepts, notes } = suggestDraft({ text: "les des", catalog: [], presets: BUILTIN_PRESETS });
  assert.equal(concepts.length, 0);
  assert.equal(patch.topics, undefined);
  assert.equal(patch.name, undefined);
  assert.equal(patch.sources, undefined);
  assert.ok(notes.length > 0);
});

const proposal = (existingId: string): AgentProposal => ({
  name: "Veille spatiale", handle: "veille-spatiale", description: "Deux phrases.",
  primary: { type: "existing", id: existingId, reason: "Topic existant choisi par le modèle." },
  secondary: [{ type: "new", key: "new-1", draft: { tag: "lanceurs", name: "Lanceurs", description: "", scope: "Fusées", parentId: null, relatedIds: [] } }],
  perimeter: "Couvre les lanceurs.", charter: "",
  settings: { ...BUILTIN_PRESETS[1].settings },
  sources: [{ url: "https://www.esa.int/", domain: "www.esa.int", type: "institution", rationale: "Agence", origin: "ai" }],
  model: "local", promptVersion: "agent-proposal-v1",
});

test("proposalToPatch : sources indécises, topics et preset", () => {
  const id = randomUUID();
  const patch = proposalToPatch(proposal(id), BUILTIN_PRESETS);
  assert.equal(patch.topics?.length, 2);
  assert.deepEqual(patch.topics?.[0], { type: "existing", id, reason: "Topic existant choisi par le modèle." });
  assert.deepEqual(patch.sources, [{ url: "https://www.esa.int/", domain: "www.esa.int", type: "institution", rationale: "Agence", origin: "ai", status: "undecided" }]);
  assert.equal(patch.charter, undefined, "un texte vide n’efface rien");
  assert.equal(patch.presetKey, presetKey(BUILTIN_PRESETS[1]));
  assert.equal(proposalToPatch({ ...proposal(id), settings: { ...BUILTIN_PRESETS[1].settings, tone: "Autre" } }, BUILTIN_PRESETS).presetKey, undefined);
});

test("enrichissement IA après règles après saisie manuelle : la valeur manuelle reste", () => {
  const id = randomUUID();
  let draft = newDraft({ presets: BUILTIN_PRESETS, timeZone: "Europe/Paris" });
  draft = editDraft(draft, { name: "Mon nom à moi" });
  const rules = suggestDraft({ text: "Astronomie, NASA, JWST, exoplanètes", catalog: [], presets: BUILTIN_PRESETS });
  draft = applySuggestion(draft, rules.patch, "rules");
  assert.equal(draft.name, "Mon nom à moi");
  assert.equal(draft.handle, "veille-astronomie");
  assert.equal(draft.provenance.handle, "rules");
  draft = applySuggestion(draft, proposalToPatch(proposal(id), BUILTIN_PRESETS), "ai", "local");
  assert.equal(draft.name, "Mon nom à moi");
  assert.equal(draft.provenance.name, "manual");
  assert.equal(draft.handle, "veille-spatiale");
  assert.equal(draft.provenance.handle, "ai");
  assert.equal(draft.charter, rules.patch.charter, "le texte IA vide ne remplace pas la charte");
  assert.ok(draft.sources.every(source => source.status === "undecided"));
});
