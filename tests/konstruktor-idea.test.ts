import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { BUILTIN_PRESETS } from "../src/lib/accounts/types";
import { DEFAULT_BLOUB_CONFIG } from "../src/lib/bloub/config";
import type { IdeaPlan } from "../src/lib/konstruktor/idea";
import { files, json, model, seed, setup } from "./helpers/konstruktor";

type App = Awaited<ReturnType<typeof setup>>;
const topic = (name: string, domain: string, existing: string | null = null) => ({ name, scope: `Actualité de ${name.toLowerCase()}.`, domain, existing });
const domain = (name: string, existing: string | null = null) => ({ name, description: `Veille ${name.toLowerCase()}.`, existing });

async function generate(app: App, owner = "alice", text = "Une idée de veille") {
  const requestId = randomUUID();
  await app.tasks.request(owner, "konstruktor", { requestId, task: "plan-idea", input: { text } });
  await app.tasks.close();
  const request = app.tasks.get(owner, "konstruktor", requestId);
  return { requestId, request, plan: request.result as IdeaPlan };
}
const ownAgents = async (app: App, owner = "alice") => (await app.accounts.list(owner)).filter(account => account.owner === owner);
const tags = (plan: IdeaPlan) => plan.groups.map(group => [group.agent.type, group.agent.handle, group.topics.map(item => `${item.existing ? (item.attached ? "=" : "~") : "+"}${item.tag}`)]);

test("konstruktor idea: 5 linked topics → 1 ΞAgent; nothing created before confirmation; confirmation creates it", { timeout: 30_000 }, async t => {
  const answer = { topics: ["Hydrogène vert", "Électrolyseurs", "Stations hydrogène", "Piles à combustible", "Stockage hydrogène"].map(name => topic(name, "Filière hydrogène")), domains: [domain("Filière hydrogène")] };
  const { binding, requests } = model(() => json(answer));
  const app = await setup(t, binding);
  await seed(app);
  const before = await files(app.root);
  const catalogBefore = (await app.topics.list()).length;
  const { requestId, request, plan } = await generate(app, "alice", "Suivre toute la filière hydrogène en France.");
  assert.equal(request.state, "done");
  assert.match(requests[0].prompt, /filière hydrogène en France/);
  assert.match(requests[0].prompt, /veille-astro/, "the owner's ΞAgents are offered for reuse");
  assert.deepEqual(tags(plan), [["new", "filiere-hydrogene", ["+hydrogene-vert", "+electrolyseurs", "+stations-hydrogene", "+piles-a-combustible", "+stockage-hydrogene"]]]);
  assert.deepEqual(plan.groups[0].issues, []);
  // Generation writes nothing: no topic, no ΞAgent, no deployment record.
  assert.deepEqual(await files(app.root), before);
  assert.equal((await app.topics.list()).length, catalogBefore);
  assert.equal((await ownAgents(app)).length, 1);

  await assert.rejects(app.konstruktor.createFromIdea("bob", { requestId }), { status: 404 }, "another user's plan is unknown");
  const { results } = await app.konstruktor.createFromIdea("alice", { requestId });
  assert.deepEqual(results.map(result => [result.status, result.error]), [["completed", null]]);
  const agent = (await ownAgents(app)).find(account => account.handle === "filiere-hydrogene")!;
  assert.equal(agent.id, results[0].agentId);
  const catalog = await app.topics.list();
  const followed = [agent.editorial!.primaryTopicId, ...agent.editorial!.secondaryTopicIds].map(id => catalog.find(item => item.id === id)!.tag);
  assert.deepEqual(followed, ["hydrogene-vert", "electrolyseurs", "stations-hydrogene", "piles-a-combustible", "stockage-hydrogene"]);
  // Confirming again changes nothing (same deployments, already completed).
  assert.deepEqual((await app.konstruktor.createFromIdea("alice", { requestId })).results.map(result => result.status), ["completed"]);
  assert.equal((await ownAgents(app)).length, 2);
  assert.equal((await app.topics.list()).length, catalogBefore + 5);
});

test("konstruktor idea: independent topics → several ΞAgents; mixed case → grouped by domain", { timeout: 30_000 }, async t => {
  const independent = { topics: [topic("Cyclisme", "Cyclisme"), topic("Jazz", "Jazz"), topic("Volcans", "Volcanologie"), topic("Fiscalité", "Fiscalité"), topic("Échecs", "Échecs")], domains: ["Cyclisme", "Jazz", "Volcanologie", "Fiscalité", "Échecs"].map(name => domain(name)) };
  const mixed = { topics: [topic("Éoliennes en mer", "Énergies marines"), topic("Hydroliennes", "Énergies marines"), topic("Houlomoteur", "Énergies marines"), topic("Opéra baroque", "Musique baroque"), topic("Clavecin", "Musique baroque")], domains: [domain("Énergies marines"), domain("Musique baroque")] };
  let call = 0;
  const { binding } = model(() => json(call++ === 0 ? independent : mixed));
  const app = await setup(t, binding);
  await seed(app);
  const first = await generate(app);
  assert.equal(first.plan.groups.length, 5);
  assert.ok(first.plan.groups.every(group => group.agent.type === "new" && group.topics.length === 1));
  const second = await generate(app);
  assert.deepEqual(tags(second.plan), [
    ["new", "energies-marines", ["+eoliennes-en-mer", "+hydroliennes", "+houlomoteur"]],
    ["new", "musique-baroque", ["+opera-baroque", "+clavecin"]],
  ]);
  const { results } = await app.konstruktor.createFromIdea("alice", { requestId: second.requestId });
  assert.deepEqual(results.map(result => result.status), ["completed", "completed"]);
  assert.deepEqual((await ownAgents(app)).map(agent => agent.handle).sort(), ["energies-marines", "musique-baroque", "veille-astro"]);
});

test("konstruktor idea: an existing ΞAgent and its topics are reused, evident duplicates are not created", { timeout: 30_000 }, async t => {
  const answer = {
    topics: [topic("Astronomie", "Astronomie", null), topic("Exoplanètes", "Astronomie"), topic("Télescopes spatiaux", "Astronomie"), topic("Voile solaire", "Spatial", "T1"), topic("Lanceurs réutilisables", "Spatial")],
    domains: [domain("Astronomie", "A1"), domain("Spatial")],
  };
  const { binding } = model(() => json(answer));
  const app = await setup(t, binding);
  const { topic: astronomy, agentId } = await seed(app);
  // Bob already holds the handle a new ΞAgent would take.
  await app.accounts.createAgent("bob", randomUUID(), { draft: { handle: "spatial", name: "Spatial de Bob", description: "", primaryTopicId: astronomy.id, secondaryTopicIds: [], presetId: BUILTIN_PRESETS[0].id, presetVersion: BUILTIN_PRESETS[0].version, settings: BUILTIN_PRESETS[0].settings, active: false, modelRef: null, validationMode: "human" }, profile: { perimeter: "", charter: "" }, bloub: DEFAULT_BLOUB_CONFIG });
  const { requestId, plan } = await generate(app);
  const [astro] = plan.groups;
  assert.deepEqual(astro.agent, { type: "existing", id: agentId, handle: "veille-astro", name: "Veille astro", note: "ΞAgent existant @veille-astro, proposé par Konstruktor." });
  assert.deepEqual(tags(plan), [
    ["existing", "veille-astro", ["=astronomie", "+exoplanetes", "+telescopes-spatiaux"]],
    ["new", "spatial-2", ["+lanceurs-reutilisables"]],
  ], "#astronomie is reused (same tag) and already followed; « Voile solaire » pointed at it again and is dropped; the taken handle gets a suffix");
  assert.match(astro.topics[0].note!, /Doublon évité : le topic #astronomie existe déjà/);
  assert.deepEqual(plan.notes, ["« Voile solaire » écarté : doublon d’un autre topic de la proposition (#astronomie)."]);

  const catalogBefore = (await app.topics.list()).length;
  const { results } = await app.konstruktor.createFromIdea("alice", { requestId });
  assert.deepEqual(results.map(result => [result.status, result.agentId === agentId]), [["completed", true], ["completed", false]]);
  const catalog = await app.topics.list();
  assert.equal(catalog.length, catalogBefore + 3, "only the missing topics");
  assert.equal(catalog.filter(item => item.tag === "astronomie").length, 1);
  const updated = (await ownAgents(app)).find(account => account.id === agentId)!;
  assert.deepEqual([updated.editorial!.primaryTopicId, ...updated.editorial!.secondaryTopicIds].map(id => catalog.find(item => item.id === id)!.tag), ["astronomie", "exoplanetes", "telescopes-spatiaux"]);
  assert.equal(updated.name, "Veille astro", "the rest of the existing ΞAgent is kept");
  assert.deepEqual((await ownAgents(app)).map(agent => agent.handle).sort(), ["spatial-2", "veille-astro"]);
});

test("konstruktor idea: an existing ΞAgent that already follows everything is left unchanged", { timeout: 30_000 }, async t => {
  const answer = { topics: [topic("Astronomie", "Veille astro"), topic("Cuisine", "Cuisine"), topic("Pâtisserie", "Cuisine"), topic("Vins", "Cuisine"), topic("Fromages", "Cuisine")], domains: [domain("Veille astro"), domain("Cuisine")] };
  const { binding } = model(() => json(answer));
  const app = await setup(t, binding);
  const { agentId } = await seed(app);
  const { requestId, plan } = await generate(app);
  assert.equal(plan.groups[0].agent.type, "existing", "same name as an existing ΞAgent: reused, never duplicated");
  assert.match((plan.groups[0].agent as { note: string }).note, /Doublon évité : le ΞAgent @veille-astro existe déjà/);
  const { results } = await app.konstruktor.createFromIdea("alice", { requestId });
  assert.deepEqual(results.map(result => [result.status, result.agentId]), [["unchanged", agentId], ["completed", results[1].agentId]]);
});

test("konstruktor idea: invalid JSON or a malformed plan is reported and nothing is created", { timeout: 30_000 }, async t => {
  const answers = ["Voici mes idées : hydrogène, éolien…", json({ topics: [topic("Un", "A")], domains: [domain("A")] }), json({ topics: ["Éolien", "Éoliens", "Solaire", "Biogaz", "Géothermie"].map(name => topic(name, "Énergies")), domains: [domain("Énergies")] }), json({ topics: ["A", "B", "C", "D", "E"].map(name => topic(`Sujet ${name}`, "Inconnu")), domains: [domain("Autre")] })];
  let call = 0;
  const { binding, requests } = model(() => answers[Math.floor(call++ / 2) % answers.length]);
  const app = await setup(t, binding);
  await seed(app);
  const before = await files(app.root);
  for (let i = 0; i < answers.length; i++) {
    const { requestId, request } = await generate(app);
    assert.equal(request.state, "failed");
    assert.match(request.message ?? "", /Réponse du modèle non conforme.*Reformulez votre idée ou réessayez/);
    await assert.rejects(app.konstruktor.createFromIdea("alice", { requestId }), { status: 409 });
  }
  assert.equal(requests.length, answers.length * 2, "each answer retried once, then reported");
  assert.deepEqual(await files(app.root), before);
});

test("konstruktor idea: a partial failure keeps what succeeded; confirming again resumes without duplicates", { timeout: 30_000 }, async t => {
  const answer = { topics: [topic("Apiculture", "Apiculture"), topic("Frelons", "Apiculture"), topic("Miel", "Apiculture"), topic("Saké", "Saké"), topic("Rizières", "Saké")], domains: [domain("Apiculture"), domain("Saké")] };
  const { binding } = model(() => json(answer));
  const app = await setup(t, binding);
  const { topic: astronomy } = await seed(app);
  const { requestId, plan } = await generate(app);
  assert.deepEqual(plan.groups.map(group => group.agent.handle), ["apiculture", "sake"]);
  // Between preview and confirmation, someone takes the second handle.
  const bobAgent = randomUUID();
  await app.accounts.createAgent("bob", bobAgent, { draft: { handle: "sake", name: "Saké", description: "", primaryTopicId: astronomy.id, secondaryTopicIds: [], presetId: BUILTIN_PRESETS[0].id, presetVersion: BUILTIN_PRESETS[0].version, settings: BUILTIN_PRESETS[0].settings, active: false, modelRef: null, validationMode: "human" }, profile: { perimeter: "", charter: "" }, bloub: DEFAULT_BLOUB_CONFIG });
  const first = await app.konstruktor.createFromIdea("alice", { requestId });
  assert.deepEqual(first.results.map(result => result.status), ["completed", "failed"]);
  assert.match(first.results[1].error!, /Le handle @sake est déjà réservé/);
  const catalog = await app.topics.list();
  assert.ok(catalog.some(item => item.tag === "frelons"));
  assert.ok(!catalog.some(item => item.tag === "rizieres"), "nothing of the failed group is written");
  const second = await app.konstruktor.createFromIdea("alice", { requestId });
  assert.deepEqual(second.results.map(result => result.status), ["completed", "failed"]);
  assert.equal(second.results[0].agentId, first.results[0].agentId);
  assert.deepEqual((await ownAgents(app)).map(agent => agent.handle).sort(), ["apiculture", "veille-astro"]);
  assert.equal((await app.topics.list()).length, catalog.length, "no duplicate on retry");
});
