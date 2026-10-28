import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import Database from "better-sqlite3";
import { createAccountStore } from "../src/lib/accounts/store";
import { createPublicationStore } from "../src/lib/publications/store";
import { openVault } from "../src/lib/publications/vault";
import { searchCatalog } from "../src/lib/search/resolve";
import { searchData, setKnowledge, setSubscription, subscribedTopics } from "../src/lib/search/server";
import { NETWORK_LAYERS, NETWORK_LIMITS, networkHref, parseNetworkRequest, type NetworkRequest } from "../src/lib/topics/network";
import { topicNetwork } from "../src/lib/topics/network-data";
import { createTopicRelationStore } from "../src/lib/topics/relations";
import { createTopicStore } from "../src/lib/topics/store";
import { edgeLabel, edgeProvenance } from "../src/components/graph/topic-network";
import { createSimulation, nearestIn, syncTopicLayout } from "../src/components/graph/topic-network-layout";

// Lot 6: the topic network is built on the server from what the viewer may read, layer by layer.
const SECRET = "Le report modal vers le rail réduit la consommation d’énergie.";
const evidence = (ref: string) => [{ kind: "publication" as const, ref, excerpt: SECRET }];

async function setup(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "xi-topic-network-"));
  const vault = await openVault(root);
  const db = new Database(":memory:");
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  const topics = createTopicStore({ vault, db });
  const accounts = createAccountStore({ vault, db, topics });
  const publications = createPublicationStore({ vault, db });
  const relations = createTopicRelationStore({ vault, db, topics, readable: publications.readableIds });
  const stores = { topics, accounts, publications, relations };
  const make = async (tag: string, name: string, parentId: string | null = null, relatedIds: string[] = []) =>
    (await topics.create("alice", randomUUID(), { tag, name, description: "", scope: name, parentId, relatedIds })).topic;
  const energy = await make("energie", "Énergie");
  const transport = await make("transport", "Transports");
  const rail = await make("transport.rail", "Rail", transport.id);
  const climate = await make("climat", "Climat", null, [energy.id]);
  const urban = await make("urbanisme", "Urbanisme");
  const net = (viewer: string, request: Partial<NetworkRequest> = {}) =>
    topicNetwork(viewer, { layers: [...NETWORK_LAYERS], focus: null, open: [], proposed: false, ...request }, stores);
  /** A ΞAgent confirmed by its owner (public by default), with optional secondary topics. */
  async function agent(owner: string, primary: string, secondary: string[] = []) {
    const proposed = await accounts.propose(owner, primary);
    const ready = await accounts.resume(owner, proposed.id);
    await accounts.confirm(owner, ready.id, { ...ready.draft!, secondaryTopicIds: secondary }, true);
    return (await accounts.list(owner)).find(a => a.id === ready.accountId)!;
  }
  /** A real (non-fixture) publication of the agent, approved by its owner: published, private. */
  async function contribution(owner: string, agentId: string, topicId: string, visibility: "private" | "public") {
    const draft = await publications.saveWatchDraft(owner, agentId, {
      id: randomUUID(), summary: "Point d’étape.", topicIds: [topicId], messages: [{ body: "Un fait vérifié.", sources: [0] }],
      sources: [{ url: `https://media.example/${randomUUID()}`, title: "Article", publisher: "Média", accessedAt: "2026-01-15", facts: ["Un fait vérifié."], reservations: [] }], watch: {},
    });
    if (visibility === "private") return publications.reviewWatchDraft({ id: owner }, agentId, draft.id, { action: "approve", revision: draft.revision });
    return publications.publishWatchDraft(owner, agentId, draft.id, { visibility, revision: draft.revision, details: {}, guard: async () => null, record: () => {} });
  }
  async function publication(author: string, visibility: "private" | "public") {
    const viewer = { id: author };
    const id = await publications.create(viewer);
    const draft = await publications.getEditable(viewer, id);
    const saved = await publications.save(viewer, id, { baseRevision: draft.revision, summary: "", visibility, messages: [{ key: "a", file: null, body: SECRET }] });
    assert.ok(saved.ok);
    await publications.publish(viewer, id, saved.snapshot.revision);
    return id;
  }
  return { root, vault, db, topics, accounts, publications, relations, stores, energy, transport, rail, climate, urban, net, agent, contribution, publication };
}
const ids = (network: { nodes: { id: string }[] }) => network.nodes.map(n => n.id).sort();

test("knowledge: only an explicit registration adds a topic; reading, searching and subscribing never do", async t => {
  const s = await setup(t);
  // Searching, opening the search data and subscribing leave the knowledge list empty.
  const data = await searchData("bob", s.stores);
  searchCatalog("#energie", data.topics, data.agents);
  await setSubscription("bob", s.energy.id, true, s.stores);
  assert.deepEqual((await s.publications.social({ id: "bob" })).knowledge, []);
  assert.deepEqual((await s.net("bob", { layers: ["knowledge"] })).nodes, []);

  await setKnowledge("bob", s.rail.id, true, s.stores);
  await setKnowledge("bob", s.rail.id, true, s.stores); // idempotent
  assert.deepEqual((await s.publications.social({ id: "bob" })).knowledge, [s.rail.id]);
  const known = await s.net("bob", { layers: ["knowledge"] });
  assert.deepEqual(ids(known), [s.rail.id]);
  assert.equal(known.nodes[0].known, true);
  assert.equal(known.counts.knowledge, 1);
  // Markdown is the source: a fresh store reads it back, alongside subscriptions.
  const feed = await readFile(join(s.root, "posts", "_users", "bob", "feed.md"), "utf8");
  assert.match(feed, /knowledge:\n\s+- [0-9a-f-]{36}/);
  assert.deepEqual((await createPublicationStore({ vault: s.vault, db: new Database(":memory:") }).social({ id: "bob" })).knowledge, [s.rail.id]);

  await setKnowledge("bob", s.rail.id, false, s.stores);
  assert.deepEqual((await s.net("bob", { layers: ["knowledge"] })).nodes, []);
  assert.deepEqual((await subscribedTopics("bob", s.stores)).map(topic => topic.id), [s.energy.id], "subscription untouched");
  // Another user's personal topic can't be registered (not visible).
  const secret = (await s.topics.openPersonal("alice", "secretalice")).topic;
  await assert.rejects(setKnowledge("bob", secret.id, true, s.stores), /introuvable/);
});

test("layers superpose: knowledge, interests and experts each seed the view, independently", async t => {
  const s = await setup(t);
  await setKnowledge("bob", s.rail.id, true, s.stores);
  await setSubscription("bob", s.energy.id, true, s.stores);
  await setSubscription("bob", s.rail.id, true, s.stores);
  await s.agent("alice", s.urban.id);
  assert.deepEqual(ids(await s.net("bob", { layers: ["knowledge"] })), [s.rail.id]);
  assert.deepEqual(ids(await s.net("bob", { layers: ["interests"] })), [s.energy.id, s.rail.id].sort());
  assert.deepEqual(ids(await s.net("bob", { layers: ["experts"] })), [s.urban.id]);
  const all = await s.net("bob");
  assert.deepEqual(ids(all), [s.energy.id, s.rail.id, s.urban.id].sort());
  const rail = all.nodes.find(n => n.id === s.rail.id)!;
  assert.deepEqual([rail.known, rail.interest, rail.origin], [true, true, "seed"], "one node, several layers");
  assert.deepEqual(all.counts, { knowledge: 1, interests: 2, experts: 1 });
  // No layer: nothing but an explicit focus.
  assert.deepEqual((await s.net("bob", { layers: [] })).nodes, []);
  assert.deepEqual(ids(await s.net("bob", { layers: [], focus: s.climate.id })), [s.climate.id]);
  // Subscribing never creates a ΞAgent nor a watch.
  assert.equal((await s.accounts.list("bob")).filter(a => a.owner === "bob").length, 0);
});

test("experts: declared specializations apart from readable contributions; another user's private agent never appears", async t => {
  const s = await setup(t);
  const pub = await s.agent("alice", s.transport.id, [s.climate.id]);
  const hidden = await s.agent("alice", s.energy.id);
  // Make the second agent private.
  const dir = (await readdir(join(s.root, "generators"))).find(name => name === hidden.handle)!;
  const file = join(s.root, "generators", dir, "index.md");
  await writeFile(file, (await readFile(file, "utf8")).replace("visibility: public", "visibility: private"));
  await s.contribution("alice", pub.id, s.rail.id, "public");
  await s.contribution("alice", pub.id, s.rail.id, "private");
  await s.contribution("alice", hidden.id, s.energy.id, "public");

  const forBob = await s.net("bob", { layers: ["experts"] });
  assert.deepEqual(ids(forBob), [s.transport.id, s.rail.id, s.climate.id].sort());
  const expert = (network: typeof forBob, topic: string) => network.nodes.find(n => n.id === topic)!.experts;
  assert.deepEqual(expert(forBob, s.transport.id).map(e => [e.handle, e.role, e.contributions]), [[pub.handle, "principal", 0]]);
  assert.deepEqual(expert(forBob, s.climate.id).map(e => e.role), ["secondaire"]);
  assert.deepEqual(expert(forBob, s.rail.id).map(e => [e.role, e.contributions]), [[null, 1]], "only the public publication counts for Bob");
  assert.ok(!JSON.stringify(forBob).includes(hidden.id) && !JSON.stringify(forBob).includes(hidden.handle), "private agent absent");
  assert.ok(!JSON.stringify(forBob).includes(pub.description || "\u0000"), "no agent description sent");

  const forAlice = await s.net("alice", { layers: ["experts"] });
  assert.deepEqual(expert(forAlice, s.rail.id).map(e => e.contributions), [2], "the owner reads both");
  assert.deepEqual(expert(forAlice, s.energy.id).map(e => [e.handle, e.role, e.contributions]), [[hidden.handle, "principal", 1]]);
});

test("edges: hierarchy, declared and accepted relations; proposals on request; exclusions and co-occurrence never", async t => {
  const s = await setup(t);
  for (const topic of [s.energy, s.transport, s.rail, s.climate, s.urban]) await setSubscription("alice", topic.id, true, s.stores);
  const accepted = await s.relations.create("alice", { source: s.energy.id, target: s.transport.id, type: "influences", justification: "Le coût de l’énergie pèse sur les transports." });
  const base = { origin: "inference", createdBy: "local-model:test", justification: "Plusieurs publications relient explicitement ces deux sujets.", evidence: evidence("p1") } as const;
  const proposed = await s.relations.propose({ ...base, source: s.urban.id, target: s.transport.id, type: "related_to", confidence: 0.5 });
  const excluded = await s.relations.propose({ ...base, source: s.urban.id, target: s.climate.id, type: "influences", confidence: 0.95 });
  await s.relations.correct("alice", excluded.id, { status: "excluded" });

  const plain = await s.net("alice");
  const kinds = plain.edges.map(e => `${e.kind}:${e.type}`).sort();
  assert.deepEqual(kinds, ["declared:related_to", "hierarchy:parent", "recorded:influences"]);
  assert.equal(plain.proposals, 1);
  assert.ok(!plain.edges.some(e => e.id === proposed.id || e.id === excluded.id));
  const withProposals = await s.net("alice", { proposed: true });
  assert.deepEqual(withProposals.edges.filter(e => e.status === "proposed").map(e => e.id), [proposed.id]);
  assert.ok(!withProposals.edges.some(e => e.id === excluded.id), "excluded never shown");
  // Edges carry structure and provenance only.
  const served = JSON.stringify(withProposals);
  for (const text of [SECRET, base.justification, "Le coût de l’énergie"]) assert.ok(!served.includes(text), text);
  const edge = plain.edges.find(e => e.id === accepted.id)!;
  assert.deepEqual([edgeLabel(edge, s.energy.id), edgeLabel(edge, s.transport.id)], ["Influence", "Est influencé par"]);
  assert.equal(edgeProvenance(edge), "Ajoutée par vous · validée");
  const parent = plain.edges.find(e => e.kind === "hierarchy")!;
  assert.deepEqual([edgeLabel(parent, s.rail.id), edgeLabel(parent, s.transport.id)], ["Spécialise", "Englobe"]);

  // Bob cannot validate the proposal: it is never served to him, even on request.
  for (const topic of [s.urban, s.transport]) await setSubscription("bob", topic.id, true, s.stores);
  const bob = await s.net("bob", { proposed: true });
  assert.equal(bob.proposals, 0);
  assert.ok(!bob.edges.some(e => e.status === "proposed"));
  // A personal exclusion hides the edge for that user only.
  await s.relations.hide("alice", accepted.id, true);
  assert.ok(!(await s.net("alice")).edges.some(e => e.id === accepted.id));
  for (const topic of [s.energy]) await setSubscription("bob", topic.id, true, s.stores);
  assert.ok((await s.net("bob")).edges.some(e => e.id === accepted.id));
});

test("privacy: relations resting on unreadable publications, personal topics and personal relations stay with their owner", async t => {
  const s = await setup(t);
  const privatePub = await s.publication("dave", "private");
  const backed = await s.relations.propose({ source: s.climate.id, target: s.transport.id, type: "influences", origin: "inference", createdBy: "local-model:test",
    justification: "Plusieurs publications relient explicitement ces deux sujets.", evidence: evidence(`publication:${privatePub}`), confidence: 0.95 });
  assert.equal(backed.status, "accepted");
  const personal = (await s.topics.openPersonal("dave", "monjardin")).topic;
  await setKnowledge("dave", personal.id, true, s.stores);
  const mine = await s.relations.create("dave", { source: personal.id, target: s.climate.id, type: "related_to", justification: "Mon potager souffre de la sécheresse." });
  for (const viewer of ["bob", "dave"]) for (const topic of [s.climate, s.transport]) await setSubscription(viewer, topic.id, true, s.stores);

  const bob = await s.net("bob", { proposed: true, open: [s.climate.id] });
  assert.ok(!bob.edges.some(e => e.id === backed.id), "withheld evidence: no edge for Bob");
  const servedToBob = JSON.stringify(bob);
  for (const text of [personal.id, personal.tag, mine.id, privatePub, SECRET]) assert.ok(!servedToBob.includes(text), text);

  const dave = await s.net("dave", { open: [s.climate.id] });
  assert.ok(dave.edges.some(e => e.id === backed.id), "the author reads the publication");
  const own = dave.edges.find(e => e.id === mine.id)!;
  assert.deepEqual([own.scope, own.byViewer], ["personal", true]);
  assert.equal(dave.nodes.find(n => n.id === personal.id)!.personal, true);
  assert.ok(!JSON.stringify(dave).includes("sécheresse"), "no justification in the network");

  // An expert agent made private: neither its specializations nor its (still public) publications are served to others.
  const pubAgent = await s.agent("alice", s.urban.id);
  const published = await s.contribution("alice", pubAgent.id, s.energy.id, "public");
  assert.ok("snapshot" in published);
  const energyFor = async (viewer: string) => (await s.net(viewer, { layers: ["experts"] })).nodes.find(n => n.id === s.energy.id);
  assert.equal((await energyFor("bob"))?.experts[0].contributions, 1);
  const file = join(s.root, "generators", pubAgent.handle, "index.md");
  await writeFile(file, (await readFile(file, "utf8")).replace("visibility: public", "visibility: private"));
  assert.ok(!JSON.stringify(await s.net("bob", { layers: ["experts"] })).includes(pubAgent.id));
  assert.equal((await energyFor("alice"))?.experts[0].contributions, 1, "still the owner's");
  assert.equal(await energyFor("bob"), undefined);
});

test("progressive exploration: neighbours on request, limits, stable request URL, index rebuild", async t => {
  const s = await setup(t);
  await setSubscription("bob", s.transport.id, true, s.stores);
  const first = await s.net("bob", { layers: ["interests"] });
  assert.deepEqual(ids(first), [s.transport.id]);
  assert.equal(first.edges.length, 0);
  assert.equal(first.nodes[0].hiddenNeighbours, 1, "rail, through the hierarchy");
  await s.relations.create("alice", { source: s.energy.id, target: s.transport.id, type: "influences", justification: "Coût de l’énergie et transports." });
  const before = await s.net("bob", { layers: ["interests"] });
  assert.equal(before.nodes[0].hiddenNeighbours, 2);
  const opened = await s.net("bob", { layers: ["interests"], open: [s.transport.id] });
  assert.deepEqual(ids(opened), [s.energy.id, s.rail.id, s.transport.id].sort());
  assert.deepEqual(opened.nodes.filter(n => n.origin === "neighbour").map(n => n.id).sort(), [s.energy.id, s.rail.id].sort());
  assert.equal(opened.edges.length, 2);
  // Opening a topic that is not displayed does nothing (no way to probe the catalogue).
  assert.deepEqual(ids(await s.net("bob", { layers: ["interests"], open: [s.climate.id] })), [s.transport.id]);

  // Request parsing: unknown values dropped, default layers, caps; the href round-trips.
  const many = Array.from({ length: 20 }, () => randomUUID());
  const parsed = parseNetworkRequest({ view: "topics", layers: "knowledge,bogus,experts", focus: "nope", open: [...many, "x"].join(","), proposed: "1" });
  assert.deepEqual(parsed.layers, ["knowledge", "experts"]);
  assert.equal(parsed.focus, null);
  assert.equal(parsed.open.length, NETWORK_LIMITS.open);
  assert.deepEqual(parseNetworkRequest(Object.fromEntries(new URL(`http://x${networkHref(parsed)}`).searchParams)), parsed);
  assert.deepEqual(parseNetworkRequest({ view: "topics" }).layers, [...NETWORK_LAYERS]);
  assert.equal(networkHref({ layers: [...NETWORK_LAYERS], focus: null, open: [], proposed: false }), "/dashboard/graph?view=topics");

  // Seeds are capped: a large interest list is truncated, never sent whole.
  const extra = [];
  for (let i = 0; i < NETWORK_LIMITS.seeds + 5; i++) extra.push((await s.topics.create("alice", randomUUID(), { tag: `sujet${i}`, name: `Sujet ${i}`, description: "", scope: "x", parentId: null, relatedIds: [] })).topic);
  for (const topic of extra) await setSubscription("bob", topic.id, true, s.stores);
  const capped = await s.net("bob", { layers: ["interests"] });
  assert.equal(capped.nodes.length, NETWORK_LIMITS.seeds);
  assert.equal(capped.truncated, true);

  // Index rebuild: a fresh database gives the same network.
  const db2 = new Database(":memory:");
  t.after(() => db2.close());
  const topics2 = createTopicStore({ vault: s.vault, db: db2 });
  const publications2 = createPublicationStore({ vault: s.vault, db: db2 });
  const stores2 = { topics: topics2, accounts: createAccountStore({ vault: s.vault, db: db2, topics: topics2 }), publications: publications2, relations: createTopicRelationStore({ vault: s.vault, db: db2, topics: topics2, readable: publications2.readableIds }) };
  await stores2.relations.reindex();
  const rebuilt = await topicNetwork("bob", { layers: ["interests"], focus: null, open: [s.transport.id], proposed: false }, stores2);
  const again = await s.net("bob", { layers: ["interests"], open: [s.transport.id] });
  assert.deepEqual(ids(rebuilt), ids(again));
  assert.deepEqual(rebuilt.edges.map(e => e.id).sort(), again.edges.map(e => e.id).sort());
});

test("layout is stable when neighbours are added; arrow keys find the nearest topic in a direction", () => {
  const sim = createSimulation();
  syncTopicLayout(sim, ["a", "b"], [{ source: "a", target: "b" }]);
  const before = new Map([...sim.nodes].map(([id, n]) => [id, { x: n.x, y: n.y }]));
  syncTopicLayout(sim, ["a", "b", "c", "d"], [{ source: "a", target: "b" }, { source: "b", target: "c" }, { source: "b", target: "d" }]);
  for (const id of ["a", "b"]) {
    const moved = Math.hypot(sim.nodes.get(id)!.x - before.get(id)!.x, sim.nodes.get(id)!.y - before.get(id)!.y);
    assert.ok(moved < 60, `${id} moved ${moved}`);
  }
  // Deterministic: the same ids always land at the same place.
  const other = createSimulation();
  syncTopicLayout(other, ["a", "b"], [{ source: "a", target: "b" }]);
  assert.deepEqual([...other.nodes].map(([, n]) => [n.x, n.y]), [...before.values()].map(p => [p.x, p.y]));

  const points: [string, { x: number; y: number }][] = [["right", { x: 100, y: 10 }], ["far", { x: 300, y: 0 }], ["up", { x: 5, y: -80 }], ["diag", { x: 60, y: 90 }]];
  assert.equal(nearestIn({ x: 0, y: 0 }, "right", points), "right");
  assert.equal(nearestIn({ x: 0, y: 0 }, "up", points), "up");
  assert.equal(nearestIn({ x: 0, y: 0 }, "down", points), "diag");
  assert.equal(nearestIn({ x: 0, y: 0 }, "left", points), null);
});
