import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildView, listConnections, NODE_ID, parseConnectionsRequest, parseMessageRef, parseViewRequest,
} from "../src/lib/graph/engine";
import { createGraphService, GraphNotFoundError } from "../src/lib/graph/service";
import {
  GRAPH_LIMITS, UNASSIGNED, type AuthorizedGraph, type ConnectionsRequest, type GeneratorData, type GraphRepository,
  type MessageData, type PublicationData, type RelationData, type SemanticType,
} from "../src/lib/graph/types";
import { PublicationError } from "../src/lib/publications/store";
import type { PublicationSnapshot } from "../src/lib/publications/types";

const hex = (n: number) => n.toString(16).padStart(12, "0");
const gid = (n: number) => `00000000-0000-1000-8000-${hex(n)}`;
const pid = (n: number) => `00000000-0000-4000-8000-${hex(n)}`;
const alice = { id: "alice" };

type Fixture = { generators: GeneratorData[]; publications: PublicationData[]; relations: RelationData[] };

function fixture() {
  const data: Fixture = { generators: [], publications: [], relations: [] };
  const slugs = new Map<string, string>();
  const gen = (slug: string) => {
    const id = gid(data.generators.length + 1);
    const parentSlug = slug.split(".").slice(0, -1).join(".");
    data.generators.push({ id, slug, title: slug, parentId: slugs.get(parentSlug) ?? null });
    slugs.set(slug, id);
    return id;
  };
  const pub = (generatorId: string | null, date = "2026-10-01T00:00:00.000Z", messageCount = 3) => {
    const id = pid(data.publications.length + 1);
    data.publications.push({ id, generatorId, title: `pub ${data.publications.length + 1}`, authorId: alice.id, type: "thread", date, messageCount });
    return id;
  };
  let clock = Date.parse("2026-10-01T00:00:00.000Z");
  const rel = (source: string, target: string, options: { type?: SemanticType; needsReview?: boolean; n?: number; m?: number; at?: string } = {}) => {
    const relation: RelationData = {
      id: `r${String(data.relations.length + 1).padStart(6, "0")}`, type: options.type ?? "supports",
      source: `${source}/${options.n ?? 1}`, target: `${target}/${options.m ?? 1}`, sourcePublication: source, targetPublication: target,
      needsReview: options.needsReview ?? false, createdAt: options.at ?? new Date(clock += 60_000).toISOString(),
    };
    data.relations.push(relation);
    return relation;
  };
  const graph = (): AuthorizedGraph => ({ generators: [...data.generators], publications: [...data.publications], relations: [...data.relations] });
  return { data, gen, pub, rel, graph };
}

const messagesFor = (publicationId: string, count: number): MessageData[] =>
  Array.from({ length: count }, (_, i) => ({
    ref: `${publicationId}/${i + 1}`, publicationId, position: i + 1, excerpt: `message ${i + 1}`,
    replyTo: i ? `${publicationId}/${i}` : null,
  }));

const view = (graph: AuthorizedGraph, expanded: string[] | { id: string; limit?: number }[], messages = new Map<string, MessageData[]>()) =>
  buildView(graph, { expanded: expanded.map((item) => (typeof item === "string" ? { id: item } : item)) }, messages);
const node = (response: ReturnType<typeof buildView>, id: string) => response.nodes.find((item) => item.id === id);
const edge = (response: ReturnType<typeof buildView>, x: string, y: string) =>
  response.edges.find((item) => (item.a === x && item.b === y) || (item.a === y && item.b === x));

function politiks() {
  const f = fixture();
  const p = f.gen("politiks");
  const france = f.gen("politiks.france");
  const international = f.gen("politiks.international");
  const mercatus = f.gen("mercatus");
  const pf = f.pub(france);
  const pi = f.pub(international);
  const pm = f.pub(mercatus);
  return { ...f, p, france, international, mercatus, pf, pi, pm };
}

test("roots: top-level generators by slug, then the unassigned root only when it holds publications", () => {
  const f = fixture();
  f.gen("sciencia");
  f.gen("politiks");
  f.gen("politiks.france");
  let response = view(f.graph(), []);
  assert.deepEqual(response.nodes.map((item) => item.label), ["politiks", "sciencia"]);
  assert.equal(response.truncated, false);
  f.pub(null);
  response = view(f.graph(), []);
  assert.deepEqual(response.nodes.map((item) => item.id).at(-1), UNASSIGNED);
  assert.equal(node(response, UNASSIGNED)!.childCount, 1);
  assert.equal(node(response, `g:${f.data.generators[1].id}`)!.childCount, 1);
});

test("progressive expansion: top-down, child generators before publications (newest first), others ignored", () => {
  const { gen, pub, graph, p, france } = politiks();
  gen("politiks.alpha");
  const older = pub(p, "2026-01-01T00:00:00.000Z");
  const newer = pub(p, "2026-05-01T00:00:00.000Z");
  // Expanding a child whose parent is collapsed changes nothing.
  assert.deepEqual(view(graph(), [`g:${france}`]).nodes.length, view(graph(), []).nodes.length);
  const response = view(graph(), [`g:${france}`, `g:${p}`]);
  const children = response.nodes.filter((item) => item.parent === `g:${p}`).map((item) => item.slug ?? item.id);
  assert.deepEqual(children, ["politiks.alpha", "politiks.france", "politiks.international", `p:${newer}`, `p:${older}`]);
  const franceNode = node(response, `g:${france}`)!;
  assert.equal(franceNode.expanded, true);
  assert.equal(franceNode.shownChildren, 1);
  assert.equal(response.nodes.filter((item) => item.parent === `g:${france}`)[0].level, "publication");
  assert.equal(node(response, `g:${p}`)!.childCount, 5);
});

test("limits: per-node child limit, clamped request limits, and the global node cap", () => {
  const f = fixture();
  const g = f.gen("big");
  for (let i = 0; i < 250; i++) f.pub(g);
  let response = view(f.graph(), [{ id: `g:${g}`, limit: 2 }]);
  assert.equal(node(response, `g:${g}`)!.shownChildren, 2);
  assert.equal(node(response, `g:${g}`)!.childCount, 250);
  response = view(f.graph(), [`g:${g}`]);
  assert.equal(node(response, `g:${g}`)!.shownChildren, GRAPH_LIMITS.defaultChildLimit);
  response = view(f.graph(), [{ id: `g:${g}`, limit: 10_000 }]);
  assert.equal(node(response, `g:${g}`)!.shownChildren, GRAPH_LIMITS.maxChildLimit);

  const wide = fixture();
  for (let i = 0; i < GRAPH_LIMITS.maxNodes + 50; i++) wide.gen(`g${String(i).padStart(4, "0")}`);
  response = view(wide.graph(), []);
  assert.equal(response.nodes.length, GRAPH_LIMITS.maxNodes);
  assert.equal(response.truncated, true);
});

test("docs example: france→mercatus 80 + international→mercatus 40 ⇒ politiks→mercatus 120, never double counted", () => {
  const { rel, graph, p, france, international, mercatus, pf, pi, pm } = politiks();
  for (let i = 0; i < 80; i++) rel(pf, pm);
  for (let i = 0; i < 40; i++) rel(pi, pm, { type: "contradicts" });
  let response = view(graph(), []);
  const collapsed = edge(response, `g:${p}`, `g:${mercatus}`)!;
  assert.equal(collapsed.total, 120);
  assert.deepEqual(collapsed.byType, { supports: 80, contradicts: 40 });
  assert.equal(response.edges.length, 1);
  assert.deepEqual(node(response, `g:${p}`)!.counts, { internal: 0, external: 120, needsReview: 0 });
  assert.deepEqual(node(response, `g:${mercatus}`)!.counts, { internal: 0, external: 120, needsReview: 0 });

  response = view(graph(), [`g:${p}`]);
  assert.equal(edge(response, `g:${p}`, `g:${mercatus}`), undefined);
  assert.equal(edge(response, `g:${france}`, `g:${mercatus}`)!.total, 80);
  assert.equal(edge(response, `g:${international}`, `g:${mercatus}`)!.total, 40);
  assert.equal(node(response, `g:${p}`)!.counts.external, 120);
  assert.equal(node(response, `g:${france}`)!.counts.external, 80);
});

test("relations between sibling sub-generators count as internal of the collapsed parent, with no self edge", () => {
  const { rel, graph, p, france, international, pf, pi } = politiks();
  for (let i = 0; i < 10; i++) rel(pf, pi, { needsReview: i < 3 });
  let response = view(graph(), []);
  assert.equal(response.edges.length, 0);
  assert.deepEqual(node(response, `g:${p}`)!.counts, { internal: 10, external: 0, needsReview: 3 });
  response = view(graph(), [`g:${p}`]);
  assert.equal(edge(response, `g:${france}`, `g:${international}`)!.total, 10);
  assert.deepEqual(node(response, `g:${p}`)!.counts, { internal: 10, external: 0, needsReview: 3 });
  assert.deepEqual(node(response, `g:${france}`)!.counts, { internal: 0, external: 10, needsReview: 3 });
});

test("direction and needs_review counts follow the lexicographic a < b orientation", () => {
  const { rel, graph, p, mercatus, pf, pm } = politiks();
  for (let i = 0; i < 5; i++) rel(pf, pm, { needsReview: i === 0 });
  for (let i = 0; i < 2; i++) rel(pm, pf, { type: "expands", needsReview: true });
  const result = edge(view(graph(), []), `g:${p}`, `g:${mercatus}`)!;
  const [a] = [`g:${p}`, `g:${mercatus}`].sort();
  assert.equal(result.a, a);
  const fromPolitiks = a === `g:${p}` ? result.aToB : result.bToA;
  assert.equal(fromPolitiks, 5);
  assert.equal(result.aToB + result.bToA, 7);
  assert.equal(result.needsReview, 3);
  assert.deepEqual(result.byType, { supports: 5, expands: 2 });
});

test("message-level projection: expanded publications project their messages, others stay on the publication", () => {
  const { rel, graph, p, france, mercatus, pf, pm } = politiks();
  rel(pf, pf, { n: 1, m: 2 });
  rel(pf, pm, { n: 1, m: 1 });
  rel(pf, pm, { n: 3, m: 2 });
  const messages = new Map([[pf, messagesFor(pf, 3)]]);
  const response = view(graph(), [`g:${p}`, `g:${france}`, `p:${pf}`, `g:${mercatus}`], messages);
  const m1 = `m:${pf}/1`;
  assert.equal(node(response, m1)!.replyTo, null);
  assert.equal(node(response, `m:${pf}/2`)!.replyTo, m1);
  assert.equal(node(response, `p:${pf}`)!.childCount, 3);
  assert.equal(edge(response, m1, `m:${pf}/2`)!.total, 1);
  assert.equal(edge(response, m1, `p:${pm}`)!.total, 1);
  assert.equal(edge(response, `m:${pf}/3`, `p:${pm}`)!.total, 1);
  assert.deepEqual(node(response, `p:${pf}`)!.counts, { internal: 1, external: 2, needsReview: 0 });
  assert.deepEqual(node(response, m1)!.counts, { internal: 0, external: 2, needsReview: 0 });
  // Messages handed in for an unexpanded publication are never displayed.
  assert.equal(view(graph(), [`g:${p}`], messages).nodes.some((item) => item.level === "message"), false);
});

test("unknown or unauthorized ids are ignored like absent ones; malformed requests are rejected", () => {
  const { graph } = politiks();
  const base = view(graph(), []);
  assert.deepEqual(view(graph(), [`g:${gid(999)}`, `p:${pid(999)}`, `m:${pid(999)}/1`]), base);
  assert.equal(parseViewRequest({ expanded: [{ id: "g:../etc" }] }), null);
  assert.equal(parseViewRequest({ expanded: Array.from({ length: GRAPH_LIMITS.maxExpanded + 1 }, (_, i) => ({ id: `g:${gid(i)}` })) }), null);
  assert.equal(parseViewRequest({}), null);
  assert.deepEqual(parseViewRequest({ expanded: [{ id: UNASSIGNED, limit: 0 }, { id: UNASSIGNED }] }), { expanded: [{ id: UNASSIGNED, limit: 1 }] });
  assert.ok(NODE_ID.test(`m:${pid(1)}/12`));
  assert.equal(NODE_ID.test(`m:${pid(1)}/0`), false);
  assert.equal(parseMessageRef(`${pid(1)}/3`)?.n, 3);
  assert.equal(parseMessageRef("nope"), null);
  assert.equal(parseConnectionsRequest({ scope: { kind: "all", node: "x" } }), null);
  assert.equal(parseConnectionsRequest({ scope: { kind: "all", node: UNASSIGNED }, filters: { to: "yesterday" } }), null);
  assert.equal(parseConnectionsRequest({ scope: { kind: "all", node: UNASSIGNED }, limit: 1e6 })?.limit, GRAPH_LIMITS.maxConnectionsPageSize);
});

test("connections: scopes, filters, pagination and cursor stability", () => {
  const f = politiks();
  const { rel, p, france, international, mercatus, pf, pi, pm } = f;
  const unassigned = f.pub(null);
  rel(pf, pi, { at: "2026-10-01T10:00:00.000Z" });                                   // internal to politiks
  rel(pf, pm, { at: "2026-10-02T10:00:00.000Z", type: "contradicts" });             // politiks ↔ mercatus
  rel(pm, pi, { at: "2026-10-03T23:59:00.000Z", needsReview: true });               // mercatus ↔ politiks
  rel(pm, unassigned, { at: "2026-10-04T10:00:00.000Z" });                         // mercatus ↔ unassigned
  rel(pf, pf, { at: "2026-10-05T10:00:00.000Z", n: 1, m: 2 });                      // inside one publication
  const graph = f.graph();
  const ids = (request: ConnectionsRequest) => listConnections(graph, request).relations.map((item) => item.id);

  assert.deepEqual(ids({ scope: { kind: "between", a: `g:${p}`, b: `g:${mercatus}` } }), ["r000003", "r000002"]);
  assert.deepEqual(ids({ scope: { kind: "between", a: `g:${mercatus}`, b: `g:${p}` } }), ["r000003", "r000002"]);
  assert.deepEqual(ids({ scope: { kind: "internal", node: `g:${p}` } }), ["r000005", "r000001"]);
  assert.deepEqual(ids({ scope: { kind: "external", node: `g:${p}` } }), ["r000003", "r000002"]);
  assert.deepEqual(ids({ scope: { kind: "all", node: `g:${france}` } }), ["r000005", "r000002", "r000001"]);
  assert.deepEqual(ids({ scope: { kind: "all", node: UNASSIGNED } }), ["r000004"]);
  assert.deepEqual(ids({ scope: { kind: "all", node: `m:${pf}/2` } }), ["r000005"]);
  assert.deepEqual(ids({ scope: { kind: "external", node: `m:${pf}/1` } }), ["r000005", "r000002", "r000001"]);
  assert.deepEqual(ids({ scope: { kind: "all", node: `p:${pi}` }, filters: { needsReview: true } }), ["r000003"]);
  assert.deepEqual(ids({ scope: { kind: "all", node: `g:${mercatus}` }, filters: { types: ["contradicts"] } }), ["r000002"]);
  assert.deepEqual(ids({ scope: { kind: "all", node: `g:${mercatus}` }, filters: { generator: international } }), ["r000003"]);
  assert.deepEqual(ids({ scope: { kind: "all", node: `g:${p}` }, filters: { from: "2026-10-02", to: "2026-10-03" } }), ["r000003", "r000002"]);
  assert.deepEqual(ids({ scope: { kind: "all", node: `g:${p}` }, filters: { to: "2026-10-01T09:00:00.000Z" } }), []);
  // Unknown (or unauthorized) nodes and generators give an empty result, indistinguishable from an empty node.
  assert.deepEqual(listConnections(graph, { scope: { kind: "all", node: `g:${gid(999)}` } }), { relations: [], total: 0, nextCursor: null });
  assert.deepEqual(ids({ scope: { kind: "between", a: `g:${p}`, b: `p:${pid(999)}` } }), []);
  assert.deepEqual(ids({ scope: { kind: "all", node: `g:${p}` }, filters: { generator: gid(999) } }), []);

  const many = politiks();
  for (let i = 0; i < 25; i++) many.rel(many.pf, many.pm, { at: `2026-10-${String(1 + (i % 5)).padStart(2, "0")}T00:00:00.000Z` });
  const scope = { kind: "all" as const, node: `g:${many.p}` };
  let page = listConnections(many.graph(), { scope, limit: 7 });
  assert.equal(page.total, 25);
  const seen: string[] = page.relations.map((item) => item.id);
  const secondCursor = page.nextCursor;
  // A newer relation added between two pages must not shift the following pages.
  many.rel(many.pf, many.pm, { at: "2027-01-01T00:00:00.000Z" });
  while (page.nextCursor) {
    page = listConnections(many.graph(), { scope, limit: 7, cursor: page.nextCursor });
    seen.push(...page.relations.map((item) => item.id));
  }
  assert.equal(seen.length, 25);
  assert.equal(new Set(seen).size, 25);
  const expected = [...many.data.relations].slice(0, 25)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).map((item) => item.id);
  assert.deepEqual(seen, expected);
  assert.deepEqual(listConnections(many.graph(), { scope, limit: 7, cursor: secondCursor }).relations.map((item) => item.id), expected.slice(7, 14));
  // Garbage cursors restart from the newest relation instead of failing.
  assert.equal(listConnections(many.graph(), { scope, limit: 1, cursor: "%%%" }).relations[0].createdAt, "2027-01-01T00:00:00.000Z");
});

test("perf: 500 generators, 10k publications, 50k relations", () => {
  const f = fixture();
  const generators: string[] = [];
  for (let i = 0; i < 50; i++) {
    const root = f.gen(`root${i}`);
    generators.push(root);
    for (let j = 0; j < 9; j++) generators.push(f.gen(`root${i}.child${j}`));
  }
  const publications: string[] = [];
  for (let i = 0; i < 10_000; i++) publications.push(f.pub(i % 20 === 0 ? null : generators[i % generators.length], new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString()));
  let seed = 42;
  const random = (max: number) => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) % max;
  for (let i = 0; i < 50_000; i++) f.rel(publications[random(10_000)], publications[random(10_000)], { n: 1 + random(3), m: 1 + random(3), needsReview: i % 7 === 0 });
  const expanded = [`g:${generators[0]}`, `g:${generators[1]}`, `g:${generators[10]}`, UNASSIGNED];
  const pub = f.data.publications.find((item) => item.generatorId === generators[1])!.id;
  expanded.push(`p:${pub}`);
  const messages = new Map([[pub, messagesFor(pub, 3)]]);

  let started = performance.now();
  const response = view(f.graph(), expanded, messages);
  const viewMs = performance.now() - started;
  started = performance.now();
  const page = listConnections(f.graph(), { scope: { kind: "all", node: `g:${generators[0]}` }, filters: { needsReview: false } });
  const connectionsMs = performance.now() - started;
  console.log(`perf: view ${viewMs.toFixed(1)} ms (${response.nodes.length} nodes, ${response.edges.length} edges), connections ${connectionsMs.toFixed(1)} ms (${page.total} total)`);
  assert.ok(response.nodes.length > 50);
  assert.ok(viewMs < 300, `view took ${viewMs} ms`);
  assert.ok(connectionsMs < 300, `connections took ${connectionsMs} ms`);
});

// ---------------------------------------------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------------------------------------------

function serviceFixture() {
  const f = politiks();
  const { pf, pm } = f;
  // pf's message 2 was removed: numbers are never reused, so the thread order is 1, 3, 4.
  const pfMessages: MessageData[] = [1, 3, 4].map((n, i) => ({
    ref: `${pf}/${n}`, publicationId: pf, position: i + 1, excerpt: `index excerpt ${n}`, replyTo: i ? `${pf}/${[1, 3, 4][i - 1]}` : null,
  }));
  const pmMessages = messagesFor(pm, 2);
  f.rel(pf, pm, { n: 3, m: 1, type: "supports" });
  f.rel(pm, pf, { n: 2, m: 3, type: "contradicts", needsReview: true });
  f.rel(pf, pm, { n: 1, m: 2 });
  const graph = f.graph();
  const described = new Map([...pfMessages, ...pmMessages].map((message) => [message.ref, message]));
  const repository: GraphRepository = {
    authorizedGraph: async () => graph,
    messages: async (_, id) => (id === pf ? pfMessages : id === pm ? pmMessages : null),
    describeMessages: async (_, refs) => new Map(refs.flatMap((ref) => (described.has(ref) ? [[ref, described.get(ref)!] as const] : []))),
  };
  const snapshot: PublicationSnapshot = {
    id: pf, type: "thread", authorType: "human", authorId: alice.id, status: "published", visibility: "public",
    createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z", publishedAt: "2026-10-02T00:00:00.000Z", score: null,
    summary: "Résumé", sources: [], revision: "0".repeat(64),
    messages: [{ file: "1_un.md", body: "Premier **message**" }, { file: "3_trois.md", body: "Troisième message" }, { file: "4_quatre.md", body: "Quatrième" }],
  };
  const publications = {
    get: async (viewer: { id: string }, id: string) => {
      if (id !== pf || viewer.id !== alice.id) throw new PublicationError("not_found", "Publication introuvable.");
      return snapshot;
    },
  };
  const service = createGraphService({
    repository, publications,
    authors: (ids) => new Map(ids.filter((id) => id === alice.id).map((id) => [id, { id, name: "Alice", handle: "alice", image: null }])),
  });
  return { ...f, service, graph };
}

test("service preview: body from files, thread neighbours, connections without inversion", async () => {
  const { service, pf, pm, france, mercatus } = serviceFixture();
  const preview = await service.preview(alice, `${pf}/3`);
  assert.equal(preview.body, "Troisième message");
  assert.equal(preview.position, 2);
  assert.equal(preview.total, 3);
  assert.equal(preview.parent?.ref, `${pf}/1`);
  assert.equal(preview.parent?.generatorId, france);
  assert.deepEqual(preview.replies.map((item) => item.ref), [`${pf}/4`]);
  assert.equal(preview.href, `/dashboard/publications/${pf}#m-3`);
  assert.equal(preview.author?.name, "Alice");
  assert.equal(preview.publication.title, "pub 1");
  assert.deepEqual(preview.connections.map(({ direction, type, other }) => [direction, type, other.ref, other.generatorId]), [
    ["incoming", "contradicts", `${pm}/2`, mercatus],
    ["outgoing", "supports", `${pm}/1`, mercatus],
  ]);
  assert.equal((await service.preview(alice, `${pf}/1`)).parent, null);
});

test("service preview: unreadable, nonexistent or removed messages are the same not-found", async () => {
  const { service, pf, pm } = serviceFixture();
  const notFound = (promise: Promise<unknown>) => assert.rejects(promise, (error) => error instanceof GraphNotFoundError);
  await notFound(service.preview({ id: "mallory" }, `${pf}/3`));
  await notFound(service.preview(alice, `${pm}/1`));
  await notFound(service.preview(alice, `${pf}/2`));
  await notFound(service.preview(alice, "garbage"));
});

test("service view and connections: messages loaded for expanded publications, summaries from the index", async () => {
  const { service, p, france, pf, pm } = serviceFixture();
  const response = await service.view(alice, { expanded: [{ id: `g:${p}` }, { id: `g:${france}` }, { id: `p:${pf}` }, { id: `p:${pid(999)}` }] });
  assert.deepEqual(response.nodes.filter((item) => item.level === "message").map((item) => item.id), [`m:${pf}/1`, `m:${pf}/3`, `m:${pf}/4`]);
  const page = await service.connections(alice, { scope: { kind: "between", a: `p:${pf}`, b: `p:${pm}` }, limit: 2 });
  assert.equal(page.total, 3);
  assert.equal(page.items.length, 2);
  assert.ok(page.nextCursor);
  assert.equal(page.items[0].source.excerpt, "index excerpt 1");
  assert.equal(page.items[0].source.nodeId, `m:${pf}/1`);
});
