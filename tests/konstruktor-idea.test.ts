import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { BUILTIN_PRESETS } from "../src/lib/accounts/types";
import { DEFAULT_BLOUB_CONFIG } from "../src/lib/bloub/config";
import { accountDraftSchema } from "../src/lib/accounts/types";
import { answerProblems, candidates, hierarchy, IDEA_MAX_SUBAGENT_DEPTH, IDEA_MAX_TOPICS, IDEA_MIN_TIMEOUT_MS, isDescriptiveName, isSpecific, sameTopic, subAgentProblem, type IdeaPlan } from "../src/lib/konstruktor/idea";
import { ideaSteps, type IdeaTaskView } from "../src/lib/konstruktor/idea-steps";
import { InferenceUnavailableError } from "../src/lib/watch/inference";
import type { LLMBindOptions } from "../src/lib/watch/llm-binding";
import type { ChatRequest } from "../src/lib/watch/inference";
import { files, json, model, seed, setup } from "./helpers/konstruktor";

type App = Awaited<ReturnType<typeof setup>>;
const topic = (name: string, domain: string, extra: Record<string, unknown> = {}) => ({ name, scope: `Actualité : ${name.toLowerCase()}.`, domain, ...extra });
/** Invented ΞAgent names of the simulated answers, by domain. */
const NAMES: Record<string, string> = {
  "Neurotechnologies médicales": "Neurolys", "Autonomie et handicap": "Libravie", Neurotechnologies: "Synapsia", "Filière hydrogène": "Hydrion", Hydrogène: "Hydrion",
  Cyclisme: "Pédalix", Jazz: "Swingo", Volcanologie: "Magmatik", Fiscalité: "Taxomètre", Échecs: "Roquette", "Énergies marines": "Marémotrix", "Musique baroque": "Clavelune",
  Énergie: "Voltaire", Apiculture: "Butinette", Saké: "Kōjiro", "Astronomie amateur": "Orbitelle", "Sciences humaines": "Agora", "Santé publique": "Vigisan",
};
const domain = (name: string, extra: Record<string, unknown> = {}) => ({ name, agent: NAMES[name], description: `Veille ${name.toLowerCase()}.`, ...extra });

const isPlacement = (request: ChatRequest) => /tu ranges de nouveaux groupes/.test(request.system ?? "");
/**
 * The model double for both calls of the task: `plan` answers the generation calls (numbered among
 * them; `requests` holds them only), `place` the grouped placement call (`placements` holds those).
 */
function ideaModel(plan: (call: number) => string, place: (request: ChatRequest) => unknown = () => ({ decisions: [] })) {
  const requests: ChatRequest[] = [], placements: ChatRequest[] = [];
  const { binding } = model(request => isPlacement(request) ? (placements.push(request), json(place(request))) : (requests.push(request), plan(requests.length)));
  return { binding, requests, placements };
}

async function generate(app: App, owner = "alice", text = "Une idée de veille") {
  const requestId = randomUUID();
  await app.tasks.request(owner, "konstruktor", { requestId, task: "plan-idea", input: { text } });
  await app.tasks.close();
  const request = app.tasks.get(owner, "konstruktor", requestId);
  return { requestId, request, plan: request.result as IdeaPlan };
}
const ownAgents = async (app: App, owner = "alice") => (await app.accounts.list(owner)).filter(account => account.owner === owner);
const tags = (plan: IdeaPlan) => plan.groups.map(group => [group.agent.type, group.agent.handle, group.topics.map(item => `${item.existing ? (item.attached ? "=" : "~") : "+"}${item.tag}`)]);
async function newTopic(app: App, owner: string, tag: string, name: string) {
  return (await app.topics.create(owner, randomUUID(), { tag, name, description: "", scope: `${name}.`, parentId: null, relatedIds: [] })).topic;
}
async function agent(app: App, owner: string, handle: string, name: string, topicIds: string[], description = "", perimeter = "") {
  const id = randomUUID(), preset = BUILTIN_PRESETS[0];
  await app.accounts.createAgent(owner, id, { draft: { handle, name, description, primaryTopicId: topicIds[0], secondaryTopicIds: topicIds.slice(1), presetId: preset.id, presetVersion: preset.version, settings: preset.settings, active: false, modelRef: null, validationMode: "human" }, profile: { perimeter, charter: "" }, bloub: DEFAULT_BLOUB_CONFIG });
  return id;
}
/** Alice's real-looking catalogue: ΞAgents on generic topics, and an unrelated aircraft topic. */
async function realCatalog(app: App) {
  const science = await newTopic(app, "alice", "science", "science");
  const competitivite = await newTopic(app, "alice", "competitivite", "compétitivité");
  const informatique = await newTopic(app, "alice", "informatique", "Informatique");
  const usa = await newTopic(app, "alice", "ameliorer-la-science-et-la-competitivite-americaine", "Améliorer la science et la compétitivité américaine");
  const x59 = await newTopic(app, "alice", "x-59-quiet-supersonic-research-aircraft", "X 59 quiet supersonic research aircraft");
  return {
    x59,
    astronoxi: await agent(app, "alice", "astronoxi", "Astronoxi", [science.id, x59.id]),
    hackxing: await agent(app, "alice", "hackxxing", "HackXing", [competitivite.id]),
    politiks: await agent(app, "alice", "politiks", "ΞAgent @politiks", [informatique.id]),
    gaia: await agent(app, "alice", "gaia", "gaïa", [usa.id]),
  };
}

test("konstruktor idea: the real case — no off-topic ΞAgent or topic reused, the model's stray references are ignored, the catalogue is not in the prompt", { timeout: 30_000 }, async t => {
  // What qwen3 did: valid names, but `existing` references picked at random among the listed items.
  const answer = {
    topics: [
      topic("IA pour le diagnostic médical", "Neurotechnologies médicales", { existing: "T1" }),
      topic("Interfaces cerveau-machine pour la rééducation motrice", "Neurotechnologies médicales", { existing: "T5" }),
      topic("Informatique des neuroprothèses", "Neurotechnologies médicales", { existing: "T3" }),
      topic("Robotique d’assistance aux personnes handicapées", "Autonomie et handicap", { existing: "T2" }),
      topic("Exosquelettes pour la mobilité", "Autonomie et handicap"),
    ],
    domains: [domain("Neurotechnologies médicales", { existing: "A1" }), domain("Autonomie et handicap", { existing: "A2" })],
  };
  const { binding, requests } = model(() => json(answer));
  const app = await setup(t, binding);
  await seed(app);
  const { astronoxi, hackxing, politiks, gaia } = await realCatalog(app);
  const before = await files(app.root);
  const { request, plan } = await generate(app, "alice", "IA, robotique et interfaces cerveau-machine pour la médecine et l’autonomie des personnes handicapées.");
  assert.equal(request.state, "done");
  assert.deepEqual(tags(plan), [
    ["new", "neurolys", ["+ia-pour-le-diagnostic-medical", "+interfaces-cerveau-machine-pour-la-reeducation-motrice", "+informatique-des-neuroprotheses"]],
    ["new", "libravie", ["+robotique-assistance-aux-personnes-handicapees", "+exosquelettes-pour-la-mobilite"]],
  ]);
  const reused = new Set(plan.groups.flatMap(group => group.agent.type === "existing" ? [group.agent.id] : []));
  for (const id of [astronoxi, hackxing, politiks, gaia]) assert.ok(!reused.has(id), "Astronoxi (science), HackXing (compétitivité), @politiks (informatique), gaïa: never reused");
  assert.ok(plan.groups.flatMap(group => group.topics).every(item => !item.existing), "no generic or unrelated topic reused (« Informatique des neuroprothèses » ≠ #informatique; nothing ≈ X-59)");
  const prompt = requests[0].prompt;
  for (const absent of ["X 59", "science", "compétitivité", "informatique", "\"T1\"", "\"A1\""]) assert.ok(!prompt.includes(absent), `${absent} is not offered to the model`);
  assert.match(prompt, /Noms d’ΞAgents déjà pris, à ne pas reprendre ni imiter de près :\n\[.*"Astronoxi".*"HackXing".*\]/, "existing ΞAgents: their names only, as names to avoid");
  assert.deepEqual(await files(app.root), before, "nothing written by the generation");
});

test("konstruktor idea: a ΞAgent is not reused for its name alone; a generic shared word does not make two topics equal", { timeout: 30_000 }, async t => {
  const answer = {
    topics: [topic("Neurotechnologies non invasives", "Neurotechnologies"), topic("Implants cérébraux", "Neurotechnologies"), topic("Recherche aéronautique supersonique", "Neurotechnologies"), topic("Éthique des neurotechnologies", "Neurotechnologies"), topic("Régulation des implants", "Neurotechnologies")],
    domains: [domain("Neurotechnologies")],
  };
  const { binding } = model(() => json(answer));
  const app = await setup(t, binding);
  await seed(app);
  const informatique = await newTopic(app, "alice", "informatique", "Informatique");
  await newTopic(app, "alice", "recherche-aeronautique", "Recherche aéronautique");
  await agent(app, "alice", "neurotechnologies", "Neurotechnologies", [informatique.id]);
  // Bob already holds the handle the invented name gives.
  await agent(app, "bob", "synapsia", "Le Synapsia de Bob", [informatique.id]);
  const { plan } = await generate(app);
  const [group] = plan.groups;
  assert.deepEqual(group.agent, { type: "new", name: "Synapsia", handle: "synapsia-2", about: "Veille neurotechnologies.", parent: null, note: null }, "the ΞAgent named after the domain is not reused; the taken handle gets a suffix");
  assert.equal(group.topics.find(item => item.name === "Recherche aéronautique supersonique")!.existing, null, "« recherche aéronautique » in common is not the same subject");
});

test("konstruktor idea: a truly compatible ΞAgent is reused through the topic it already follows; its other topics are added on confirmation", { timeout: 30_000 }, async t => {
  const answer = {
    topics: [topic("Production d’hydrogène vert", "Filière hydrogène"), topic("Stockage de l’hydrogène", "Filière hydrogène"), topic("Mobilité hydrogène lourde", "Filière hydrogène"), topic("Piles à combustible", "Filière hydrogène"), topic("Réglementation européenne de l’hydrogène", "Filière hydrogène")],
    domains: [domain("Filière hydrogène")],
  };
  const { binding } = model(() => json(answer));
  const app = await setup(t, binding);
  await seed(app);
  const production = await newTopic(app, "alice", "production-d-hydrogene-vert", "Production d'hydrogène vert");
  const veille = await agent(app, "alice", "veille-h2", "Veille H2", [production.id]);
  const { requestId, plan } = await generate(app);
  assert.deepEqual(plan.groups[0].agent, { type: "existing", id: veille, handle: "veille-h2", name: "Veille H2", note: "ΞAgent existant @veille-h2 réutilisé : il suit déjà #production-d-hydrogene-vert." });
  assert.deepEqual(tags(plan), [["existing", "veille-h2", ["=production-d-hydrogene-vert", "+stockage-de-hydrogene", "+mobilite-hydrogene-lourde", "+piles-a-combustible", "+reglementation-europeenne-de-hydrogene"]]]);
  const catalogBefore = (await app.topics.list()).length;
  const { results } = await app.konstruktor.createFromIdea("alice", { requestId });
  assert.deepEqual(results.map(result => [result.status, result.agentId]), [["completed", veille]]);
  const catalog = await app.topics.list();
  assert.equal(catalog.length, catalogBefore + 4, "only the missing topics");
  const updated = (await ownAgents(app)).find(account => account.id === veille)!;
  assert.deepEqual([updated.editorial!.primaryTopicId, ...updated.editorial!.secondaryTopicIds].map(id => catalog.find(item => item.id === id)!.tag), ["production-d-hydrogene-vert", "stockage-de-hydrogene", "mobilite-hydrogene-lourde", "piles-a-combustible", "reglementation-europeenne-de-hydrogene"]);
  assert.equal(updated.name, "Veille H2", "the rest of the ΞAgent is kept");
});

test("konstruktor idea: 5 linked topics → 1 new ΞAgent; nothing before confirmation; confirming twice creates once", { timeout: 30_000 }, async t => {
  const answer = { topics: ["Hydrogène vert", "Électrolyseurs industriels", "Stations hydrogène", "Piles à combustible", "Stockage hydrogène"].map(name => topic(name, "Filière hydrogène")), domains: [domain("Filière hydrogène")] };
  const { binding } = model(() => json(answer));
  const app = await setup(t, binding);
  await seed(app);
  const before = await files(app.root);
  const catalogBefore = (await app.topics.list()).length;
  const { requestId, plan } = await generate(app);
  assert.deepEqual(tags(plan), [["new", "hydrion", ["+hydrogene-vert", "+electrolyseurs-industriels", "+stations-hydrogene", "+piles-a-combustible", "+stockage-hydrogene"]]]);
  assert.deepEqual(await files(app.root), before);
  await assert.rejects(app.konstruktor.createFromIdea("bob", { requestId }), { status: 404 }, "another user's plan is unknown");
  assert.deepEqual((await app.konstruktor.createFromIdea("alice", { requestId })).results.map(result => result.status), ["completed"]);
  assert.deepEqual((await app.konstruktor.createFromIdea("alice", { requestId })).results.map(result => result.status), ["completed"]);
  assert.equal((await ownAgents(app)).length, 2);
  assert.equal((await app.topics.list()).length, catalogBefore + 5);
});

test("konstruktor idea: independent topics → several ΞAgents; mixed case → grouped by domain", { timeout: 30_000 }, async t => {
  const independent = { topics: [topic("Cyclisme professionnel", "Cyclisme"), topic("Jazz manouche", "Jazz"), topic("Volcans actifs", "Volcanologie"), topic("Fiscalité des PME", "Fiscalité"), topic("Échecs en ligne", "Échecs")], domains: ["Cyclisme", "Jazz", "Volcanologie", "Fiscalité", "Échecs"].map(name => domain(name)) };
  const mixed = { topics: [topic("Éoliennes en mer", "Énergies marines"), topic("Hydroliennes fluviales", "Énergies marines"), topic("Énergie houlomotrice", "Énergies marines"), topic("Opéra baroque", "Musique baroque"), topic("Répertoire de clavecin", "Musique baroque")], domains: [domain("Énergies marines"), domain("Musique baroque")] };
  let call = 0;
  const { binding } = model(() => json(call++ === 0 ? independent : mixed));
  const app = await setup(t, binding);
  await seed(app);
  const first = await generate(app);
  assert.equal(first.plan.groups.length, 5);
  assert.ok(first.plan.groups.every(group => group.agent.type === "new" && group.topics.length === 1));
  const second = await generate(app);
  assert.deepEqual(tags(second.plan), [
    ["new", "maremotrix", ["+eoliennes-en-mer", "+hydroliennes-fluviales", "+energie-houlomotrice"]],
    ["new", "clavelune", ["+opera-baroque", "+repertoire-de-clavecin"]],
  ]);
  assert.deepEqual((await app.konstruktor.createFromIdea("alice", { requestId: second.requestId })).results.map(result => result.status), ["completed", "completed"]);
});

test("konstruktor idea: vague topics are corrected once with explicit feedback, then reported; invalid JSON is reported; nothing is created", { timeout: 30_000 }, async t => {
  const vague = json({ topics: ["Production", "Stockage d’énergie", "Mobilité électrique", "Réseaux intelligents", "Science"].map(name => topic(name, "Énergie")), domains: [domain("Énergie")] });
  const fixed = json({ topics: ["Production d’hydrogène", "Stockage d’énergie", "Mobilité électrique", "Réseaux intelligents", "Recherche sur les batteries"].map(name => topic(name, "Énergie")), domains: [domain("Énergie")] });
  const answers = [vague, fixed, vague, vague, "Voici mes idées : hydrogène, éolien…", "toujours pas du JSON"];
  const { binding, requests } = model((_, call) => answers[call - 1]);
  const app = await setup(t, binding);
  await seed(app);
  const before = await files(app.root);

  const corrected = await generate(app);
  assert.equal(corrected.request.state, "done");
  assert.match(requests[1].prompt, /Le topic « Production » est trop générique/);
  assert.match(requests[1].prompt, /Le topic « Science » est trop générique/);
  assert.ok(corrected.plan.groups[0].topics.some(item => item.name === "Production d’hydrogène"));

  const still = await generate(app);
  assert.equal(still.request.state, "failed");
  assert.match(still.request.message!, /Proposition du modèle inutilisable : Le topic « Production » est trop générique.*Rien n’a été créé/);
  await assert.rejects(app.konstruktor.createFromIdea("alice", { requestId: still.requestId }), { status: 409, message: /La génération a échoué/ });

  const invalid = await generate(app);
  assert.equal(invalid.request.state, "failed");
  assert.match(invalid.request.message!, /aucun objet JSON lisible.*Rien n’a été créé/);
  assert.equal(requests.length, 6, "one correction or one format retry, no more");
  assert.deepEqual(ideaSteps(invalid.request as unknown as IdeaTaskView).map(step => step.state), ["done", "error", "waiting", "waiting", "waiting"]);
  // Only the corrected plan exists, and it was never confirmed.
  assert.deepEqual(await files(app.root), before);
});

test("konstruktor idea: its own longer deadline only; a timeout ends the task with an explanation, without being run again", { timeout: 30_000 }, async t => {
  const { binding, requests } = model(() => { throw new InferenceUnavailableError("Délai d’inférence dépassé.", null, "timeout"); });
  const seen: (LLMBindOptions | undefined)[] = [];
  const app = await setup(t, (owner, options?: LLMBindOptions) => { seen.push(options); return binding(); });
  await seed(app);
  const { request } = await generate(app);
  assert.deepEqual(seen, [{ minTimeoutMs: IDEA_MIN_TIMEOUT_MS }]);
  assert.equal(request.state, "failed", "not waiting for a retry");
  assert.equal(requests.length, 1);
  assert.match(request.message!, /n’a pas répondu dans le délai.*Rien n’a été créé.*modèle plus rapide/);
  assert.deepEqual(ideaSteps(request as unknown as IdeaTaskView).map(step => step.state), ["done", "error", "waiting", "waiting", "waiting"]);
});

test("konstruktor idea: the steps come from the persisted run as it happens; reading them again (reload) never relaunches the task", { timeout: 30_000 }, async t => {
  const answer = { topics: ["Hydrogène vert", "Électrolyseurs industriels", "Stations hydrogène", "Piles à combustible", "Stockage hydrogène"].map(name => topic(name, "Filière hydrogène")), domains: [domain("Filière hydrogène")] };
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { binding, requests } = model(async () => { await gate; return json(answer); });
  const app = await setup(t, binding);
  await seed(app);
  const requestId = randomUUID();
  await app.tasks.request("alice", "konstruktor", { requestId, task: "plan-idea", input: { text: "La filière hydrogène." } });
  while (!requests.length) await new Promise(resolve => setTimeout(resolve, 10));
  const during = app.tasks.get("alice", "konstruktor", requestId) as unknown as IdeaTaskView;
  assert.equal(during.state, "running");
  assert.deepEqual(ideaSteps(during).map(step => step.state), ["done", "running", "waiting", "waiting", "waiting"]);
  assert.ok(during.runs.at(-1)!.logs.some(log => /Appel 1 au modèle local/.test(log.message)));
  const reloaded = app.tasks.get("alice", "konstruktor", requestId) as unknown as IdeaTaskView;
  assert.deepEqual(ideaSteps(reloaded), ideaSteps(during));
  release();
  await app.tasks.close();
  const after = app.tasks.get("alice", "konstruktor", requestId) as unknown as IdeaTaskView;
  assert.equal(after.state, "done");
  assert.deepEqual(ideaSteps(after).map(step => step.state), ["done", "done", "done", "done", "done"]);
  assert.equal(requests.length, 1, "one generation, whatever the number of reads");
});

test("konstruktor idea: an existing ΞAgent that already follows everything is left unchanged; a partial failure keeps what succeeded and resumes without duplicates", { timeout: 30_000 }, async t => {
  const answer = { topics: [topic("Production d’hydrogène vert", "Hydrogène"), topic("Apiculture urbaine", "Apiculture"), topic("Frelons asiatiques", "Apiculture"), topic("Saké japonais", "Saké"), topic("Rizières en terrasses", "Saké")], domains: [domain("Hydrogène"), domain("Apiculture"), domain("Saké")] };
  const { binding } = model(() => json(answer));
  const app = await setup(t, binding);
  const { topic: astronomy } = await seed(app);
  const production = await newTopic(app, "alice", "production-d-hydrogene-vert", "Production d’hydrogène vert");
  const veille = await agent(app, "alice", "veille-h2", "Veille H2", [production.id]);
  const { requestId, plan } = await generate(app);
  assert.deepEqual(plan.groups.map(group => group.agent.handle), ["veille-h2", "butinette", "kojiro"]);
  // Between preview and confirmation, someone takes the last handle.
  await agent(app, "bob", "kojiro", "Kojiro", [astronomy.id]);
  const first = await app.konstruktor.createFromIdea("alice", { requestId });
  assert.deepEqual(first.results.map(result => result.status), ["unchanged", "completed", "failed"]);
  assert.equal(first.results[0].agentId, veille);
  assert.match(first.results[2].error!, /Le handle @kojiro est déjà réservé/);
  const catalog = await app.topics.list();
  assert.ok(catalog.some(item => item.tag === "frelons-asiatiques"));
  assert.ok(!catalog.some(item => item.tag === "rizieres-en-terrasses"), "nothing of the failed group is written");
  const second = await app.konstruktor.createFromIdea("alice", { requestId });
  assert.deepEqual(second.results.map(result => result.status), ["unchanged", "completed", "failed"]);
  assert.equal(second.results[1].agentId, first.results[1].agentId);
  assert.deepEqual((await ownAgents(app)).map(item => item.handle).sort(), ["butinette", "veille-astro", "veille-h2"]);
  assert.equal((await app.topics.list()).length, catalog.length, "no duplicate on retry");
});

test("konstruktor idea: no quota — a simple intention gives few topics, a vast one more than five; creative, distinct names and valid unique handles; confirmation with any count", { timeout: 30_000 }, async t => {
  const simple = { topics: [topic("Comètes visibles à l’œil nu", "Astronomie amateur"), topic("Pluies d’étoiles filantes", "Astronomie amateur")], domains: [domain("Astronomie amateur")] };
  const vast = {
    topics: [
      topic("Interfaces cerveau-machine pour la rééducation", "Neurotechnologies médicales"), topic("Implants cochléaires connectés", "Neurotechnologies médicales"), topic("IA pour le diagnostic médical", "Neurotechnologies médicales"),
      topic("Exosquelettes pour la mobilité", "Autonomie et handicap"), topic("Domotique pour personnes handicapées", "Autonomie et handicap"), topic("Fauteuils roulants autonomes", "Autonomie et handicap"),
      topic("Éthique de l’augmentation humaine", "Sciences humaines"), topic("Droit des neurodonnées", "Sciences humaines"),
    ],
    domains: [domain("Neurotechnologies médicales"), domain("Autonomie et handicap"), domain("Sciences humaines")],
  };
  let call = 0;
  const { binding, requests } = model(() => json(call++ === 0 ? simple : vast));
  const app = await setup(t, binding);
  await seed(app);
  const prompt = (await generate(app), requests[0].prompt + requests[0].system);
  assert.doesNotMatch(prompt, /exactement|5 topics|cinq/, "no fixed number asked");
  assert.match(prompt, /N’ajoute jamais un topic pour faire du nombre/);

  const big = await generate(app);
  const first = app.tasks.list("alice", "konstruktor").at(-1)!;
  const small = first.result as IdeaPlan;
  assert.deepEqual(tags(small), [["new", "orbitelle", ["+cometes-visibles-a-oeil-nu", "+pluies-etoiles-filantes"]]]);
  assert.deepEqual([small.groups[0].agent.name, (small.groups[0].agent as { about: string }).about, small.groups[0].domain], ["Orbitelle", "Veille astronomie amateur.", "Astronomie amateur"], "name: identity; about: mission; domain: grouping");
  assert.equal(big.plan.groups.reduce((sum, group) => sum + group.topics.length, 0), 8, "a vast intention: more than five topics");
  assert.deepEqual(big.plan.groups.map(group => [group.agent.name, group.agent.handle, group.topics.length]), [["Neurolys", "neurolys", 3], ["Libravie", "libravie", 3], ["Agora", "agora", 2]]);
  for (const group of big.plan.groups) assert.ok(accountDraftSchema.shape.handle.safeParse(group.agent.handle).success);

  const catalogBefore = (await app.topics.list()).length;
  for (const requestId of [first.requestId, big.requestId]) assert.ok((await app.konstruktor.createFromIdea("alice", { requestId })).results.every(result => result.status === "completed"));
  assert.equal((await app.topics.list()).length, catalogBefore + 10);
  const handles = (await ownAgents(app)).map(item => item.handle).sort();
  assert.deepEqual(handles, ["agora", "libravie", "neurolys", "orbitelle", "veille-astro"]);
  const names = (await ownAgents(app)).map(item => item.name);
  assert.equal(new Set(names).size, names.length);
});

test("konstruktor idea: descriptive, shared, existing or same-prefix ΞAgent names are sent back once for correction; the technical ceiling is enforced", { timeout: 30_000 }, async t => {
  const topics = [topic("Comètes visibles à l’œil nu", "Astronomie amateur"), topic("Vaccination des adolescents", "Santé publique")];
  const named = (a: string, b: string) => json({ topics, domains: [{ ...domain("Astronomie amateur"), agent: a }, { ...domain("Santé publique"), agent: b }] });
  const tooMany = json({ topics: Array.from({ length: IDEA_MAX_TOPICS + 1 }, (_, i) => topic(`Sujet précis numéro ${i + 1}`, "Astronomie amateur")), domains: [domain("Astronomie amateur")] });
  const answers = [
    named("Astronomie amateur", "Santé publique"), named("Orbitelle", "Vigisan"),
    named("Xinova", "Xisanté"), named("Orbitelle", "Vigisan"),
    named("Veille astro", "Vigisan"), named("Orbitelle", "Orbitelle"),
    tooMany, tooMany,
  ];
  const { binding, requests } = ideaModel(n => answers[n - 1]);
  const app = await setup(t, binding);
  await seed(app);

  const descriptive = await generate(app);
  assert.equal(descriptive.request.state, "done");
  assert.match(requests[1].prompt, /Le nom « Astronomie amateur » décrit le domaine au lieu de donner une identité/);
  assert.deepEqual(descriptive.plan.groups.map(group => group.agent.name), ["Orbitelle", "Vigisan"]);

  const prefixed = await generate(app);
  assert.equal(prefixed.request.state, "done");
  assert.match(requests[3].prompt, /partagent le même préfixe ou suffixe/);

  const taken = await generate(app);
  assert.equal(taken.request.state, "failed", "still wrong after the correction: reported, nothing created");
  assert.match(requests[4].prompt, /"Veille astro"/, "names already taken are listed");
  assert.match(requests[5].prompt, /Le nom « Veille astro » est déjà celui d’un ΞAgent existant/);
  assert.match(taken.request.message!, /Deux ΞAgents portent le même nom/);

  const ceiling = await generate(app);
  assert.equal(ceiling.request.state, "failed");
  assert.match(ceiling.request.message!, /non conforme au format attendu/);
});

test("konstruktor idea: a topic's relevance does not depend on its number of words — precise single words accepted, generic ones rejected", () => {
  for (const name of ["Comètes", "Exoplanètes", "Neuroprothèses", "Cybersécurité", "Production d’hydrogène", "Science ouverte", "Œnologie"]) assert.ok(isSpecific(name), `${name} is a subject`);
  for (const name of ["Science", "Sciences", "Production", "Innovation", "Recherche", "Technologie", "Recherche et innovation", "Les technologies", "Data"]) assert.ok(!isSpecific(name), `${name} is too generic`);
  const answer = (...names: string[]) => ({ topics: names.map(name => topic(name, "Astronomie amateur")), domains: [domain("Astronomie amateur")] });
  assert.deepEqual(answerProblems(answer("Comètes", "Pluies d’étoiles filantes")), []);
  assert.deepEqual(answerProblems(answer("Comètes", "Science")), ["Le topic « Science » est trop générique : nommez le sujet précis à suivre (un mot suffit s’il est précis)."]);
  assert.deepEqual(answerProblems(answer("Comètes", "comète")), ["Deux topics désignent le même sujet : fusionnez-les ou remplacez-en un."]);
});

test("konstruktor idea: single-word topics — exact reuse of a precise one only, generic ones never; the real case stays clean; confirmation creates them", { timeout: 30_000 }, async t => {
  const answer = { topics: [topic("Comètes", "Astronomie amateur"), topic("Pluies d’étoiles filantes", "Astronomie amateur")], domains: [domain("Astronomie amateur")] };
  const { binding } = model(() => json(answer));
  const app = await setup(t, binding);
  await seed(app);
  const { astronoxi, hackxing, politiks, gaia } = await realCatalog(app);
  const science = (await app.topics.list()).find(item => item.tag === "science")!;
  assert.equal(sameTopic("Science", [science]), null, "an existing generic topic is never reused, even on an exact match");
  const comets = await newTopic(app, "alice", "cometes", "Comètes");
  assert.equal(sameTopic("comète", [comets])?.id, comets.id, "a precise single word is reused on an exact match");
  assert.equal(sameTopic("Comètes interstellaires", [comets]), null, "a different subject sharing the word is not");

  const { requestId, request, plan } = await generate(app, "alice", "Je veux suivre les comètes et les pluies d’étoiles filantes visibles depuis la France.");
  assert.equal(request.state, "done", "one-word topic accepted, no correction round");
  assert.deepEqual(tags(plan), [["new", "orbitelle", ["~cometes", "+pluies-etoiles-filantes"]]], "few topics; #cometes reused; no existing ΞAgent (Astronoxi follows science and X-59, not comets)");
  for (const id of [astronoxi, hackxing, politiks, gaia]) assert.ok(!plan.groups.some(group => group.agent.type === "existing" && group.agent.id === id));

  const { results } = await app.konstruktor.createFromIdea("alice", { requestId });
  assert.deepEqual(results.map(result => result.status), ["completed"]);
  const catalog = await app.topics.list();
  const created = (await ownAgents(app)).find(item => item.handle === "orbitelle")!;
  assert.deepEqual([created.editorial!.primaryTopicId, ...created.editorial!.secondaryTopicIds].map(id => catalog.find(item => item.id === id)!.tag), ["cometes", "pluies-etoiles-filantes"]);
  assert.equal(catalog.filter(item => item.tag === "cometes").length, 1);
});

test("konstruktor idea: ΞAgent names that only add a function word to their domain are descriptive; invented names and wordplay are identities", () => {
  const cases: [string, string[]][] = [
    ["Agent Comète", ["Astronomie", "comète", "pluie d’étoiles filantes"]],
    ["Bot Astronomie", ["Astronomie amateur", "Comètes"]],
    ["Assistant Médical", ["Technologie médicale", "IA pour le diagnostic médical"]],
    ["Veille Robotique", ["Robotique d’assistance", "Exosquelettes"]],
    ["AI Agent", ["Intelligence artificielle", "Modèles de langage"]],
    ["Assistant Science", ["Vulgarisation", "Musées"]],
  ];
  for (const [name, described] of cases) assert.ok(isDescriptiveName(name, described), `${name} is a job title`);
  const creative: [string, string[]][] = [
    ["Astronoxi", ["Astronomie", "Exoplanètes"]], ["HackXing", ["Cybersécurité", "Hacking éthique"]], ["Politiiks", ["Politique", "Élections"]],
    ["Cybermed", ["Technologie médicale", "Robotique médicale"]], ["Humanova", ["Évolution humaine", "Capacités humaines"]], ["Orbitelle", ["Astronomie", "Comètes"]],
  ];
  for (const [name, described] of creative) assert.ok(!isDescriptiveName(name, described), `${name} is an identity`);
  const answer = (agent: string) => ({ topics: [topic("Comètes", "Astronomie")], domains: [{ name: "Astronomie", agent, description: "Suivre les comètes." }] });
  assert.deepEqual(answerProblems(answer("Agent Comète")), ["Le nom « Agent Comète » décrit le domaine au lieu de donner une identité : invente un nom original et évocateur."]);
  assert.deepEqual(answerProblems(answer("Astronoxi"), ["Astronoxi"]), ["Le nom « Astronoxi » est déjà celui d’un ΞAgent existant : invente un autre nom."], "collision with an existing ΞAgent");
  assert.deepEqual(answerProblems(answer("Orbitelle")), []);
});

test("konstruktor idea: a descriptive ΞAgent name gets one correction, then a readable error; topics and reuse rules are unchanged", { timeout: 30_000 }, async t => {
  const topics = [topic("Comètes", "Astronomie"), topic("Pluies d’étoiles filantes", "Astronomie")];
  const named = (agent: string) => json({ topics, domains: [{ name: "Astronomie", agent, description: "Suivre les comètes et les étoiles filantes." }] });
  const answers = [named("Agent Comète"), named("Orbitelle"), named("Bot Astronomie"), named("Veille Comètes")];
  const { binding, requests } = ideaModel(n => answers[n - 1]);
  const app = await setup(t, binding);
  await seed(app);
  await realCatalog(app);
  // Bob holds the handle the corrected name gives: the handle stays valid and unique.
  await agent(app, "bob", "orbitelle", "Orbitelle de Bob", [(await app.topics.list())[0].id]);
  const corrected = await generate(app, "alice", "Je veux suivre les comètes et les pluies d’étoiles filantes.");
  assert.equal(corrected.request.state, "done");
  assert.match(requests[1].prompt, /Le nom « Agent Comète » décrit le domaine/);
  assert.deepEqual(tags(corrected.plan), [["new", "orbitelle-2", ["+cometes", "+pluies-etoiles-filantes"]]], "same topics; no existing ΞAgent reused; handle with a suffix");
  assert.equal(corrected.plan.groups[0].agent.name, "Orbitelle");
  assert.equal((corrected.plan.groups[0].agent as { about: string }).about, "Suivre les comètes et les étoiles filantes.", "the mission stays apart from the name");

  const failed = await generate(app);
  assert.equal(failed.request.state, "failed", "a bad name is never accepted silently");
  assert.match(failed.request.message!, /Proposition du modèle inutilisable : Le nom « Veille Comètes » décrit le domaine.*Rien n’a été créé/);
  assert.equal(requests.length, 4, "one correction per generation, no more");
});

/** Alice's organisation: roots with real missions, one sub-agent (`politiks.france`), unrelated ΞAgents. */
async function organisation(app: App) {
  const exo = await newTopic(app, "alice", "exoplanetes", "Exoplanètes");
  const world = await newTopic(app, "alice", "elections-dans-le-monde", "Élections dans le monde");
  const legislatives = await newTopic(app, "alice", "elections-legislatives-francaises", "Élections législatives françaises");
  const failles = await newTopic(app, "alice", "failles-logicielles", "Failles logicielles");
  const marine = await newTopic(app, "alice", "biodiversite-marine", "Biodiversité marine");
  return {
    astronoxi: await agent(app, "alice", "astronoxi", "Astronoxi", [exo.id], "Suit les découvertes astronomiques, l’astrophysique, les exoplanètes et les missions spatiales.",
      "Couvre : astrophysique, exoplanètes, missions spatiales.\nExclut : rumeurs, contenus non sourcés ou invérifiables, contenus promotionnels."),
    politiks: await agent(app, "alice", "politiks", "Politiks", [world.id], "Exploration de la politique mondiale : institutions, élections, gouvernance."),
    france: await agent(app, "alice", "politiks.france", "Politiks France", [legislatives.id], "La politique française : élections et institutions en France."),
    hackxing: await agent(app, "alice", "hackxxing", "HackXing", [failles.id], "Hacking éthique, failles logicielles et sécurité offensive."),
    gaia: await agent(app, "alice", "gaia", "Gaïa", [marine.id], "Biodiversité marine et océans."),
    exo,
  };
}
/** The label (A1, A2…) under which the placement prompt shows a ΞAgent. */
const label = (request: ChatRequest, name: string) => new RegExp(`(A\\d+) — ${JSON.stringify(name)}`).exec(request.prompt)?.[1];
const decision = (group: string, choice: string, agent?: string | null, specialty: string | null = null, reason = "Sa mission couvre ces sujets.") => ({ group, choice, agent, specialty, reason });

test("konstruktor idea: reuse if relevant, specialise if needed, create otherwise — previewed without writing, confirmed through deployments, resumed after a partial failure", { timeout: 30_000 }, async t => {
  let answer = {
    topics: [topic("Comètes", "Astronomie des comètes"), topic("Pluies d’étoiles filantes", "Astronomie des comètes"), topic("Atmosphères d’exoplanètes", "Exoplanètes habitables"), topic("Biosignatures", "Exoplanètes habitables"), topic("Frelons asiatiques", "Apiculture"), topic("Apiculture urbaine", "Apiculture")],
    domains: [{ ...domain("Astronomie amateur"), name: "Astronomie des comètes", description: "Suivre les comètes et les étoiles filantes." }, { ...domain("Neurotechnologies"), name: "Exoplanètes habitables", description: "Les exoplanètes où la vie serait possible." }, domain("Apiculture")],
  };
  const { binding, requests, placements } = ideaModel(() => json(answer), request => ({ decisions: [
    decision("G1", "specialize", label(request, "Astronoxi"), "comètes", "Les comètes sont une spécialisation de l’astronomie d’Astronoxi."),
    decision("G2", "attach", label(request, "Astronoxi"), null, "Astronoxi suit déjà les exoplanètes."),
  ] }));
  const app = await setup(t, binding);
  await seed(app);
  const org = await organisation(app);
  const before = await files(app.root);
  const { requestId, request, plan } = await generate(app, "alice", "Les comètes, les exoplanètes habitables et l’apiculture.");
  assert.equal(request.state, "done");
  assert.deepEqual(await files(app.root), before, "nothing written before confirmation");

  // Topic generation stays blind to the organisation; the placement call sees missions, under local labels only.
  assert.ok(!/astrophysique|Exploration de la politique|Hacking éthique/.test(requests[0].prompt + requests[0].system), "no mission in the generation prompt (names only, as names to avoid)");
  assert.equal(placements.length, 1, "one grouped call for all the groups");
  const shown = placements[0].prompt;
  assert.match(shown, /G1 — domaine "Astronomie des comètes"/);
  assert.match(shown, /mission "Suit les découvertes astronomiques/);
  assert.doesNotMatch(shown, /Exclut|rumeurs/, "boilerplate exclusions left out of the mission");
  assert.doesNotMatch(shown, /Apiculture|HackXing|Gaïa|Politiks/, "a group or ΞAgent without shared subject is not shown");
  assert.doesNotMatch(shown, /[0-9a-f]{8}-[0-9a-f]{4}-/, "no identifier given to the model");

  assert.deepEqual(plan.groups.map(group => [group.agent.type, group.agent.handle, group.agent.type === "new" ? group.agent.parent?.handle ?? null : null, group.topics.map(item => item.tag)]), [
    ["new", "astronoxi.cometes", "astronoxi", ["cometes", "pluies-etoiles-filantes"]],
    ["existing", "astronoxi", null, ["atmospheres-exoplanetes", "biosignatures"]],
    ["new", "butinette", null, ["frelons-asiatiques", "apiculture-urbaine"]],
  ]);
  assert.equal(plan.groups[0].agent.name, "Astronoxi Comètes");
  assert.match(plan.groups[0].agent.note!, /Spécialisation de @astronoxi : Les comètes sont une spécialisation/);
  assert.match(plan.groups[1].agent.note!, /Rattaché à @astronoxi.*Astronoxi suit déjà les exoplanètes/);
  assert.equal(plan.groups[2].agent.note, null);

  // Between preview and confirmation, the parent changes handle: only its sub-agent fails, nothing of it is written.
  const rename = async (handle: string) => {
    const current = (await ownAgents(app)).find(item => item.id === org.astronoxi)!;
    const { revision, ...editorial } = current.editorial!;
    const draft = { handle, name: current.name, description: current.description, primaryTopicId: editorial.primaryTopicId, secondaryTopicIds: editorial.secondaryTopicIds, presetId: editorial.presetId, presetVersion: editorial.presetVersion, settings: editorial.settings, active: editorial.active, modelRef: editorial.modelRef, validationMode: editorial.validationMode };
    await app.accounts.update("alice", org.astronoxi, revision, draft);
  };
  await rename("astronoxi-old");
  const first = await app.konstruktor.createFromIdea("alice", { requestId });
  assert.deepEqual(first.results.map(result => result.status), ["failed", "completed", "completed"]);
  assert.match(first.results[0].error!, /parent @astronoxi n’existe plus.*a changé de handle/);
  assert.ok(!(await app.topics.list()).some(item => item.tag === "cometes"));
  const second = await app.konstruktor.createFromIdea("alice", { requestId });
  assert.deepEqual(second.results.map(result => result.status), ["failed", "completed", "completed"], "the stale sub-agent stays refused");
  assert.deepEqual(second.results.slice(1).map(result => result.agentId), first.results.slice(1).map(result => result.agentId), "resumed without recreating");
  const agentsAfter = (await ownAgents(app)).length;
  assert.equal((await ownAgents(app)).filter(item => item.handle === "butinette").length, 1);

  // Regenerated (the comets only): the sub-agent follows its parent's current handle and is created.
  answer = { topics: answer.topics.slice(0, 2), domains: answer.domains.slice(0, 1) };
  const again = await generate(app, "alice", "Les comètes, les exoplanètes habitables et l’apiculture.");
  assert.equal(again.plan.groups[0].agent.handle, "astronoxi-old.cometes");
  const third = await app.konstruktor.createFromIdea("alice", { requestId: again.requestId });
  assert.equal(third.results[0].status, "completed");
  assert.equal((await ownAgents(app)).length, agentsAfter + 1, "only the sub-agent is added");
  const accounts = await app.accounts.list("alice");
  const sub = accounts.find(item => item.handle === "astronoxi-old.cometes")!;
  assert.deepEqual(hierarchy(accounts).get(sub.id), { parentId: org.astronoxi, depth: 1 }, "a real sub-agent of Astronoxi in the graph's hierarchy");
  const catalog = await app.topics.list();
  const tagsOf = (id: string) => { const editorial = accounts.find(item => item.id === id)!.editorial!; return [editorial.primaryTopicId, ...editorial.secondaryTopicIds].map(topicId => catalog.find(item => item.id === topicId)!.tag); };
  assert.deepEqual(tagsOf(sub.id), ["cometes", "pluies-etoiles-filantes"]);
  assert.deepEqual(tagsOf(org.astronoxi), ["exoplanetes", "atmospheres-exoplanetes", "biosignatures"]);
  assert.equal((await ownAgents(app)).filter(item => item.handle.startsWith("astronoxi")).length, 2, "no duplicate");
  assert.equal(catalog.filter(item => item.tag === "cometes").length, 1);
});

test("konstruktor idea: several groups placed on one ΞAgent become one group; a sub-agent rather than its root when it fits better; never deeper than allowed", { timeout: 30_000 }, async t => {
  let specialize = false;
  const answer = () => ({
    topics: [topic("Atmosphères d’exoplanètes", "Exoplanètes habitables"), topic("Télescope spatial James Webb", "Télescopes spatiaux"),
      ...(specialize ? [topic("Conseils municipaux en France", "Élections en France"), topic("Maires de France", "Élections en France")] : [topic("Élections municipales françaises", "Élections en France"), topic("Sondages électoraux en France", "Élections en France")])],
    domains: [{ name: "Exoplanètes habitables", agent: "Vitalia", description: "Les exoplanètes habitables." }, { name: "Télescopes spatiaux", agent: "Optiscope", description: "Les grands télescopes spatiaux." }, { name: "Élections en France", agent: "Urnella", description: "Suivre les élections françaises." }],
  });
  const { binding, placements } = ideaModel(() => json(answer()), request => ({ decisions: [
    decision("G1", "attach", label(request, "Astronoxi")), decision("G2", "attach", label(request, "Astronoxi")),
    specialize ? decision("G3", "specialize", label(request, "Politiks France"), "municipales") : decision("G3", "attach", label(request, "Politiks France"), null, "Politiks France suit la politique française."),
  ] }));
  const app = await setup(t, binding);
  await seed(app);
  const org = await organisation(app);

  const { requestId, plan } = await generate(app);
  const shown = placements[0].prompt;
  const root = label(placements[0], "Politiks")!, sub = label(placements[0], "Politiks France")!;
  assert.match(shown, new RegExp(`G3 — .*candidats : (${root}, ${sub}|${sub}, ${root})`), "the root and its sub-agent are both candidates");
  assert.match(shown, new RegExp(`${sub} — "Politiks France" ; .*sous-agent de ${root}, sans sous-agent`));
  assert.doesNotMatch(shown, /HackXing|Gaïa/, "unrelated ΞAgents are never offered");
  assert.deepEqual(tags(plan), [["existing", "astronoxi", ["+atmospheres-exoplanetes", "+telescope-spatial-james-webb"]], ["existing", "politiks.france", ["+elections-municipales-francaises", "+sondages-electoraux-en-france"]]]);
  assert.match(plan.notes.join(" "), /« Télescopes spatiaux » regroupé avec « Exoplanètes habitables » sous @astronoxi/);
  const { results } = await app.konstruktor.createFromIdea("alice", { requestId });
  assert.deepEqual(results.map(result => [result.status, result.agentId]), [["completed", org.astronoxi], ["completed", org.france]], "one deployment per ΞAgent");

  specialize = true;
  const deeper = await generate(app);
  const group = deeper.plan.groups.find(item => item.domain === "Élections en France")!;
  assert.deepEqual([group.agent.handle, group.agent.type === "new" && group.agent.parent?.handle], ["politiks.municipales", "politiks"], "no sub-agent of a sub-agent: specialised under the root");
  assert.match(deeper.plan.notes.join(" "), /@politiks\.france est au niveau de sous-agent maximal \(1\) ; la spécialisation est proposée sous @politiks/);
  assert.equal(IDEA_MAX_SUBAGENT_DEPTH, 1);
  const accounts = await app.accounts.list("alice");
  const france = accounts.find(item => item.id === org.france)!;
  assert.match(subAgentProblem({ handle: "politiks.france.paris", parent: { id: france.id, handle: france.handle, name: france.name } }, accounts, "alice")!, /niveau de sous-agent maximal/);
  assert.match(subAgentProblem({ handle: "politiks.x", parent: { id: org.politiks, handle: "politiks", name: "Politiks" } }, accounts, "bob")!, /ne vous appartient pas/);
  assert.equal(subAgentProblem({ handle: "politiks.x", parent: { id: org.politiks, handle: "politiks", name: "Politiks" } }, accounts, "alice"), null);
});

test("konstruktor idea: ambiguity and stray answers end in a new ΞAgent — unrelated domain, ΞAgent outside the group's candidates, single topic, unusable answer", { timeout: 30_000 }, async t => {
  const answer = {
    topics: [topic("Comètes", "Astronomie d’observation"), topic("Éclipses solaires", "Astronomie d’observation"), topic("Saxophone ténor", "Jazz"), topic("Clubs de jazz parisiens", "Jazz"), topic("Satellites espions", "Espace militaire")],
    domains: [{ ...domain("Astronomie amateur"), name: "Astronomie d’observation" }, domain("Jazz"), { name: "Espace militaire", agent: "Sentinox", description: "Les missions spatiales militaires." }],
  };
  let reply: (request: ChatRequest) => unknown = () => "pas du JSON";
  const { binding, placements } = ideaModel(() => json(answer), request => reply(request));
  const app = await setup(t, binding);
  await seed(app);
  await organisation(app);

  const unusable = await generate(app);
  assert.equal(unusable.request.state, "done", "the organisation step never blocks the generation");
  assert.equal(placements.length, 2, "one format retry, then given up");
  assert.ok(unusable.plan.groups.every(group => group.agent.type === "new" && !group.agent.parent));
  assert.match(unusable.plan.notes.join(" "), /réponse du modèle inexploitable/);
  assert.doesNotMatch(placements[0].prompt, /Jazz/, "no ΞAgent shares a subject with jazz: not even offered");

  // Both Astronoxi and @veille-astro could fit astronomy; the model names a ΞAgent that is a candidate of another group only, then a specialisation of one topic.
  reply = request => ({ decisions: [decision("G1", "attach", label(request, "Gaïa") ?? "A9"), decision("G2", "specialize", label(request, "Astronoxi"), "satellites")] });
  const stray = await generate(app);
  const shown = placements.at(-1)!.prompt;
  assert.match(shown, /G1 — domaine "Astronomie d’observation".*candidats : A\d, A\d/, "two compatible ΞAgents: the model must choose, the code does not guess");
  assert.deepEqual(tags(stray.plan).map(([type, handle]) => [type, handle]), [["new", "orbitelle"], ["new", "swingo"], ["existing", "astronoxi"]]);
  assert.match(stray.plan.notes.join(" "), /« Astronomie d’observation » : le ΞAgent désigné par le modèle n’était pas un candidat de ce groupe/);
  assert.match(stray.plan.notes.join(" "), /« Espace militaire » : un seul topic, pas de sous-agent ; il est rattaché à @astronoxi/);
});

test("konstruktor idea: candidates come from subject words, not from the wording of a mission", () => {
  const politiks = { id: randomUUID(), handle: "politiks", name: "Politiks", topicIds: [], mission: "Exploration de la politique à l’échelle mondiale : institutions, élections.\nLes sujets nationaux ou spécialisés peuvent être traités par des sous-topics dédiés." };
  const astronoxi = { id: randomUUID(), handle: "astronoxi", name: "Astronoxi", topicIds: [], mission: "Suit les découvertes astronomiques, l’astrophysique et les missions spatiales." };
  const of = (name: string, description: string, topics: string[]) => candidates({ name, description, topics }, [politiks, astronoxi], []).map(item => item.agent.handle);
  // Seen on the real data with qwen3:1.7b: @politiks offered for astronomy through « spécialisés », for cybersecurity through « dédiés ».
  assert.deepEqual(of("Astronomie", "Agent spécialisé en astronomie.", ["Étoiles et planètes"]), ["astronoxi"]);
  assert.deepEqual(of("Cybersécurité", "Agent dédié à la cybersécurité.", ["Cybersécurité des satellites"]), []);
  assert.deepEqual(of("Élections en France", "Les élections françaises.", ["Élections municipales"]), ["politiks"]);
  const swingo = { id: randomUUID(), handle: "swingo", name: "Swingo", topicIds: [], mission: "Hacking éthique et failles logicielles." };
  assert.deepEqual(candidates({ name: "Swingo", description: "Tout sur Swingo.", topics: ["Saxophone ténor"] }, [swingo], []), [], "the ΞAgent's name alone never makes it a candidate");
});
