import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { BUILTIN_PRESETS } from "../src/lib/accounts/types";
import { DEFAULT_BLOUB_CONFIG } from "../src/lib/bloub/config";
import { IDEA_MIN_TIMEOUT_MS, type IdeaPlan } from "../src/lib/konstruktor/idea";
import { ideaSteps, type IdeaTaskView } from "../src/lib/konstruktor/idea-steps";
import { InferenceUnavailableError } from "../src/lib/watch/inference";
import type { LLMBindOptions } from "../src/lib/watch/llm-binding";
import { files, json, model, seed, setup } from "./helpers/konstruktor";

type App = Awaited<ReturnType<typeof setup>>;
const topic = (name: string, domain: string, extra: Record<string, unknown> = {}) => ({ name, scope: `Actualité : ${name.toLowerCase()}.`, domain, ...extra });
const domain = (name: string, extra: Record<string, unknown> = {}) => ({ name, description: `Veille ${name.toLowerCase()}.`, ...extra });

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
async function agent(app: App, owner: string, handle: string, name: string, topicIds: string[]) {
  const id = randomUUID(), preset = BUILTIN_PRESETS[0];
  await app.accounts.createAgent(owner, id, { draft: { handle, name, description: "", primaryTopicId: topicIds[0], secondaryTopicIds: topicIds.slice(1), presetId: preset.id, presetVersion: preset.version, settings: preset.settings, active: false, modelRef: null, validationMode: "human" }, profile: { perimeter: "", charter: "" }, bloub: DEFAULT_BLOUB_CONFIG });
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
    ["new", "neurotechnologies-medicales", ["+ia-pour-le-diagnostic-medical", "+interfaces-cerveau-machine-pour-la-reeducation-motrice", "+informatique-des-neuroprotheses"]],
    ["new", "autonomie-et-handicap", ["+robotique-assistance-aux-personnes-handicapees", "+exosquelettes-pour-la-mobilite"]],
  ]);
  const reused = new Set(plan.groups.flatMap(group => group.agent.type === "existing" ? [group.agent.id] : []));
  for (const id of [astronoxi, hackxing, politiks, gaia]) assert.ok(!reused.has(id), "Astronoxi (science), HackXing (compétitivité), @politiks (informatique), gaïa: never reused");
  assert.ok(plan.groups.flatMap(group => group.topics).every(item => !item.existing), "no generic or unrelated topic reused (« Informatique des neuroprothèses » ≠ #informatique; nothing ≈ X-59)");
  const prompt = requests[0].prompt;
  for (const absent of ["X 59", "science", "compétitivité", "astronoxi", "politiks", "T1", "A1"]) assert.ok(!prompt.includes(absent), `${absent} is not offered to the model`);
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
  const homonym = await agent(app, "alice", "neurotechnologies", "Neurotechnologies", [informatique.id]);
  const { plan } = await generate(app);
  const [group] = plan.groups;
  assert.deepEqual(group.agent, { type: "new", name: "Neurotechnologies", handle: "neurotechnologies-2", about: "Veille neurotechnologies.", note: "@neurotechnologies porte un nom proche mais ne suit aucun de ces topics : il n’est pas réutilisé." });
  assert.notEqual((group.agent as { id?: string }).id, homonym);
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
  assert.deepEqual(tags(plan), [["new", "filiere-hydrogene", ["+hydrogene-vert", "+electrolyseurs-industriels", "+stations-hydrogene", "+piles-a-combustible", "+stockage-hydrogene"]]]);
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
    ["new", "energies-marines", ["+eoliennes-en-mer", "+hydroliennes-fluviales", "+energie-houlomotrice"]],
    ["new", "musique-baroque", ["+opera-baroque", "+repertoire-de-clavecin"]],
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
  assert.match(requests[1].prompt, /Le topic « Production » est trop vague/);
  assert.match(requests[1].prompt, /Le topic « Science » est trop vague/);
  assert.ok(corrected.plan.groups[0].topics.some(item => item.name === "Production d’hydrogène"));

  const still = await generate(app);
  assert.equal(still.request.state, "failed");
  assert.match(still.request.message!, /Proposition du modèle inutilisable : Le topic « Production » est trop vague.*Rien n’a été créé/);
  await assert.rejects(app.konstruktor.createFromIdea("alice", { requestId: still.requestId }), { status: 409, message: /La génération a échoué/ });

  const invalid = await generate(app);
  assert.equal(invalid.request.state, "failed");
  assert.match(invalid.request.message!, /aucun objet JSON lisible.*Rien n’a été créé/);
  assert.equal(requests.length, 6, "one correction or one format retry, no more");
  assert.deepEqual(ideaSteps(invalid.request as unknown as IdeaTaskView).map(step => step.state), ["done", "error", "waiting", "waiting"]);
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
  assert.deepEqual(ideaSteps(request as unknown as IdeaTaskView).map(step => step.state), ["done", "error", "waiting", "waiting"]);
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
  assert.deepEqual(ideaSteps(during).map(step => step.state), ["done", "running", "waiting", "waiting"]);
  assert.ok(during.runs.at(-1)!.logs.some(log => /Appel 1 au modèle local/.test(log.message)));
  const reloaded = app.tasks.get("alice", "konstruktor", requestId) as unknown as IdeaTaskView;
  assert.deepEqual(ideaSteps(reloaded), ideaSteps(during));
  release();
  await app.tasks.close();
  const after = app.tasks.get("alice", "konstruktor", requestId) as unknown as IdeaTaskView;
  assert.equal(after.state, "done");
  assert.deepEqual(ideaSteps(after).map(step => step.state), ["done", "done", "done", "done"]);
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
  assert.deepEqual(plan.groups.map(group => group.agent.handle), ["veille-h2", "apiculture", "sake"]);
  // Between preview and confirmation, someone takes the last handle.
  await agent(app, "bob", "sake", "Saké", [astronomy.id]);
  const first = await app.konstruktor.createFromIdea("alice", { requestId });
  assert.deepEqual(first.results.map(result => result.status), ["unchanged", "completed", "failed"]);
  assert.equal(first.results[0].agentId, veille);
  assert.match(first.results[2].error!, /Le handle @sake est déjà réservé/);
  const catalog = await app.topics.list();
  assert.ok(catalog.some(item => item.tag === "frelons-asiatiques"));
  assert.ok(!catalog.some(item => item.tag === "rizieres-en-terrasses"), "nothing of the failed group is written");
  const second = await app.konstruktor.createFromIdea("alice", { requestId });
  assert.deepEqual(second.results.map(result => result.status), ["unchanged", "completed", "failed"]);
  assert.equal(second.results[1].agentId, first.results[1].agentId);
  assert.deepEqual((await ownAgents(app)).map(item => item.handle).sort(), ["apiculture", "veille-astro", "veille-h2"]);
  assert.equal((await app.topics.list()).length, catalog.length, "no duplicate on retry");
});
