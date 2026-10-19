// End-to-end tests of the knowledge graph through the real stack: publication store, graph repository (SQLite
// index reconciled with a temporary vault), relation writer and graph service. Never touches XI_VAULT_PATH.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { parseConnectionsRequest, parseViewRequest } from "../src/lib/graph/engine";
import { serializeGenerator } from "../src/lib/graph/format";
import { createRelationWriter, type HumanActor, type RelationWriter } from "../src/lib/graph/relations";
import { createGraphRepository } from "../src/lib/graph/repository";
import { createGraphService, GraphNotFoundError } from "../src/lib/graph/service";
import {
  UNASSIGNED, type ConnectionsFilters, type ConnectionsScope, type GraphEdge, type SemanticType, type ViewRequest, type ViewResponse,
} from "../src/lib/graph/types";
import { createPublicationStore, type PublicationStore } from "../src/lib/publications/store";
import { openVault, type Vault } from "../src/lib/publications/vault";

const alice = { id: "aliceAAAAAAAAAAAAAAAAAAAAAAAAAAA" };
const bob = { id: "bobBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" };
const human = (user: { id: string }): HumanActor => ({ kind: "human", userId: user.id });
const gid = (n: number) => `6e0d1c2a-0000-4000-8000-${String(n).padStart(12, "0")}`;
const G = {
  politiks: gid(1), france: gid(2), elections: gid(3), international: gid(4), mercatus: gid(5), sciencia: gid(6),
};
const TYPES: SemanticType[] = ["supports", "contradicts", "expands", "related_to", "updates"];
const REPO = resolve(process.cwd());

const authors = (ids: string[]) => new Map(ids.map((id) => [id, { id, name: id.slice(0, 5), handle: id.slice(0, 5), image: null }]));

function openDb(path: string) {
  const db = new Database(path);
  if (path !== ":memory:") db.pragma("journal_mode = WAL");
  return db;
}

function stack(vault: Vault, db: Database.Database, now?: () => Date) {
  const store = createPublicationStore({ vault, db, now });
  const repo = createGraphRepository({ vault, db, publications: store });
  const writer = createRelationWriter({ vault, db, repository: repo, now });
  const service = createGraphService({ repository: repo, publications: store, authors });
  return { store, repo, writer, service };
}

async function writeGenerator(root: string, slug: string, id: string, options: { owner?: string; visibility?: "public" | "private" } = {}) {
  // Flat layout only: dotted slugs, one folder per generator.
  await mkdir(join(root, "generators", slug), { recursive: true });
  await writeFile(join(root, "generators", slug, "index.md"), serializeGenerator({
    id, slug, title: slug, ownerId: options.owner ?? alice.id, visibility: options.visibility ?? "public", createdAt: "2026-10-19T09:00:00.000Z",
  }, `Générateur ${slug}.`));
}

const folderOf = (db: Database.Database, vault: Vault, id: string) =>
  join(vault.root, ...(db.prepare("SELECT path FROM publication WHERE id = ?").get(id) as { path: string }).path.split("/"));

/** Through the store: create, save the messages, add `generator:` to index.md (as Obsidian would), publish. */
async function publication(
  store: PublicationStore, db: Database.Database, vault: Vault, user: { id: string },
  options: { generator?: string; bodies: string[]; visibility?: "public" | "private"; summary?: string },
) {
  const id = await store.create(user);
  const draft = await store.getEditable(user, id);
  const saved = await store.save(user, id, {
    baseRevision: draft.revision, summary: options.summary ?? "", visibility: options.visibility ?? "public",
    messages: options.bodies.map((body, i) => ({ key: `k${i}`, file: null, body })),
  });
  assert.ok(saved.ok);
  const files = options.bodies.map((_, i) => saved.files[`k${i}`]);
  assert.deepEqual(files.map((file) => parseInt(file, 10)), options.bodies.map((_, i) => i + 1));
  const dir = folderOf(db, vault, id);
  if (options.generator) {
    const index = join(dir, "index.md");
    await writeFile(index, (await readFile(index, "utf8")).replace(/^---\n/, `---\ngenerator: ${options.generator}\n`));
  }
  const published = await store.publish(user, id, (await store.getEditable(user, id)).revision);
  assert.ok(published.ok);
  if (options.generator) assert.match(await readFile(join(dir, "index.md"), "utf8"), new RegExp(`^generator: ${options.generator}$`, "m"));
  return { id, dir, files, ref: (n: number) => `${id}/${n}` };
}

type Fixture = Awaited<ReturnType<typeof setup>>;

async function setup(options: { dbPath?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), "xi-graph-int-"));
  const vault = await openVault(root);
  const dbPath = options.dbPath === "file" ? join(root, "..", `${root.split("/").at(-1)}.sqlite`) : ":memory:";
  const db = openDb(dbPath);
  let clock = Date.parse("2026-10-19T10:00:00.000Z");
  const now = () => new Date(clock += 1000);
  const parts = stack(vault, db, now);
  const cleanup = async () => {
    if (db.open) db.close();
    await rm(root, { recursive: true, force: true });
    if (dbPath !== ":memory:") for (const suffix of ["", "-wal", "-shm"]) await rm(`${dbPath}${suffix}`, { force: true });
  };
  return { root, vault, db, dbPath, now, ...parts, cleanup };
}

async function generators(root: string) {
  await writeGenerator(root, "politiks", G.politiks);
  await writeGenerator(root, "politiks.france", G.france);
  await writeGenerator(root, "politiks.france.elections", G.elections);
  await writeGenerator(root, "politiks.international", G.international);
  await writeGenerator(root, "mercatus", G.mercatus);
  await writeGenerator(root, "sciencia", G.sciencia, { owner: bob.id, visibility: "private" });
}

async function publications(f: Fixture, fillers = 0) {
  const pub = (user: { id: string }, options: Parameters<typeof publication>[4]) => publication(f.store, f.db, f.vault, user, options);
  const filler = [];
  // Older than pF: with the default child limit, "load more" reveals them.
  for (let i = 0; i < fillers; i++) filler.push(await pub(alice, { generator: G.france, bodies: [`Brève numéro ${i + 1}.`] }));
  const pE = await pub(alice, { generator: G.elections, bodies: ["Le premier tour est fixé au printemps.", "Les listes sont déposées."] });
  const pI = await pub(alice, { generator: G.international, bodies: ["Le sommet européen s’ouvre.", "Aucun accord sur le budget commun."] });
  const pM = await pub(bob, { generator: G.mercatus, bodies: ["L’inflation ralentit.", "Les salaires réels baissent.", "Le crédit se tend.", "Les marges remontent."] });
  const pU = await pub(alice, { bodies: ["Une note sans générateur."] });
  const pB = await pub(bob, { bodies: ["Brouillon privé de Bob."], visibility: "private" });
  const pF = await pub(alice, {
    generator: G.france, summary: "La réforme des retraites.",
    bodies: ["Le calendrier de la réforme est publié.", "Les syndicats contestent l’âge légal.", "Le Sénat amende le texte.", "Le vote final est reporté."],
  });
  return { pF, pE, pI, pM, pU, pB, filler };
}

type Pubs = Awaited<ReturnType<typeof publications>>;

/** A: pF→pM 80 (5 flagged). B: pI→pM 40. */
async function docsExampleRelations(writer: RelationWriter, { pF, pI, pM }: Pubs) {
  const a = [];
  for (let s = 1; s <= 4; s++) for (let t = 1; t <= 4; t++) for (const type of TYPES) {
    a.push(await writer.createRelation(human(alice), { type, source: pF.ref(s), target: pM.ref(t) }));
  }
  const b = [];
  for (let s = 1; s <= 2; s++) for (let t = 1; t <= 4; t++) for (const type of TYPES) {
    b.push(await writer.createRelation(human(alice), { type, source: pI.ref(s), target: pM.ref(t) }));
  }
  for (const relation of a.slice(0, 5)) await writer.setNeedsReview(human(alice), relation.id, true);
  return { a, b };
}

/**
 * C: pM→pE 7 by bob (updates). D: pF→pI 6 siblings (2 flagged). E: pF/1→pF/2. F: pU→pM. G: pE→pF (sub-generator → parent).
 * H: bob's private pB→pM (hidden from alice). Plus an AI proposal that never enters the graph.
 */
async function otherRelations(writer: RelationWriter, { pF, pE, pI, pM, pU, pB }: Pubs) {
  const c = [];
  for (let s = 1; s <= 4; s++) for (let t = 1; t <= 2; t++) {
    if (c.length < 7) c.push(await writer.createRelation(human(bob), { type: "updates", source: pM.ref(s), target: pE.ref(t) }));
  }
  const d = [];
  for (let s = 1; s <= 3; s++) for (let t = 1; t <= 2; t++) {
    d.push(await writer.createRelation(human(alice), { type: "related_to", source: pF.ref(s), target: pI.ref(t) }));
  }
  for (const relation of d.slice(0, 2)) await writer.setNeedsReview(human(alice), relation.id, true);
  const e = await writer.createRelation(human(alice), { type: "expands", source: pF.ref(1), target: pF.ref(2) });
  const f = await writer.createRelation(human(alice), { type: "related_to", source: pU.ref(1), target: pM.ref(1) });
  const g = await writer.createRelation(human(alice), { type: "supports", source: pE.ref(1), target: pF.ref(3) });
  const h = await writer.createRelation(human(bob), { type: "supports", source: pB.ref(1), target: pM.ref(1) });
  const proposal = await writer.createRelation({ kind: "ai", generatorId: G.mercatus }, { type: "supports", source: pF.ref(4), target: pI.ref(1) });
  assert.equal(proposal.status, "proposed");
  return { c, d, e, f, g, h, proposal };
}

async function fullFixture(options: { dbPath?: string; fillers?: number } = {}) {
  const f = await setup(options);
  await generators(f.root);
  const pubs = await publications(f, options.fillers);
  const docs = await docsExampleRelations(f.writer, pubs);
  const other = await otherRelations(f.writer, pubs);
  return { ...f, pubs, rel: { ...docs, ...other } };
}

const node = (response: ViewResponse, id: string) => {
  const found = response.nodes.find((item) => item.id === id);
  assert.ok(found, `node ${id} missing`);
  return found;
};
const findEdge = (response: ViewResponse, x: string, y: string) =>
  response.edges.find((item) => (item.a === x && item.b === y) || (item.a === y && item.b === x));
/** Edge seen from x: how many relations go x → y and y → x. */
function oriented(response: ViewResponse, x: string, y: string) {
  const found: GraphEdge | undefined = findEdge(response, x, y);
  assert.ok(found, `edge ${x} – ${y} missing`);
  assert.ok(found.a < found.b);
  const forward = found.a === x ? found.aToB : found.bToA;
  return { ...found, forward, backward: found.total - forward };
}
const g = (id: string) => `g:${id}`;
const counts = (internal: number, external: number, needsReview: number) => ({ internal, external, needsReview });

async function hashTree(dir: string, exclude: (relative: string) => boolean = () => false) {
  const hash = createHash("sha256");
  async function walk(current: string, prefix: string) {
    const entries = (await readdir(current, { withFileTypes: true })).sort((x, y) => (x.name < y.name ? -1 : 1));
    for (const entry of entries) {
      const relative = `${prefix}${entry.name}`;
      if (exclude(relative)) continue;
      if (entry.isDirectory()) await walk(join(current, entry.name), `${relative}/`);
      else hash.update(`${relative}\0`).update(await readFile(join(current, entry.name))).update("\0");
    }
  }
  await walk(dir, "");
  return hash.digest("hex");
}

async function allPages(service: ReturnType<typeof createGraphService>, scope: ConnectionsScope, filters?: ConnectionsFilters, limit = 30) {
  const ids: string[] = [];
  let cursor: string | null = null;
  let total = -1;
  let pages = 0;
  do {
    const request = parseConnectionsRequest({ scope, filters, cursor, limit });
    assert.ok(request);
    const page = await service.connections(alice, request);
    if (total >= 0) assert.equal(page.total, total, "total is stable across pages");
    total = page.total;
    ids.push(...page.items.map((item) => item.id));
    cursor = page.nextCursor;
    assert.ok(++pages < 1000);
  } while (cursor);
  assert.equal(new Set(ids).size, ids.length, "no relation appears twice");
  assert.equal(ids.length, total, "pagination reaches exactly `total` relations");
  return { ids, total, pages };
}

const req = (expanded: (string | { id: string; limit?: number })[]): ViewRequest =>
  parseViewRequest({ expanded: expanded.map((item) => (typeof item === "string" ? { id: item } : item)) })!;

// ---------------------------------------------------------------------------------------------------------------

test("store keeps `generator:` through save and publish; generators are flat files with dotted slugs", async (t) => {
  const f = await setup();
  t.after(f.cleanup);
  await generators(f.root);
  const pub = await publication(f.store, f.db, f.vault, alice, { generator: G.elections, bodies: ["Un.", "Deux."] });
  // A later save through the editor keeps the unknown property.
  const snapshot = await f.store.getEditable(alice, pub.id);
  const saved = await f.store.save(alice, pub.id, {
    baseRevision: snapshot.revision, summary: "Résumé modifié", visibility: "public",
    messages: snapshot.messages.map((message, i) => ({ key: `k${i}`, file: message.file, body: message.body })),
  });
  assert.ok(saved.ok);
  assert.match(await readFile(join(pub.dir, "index.md"), "utf8"), new RegExp(`^generator: ${G.elections}$`, "m"));
  const graph = await f.repo.authorizedGraph(alice);
  assert.equal(graph.publications.find((item) => item.id === pub.id)!.generatorId, G.elections);
  assert.deepEqual(graph.generators.map((item) => [item.slug, item.parentId]), [
    ["mercatus", null], ["politiks", null], ["politiks.france", G.politiks], ["politiks.france.elections", G.france], ["politiks.international", G.politiks],
  ]);
  // Physically flat: no generator folder contains a sub-folder.
  for (const entry of await readdir(join(f.root, "generators"))) {
    assert.deepEqual(await readdir(join(f.root, "generators", entry)), ["index.md"]);
  }
});

test("progressive exploration: roots → generators → publications → messages, child counts and load more", async (t) => {
  const f = await fullFixture({ fillers: 41 });
  t.after(f.cleanup);
  const { pF, pM, filler } = f.pubs;

  const roots = await f.service.view(alice, req([]));
  assert.deepEqual(roots.nodes.map((item) => item.id), [g(G.mercatus), g(G.politiks), UNASSIGNED]);
  assert.equal(roots.truncated, false);
  assert.equal(node(roots, g(G.politiks)).childCount, 2);
  assert.equal(node(roots, g(G.politiks)).shownChildren, 0);
  assert.equal(node(roots, g(G.mercatus)).childCount, 1);
  assert.equal(node(roots, UNASSIGNED).childCount, 1);
  // Bob sees his private publication under the unassigned root, but not alice's generators' hidden parts.
  const bobRoots = await f.service.view(bob, req([]));
  assert.deepEqual(bobRoots.nodes.map((item) => item.id), [g(G.mercatus), g(G.politiks), g(G.sciencia), UNASSIGNED]);
  assert.equal(node(bobRoots, UNASSIGNED).childCount, 2);

  const level1 = await f.service.view(alice, req([g(G.politiks)]));
  assert.deepEqual(level1.nodes.filter((item) => item.parent === g(G.politiks)).map((item) => item.slug), ["politiks.france", "politiks.international"]);
  assert.equal(node(level1, g(G.politiks)).expanded, true);
  assert.equal(node(level1, g(G.politiks)).shownChildren, 2);
  // elections + pF + 41 fillers.
  assert.equal(node(level1, g(G.france)).childCount, 43);

  const level2 = await f.service.view(alice, req([g(G.politiks), g(G.france)]));
  const franceChildren = level2.nodes.filter((item) => item.parent === g(G.france));
  assert.equal(node(level2, g(G.france)).shownChildren, 40);
  assert.equal(franceChildren.length, 40);
  assert.equal(franceChildren[0].slug, "politiks.france.elections");
  assert.equal(franceChildren[1].id, `p:${pF.id}`, "newest publication first");
  assert.ok(!franceChildren.some((item) => item.id === `p:${filler[0].id}`), "oldest filler hidden until load more");
  assert.equal(node(level2, `p:${pF.id}`).publicationType, "thread");
  assert.equal(node(level2, `p:${pF.id}`).childCount, 4);

  const more = await f.service.view(alice, req([g(G.politiks), { id: g(G.france), limit: 80 }]));
  assert.equal(node(more, g(G.france)).shownChildren, 43);
  assert.ok(more.nodes.some((item) => item.id === `p:${filler[0].id}`));
  // Load more keeps the first page's order as a prefix.
  assert.deepEqual(more.nodes.filter((item) => item.parent === g(G.france)).slice(0, 40).map((item) => item.id), franceChildren.map((item) => item.id));

  const level3 = await f.service.view(alice, req([g(G.politiks), g(G.france), `p:${pF.id}`]));
  const messages = level3.nodes.filter((item) => item.parent === `p:${pF.id}`);
  assert.deepEqual(messages.map((item) => [item.id, item.position, item.replyTo]), [
    [`m:${pF.ref(1)}`, 1, null], [`m:${pF.ref(2)}`, 2, `m:${pF.ref(1)}`], [`m:${pF.ref(3)}`, 3, `m:${pF.ref(2)}`], [`m:${pF.ref(4)}`, 4, `m:${pF.ref(3)}`],
  ]);
  assert.equal(messages[0].label, "Le calendrier de la réforme est publié.");
  assert.equal(node(level3, `p:${pF.id}`).shownChildren, 4);
  const limited = await f.service.view(alice, req([g(G.politiks), g(G.france), { id: `p:${pF.id}`, limit: 2 }]));
  assert.equal(node(limited, `p:${pF.id}`).shownChildren, 2);
  // Expanding a node whose parent is collapsed, or something unknown, changes nothing.
  assert.deepEqual(await f.service.view(alice, req([`p:${pM.id}`, g(G.sciencia)])), roots);
});

test("recursive aggregation from real files: docs example 80 + 40 ⇒ 120, internal siblings, no double counting", async (t) => {
  const f = await setup();
  t.after(f.cleanup);
  await generators(f.root);
  const pubs = await publications(f);
  const { pF, pM } = pubs;
  await docsExampleRelations(f.writer, pubs);

  // Docs example exactly: two sub-generators of politiks towards mercatus.
  let response = await f.service.view(alice, req([]));
  assert.equal(response.edges.length, 1);
  let edge = oriented(response, g(G.politiks), g(G.mercatus));
  assert.equal(edge.total, 120);
  assert.equal(edge.forward, 120);
  assert.deepEqual(edge.byType, { supports: 24, contradicts: 24, expands: 24, related_to: 24, updates: 24 });
  assert.equal(edge.needsReview, 5);
  assert.deepEqual(node(response, g(G.politiks)).counts, counts(0, 120, 5));
  assert.deepEqual(node(response, g(G.mercatus)).counts, counts(0, 120, 5));
  response = await f.service.view(alice, req([g(G.politiks)]));
  assert.equal(findEdge(response, g(G.politiks), g(G.mercatus)), undefined);
  assert.equal(oriented(response, g(G.france), g(G.mercatus)).total, 80);
  assert.equal(oriented(response, g(G.international), g(G.mercatus)).total, 40);
  assert.deepEqual(node(response, g(G.politiks)).counts, counts(0, 120, 5));

  await otherRelations(f.writer, pubs);
  // Collapsed: siblings (6), intra-publication (1) and elections→france (1) are internal to politiks; bob's 7 come back.
  response = await f.service.view(alice, req([]));
  edge = oriented(response, g(G.politiks), g(G.mercatus));
  assert.deepEqual([edge.total, edge.forward, edge.backward], [127, 120, 7]);
  assert.deepEqual(edge.byType, { supports: 24, contradicts: 24, expands: 24, related_to: 24, updates: 31 });
  assert.deepEqual(node(response, g(G.politiks)).counts, counts(8, 127, 7));
  assert.deepEqual(node(response, g(G.mercatus)).counts, counts(0, 128, 5));
  assert.deepEqual(node(response, UNASSIGNED).counts, counts(0, 1, 0));
  assert.equal(oriented(response, UNASSIGNED, g(G.mercatus)).forward, 1);
  assert.equal(response.edges.length, 2, "no self edge, no edge to invisible data");
  // Bob also sees his private relation from the unassigned root.
  assert.equal(oriented(await f.service.view(bob, req([])), UNASSIGNED, g(G.mercatus)).total, 2);

  response = await f.service.view(alice, req([g(G.politiks)]));
  edge = oriented(response, g(G.france), g(G.mercatus));
  assert.deepEqual([edge.total, edge.forward, edge.backward, edge.needsReview], [87, 80, 7, 5]);
  const siblings = oriented(response, g(G.france), g(G.international));
  assert.deepEqual([siblings.total, siblings.forward, siblings.needsReview, siblings.byType.related_to], [6, 6, 2, 6]);
  assert.deepEqual(node(response, g(G.france)).counts, counts(2, 93, 7));
  assert.deepEqual(node(response, g(G.international)).counts, counts(0, 46, 2));
  assert.deepEqual(node(response, g(G.politiks)).counts, counts(8, 127, 7), "a parent's counters do not change when it is expanded");

  response = await f.service.view(alice, req([g(G.politiks), g(G.france)]));
  assert.equal(oriented(response, `p:${pF.id}`, g(G.mercatus)).total, 80);
  assert.deepEqual(
    (({ total, forward, backward }) => [total, forward, backward])(oriented(response, g(G.elections), g(G.mercatus))), [7, 0, 7]);
  assert.equal(oriented(response, g(G.elections), `p:${pF.id}`).forward, 1);
  assert.equal(oriented(response, `p:${pF.id}`, g(G.international)).total, 6);
  assert.deepEqual(node(response, `p:${pF.id}`).counts, counts(1, 87, 7));
  assert.deepEqual(node(response, g(G.elections)).counts, counts(0, 8, 0));
  assert.deepEqual(node(response, g(G.france)).counts, counts(2, 93, 7));

  response = await f.service.view(alice, req([g(G.politiks), g(G.france), `p:${pF.id}`, g(G.mercatus), `p:${pM.id}`]));
  // pF/1 is the source of the 5 flagged pF→pM relations and of the 2 flagged siblings.
  assert.deepEqual(node(response, `m:${pF.ref(1)}`).counts, counts(0, 23, 7));
  assert.deepEqual(node(response, `m:${pF.ref(4)}`).counts, counts(0, 20, 0), "the AI proposal is not counted");
  assert.equal(oriented(response, `m:${pF.ref(1)}`, `m:${pF.ref(2)}`).forward, 1);
  const pair = oriented(response, `m:${pF.ref(1)}`, `m:${pM.ref(1)}`);
  assert.deepEqual([pair.total, pair.forward], [5, 5]);
  assert.deepEqual(pair.byType, { supports: 1, contradicts: 1, expands: 1, related_to: 1, updates: 1 });
  assert.deepEqual(node(response, `p:${pF.id}`).counts, counts(1, 87, 7));
  // International stays collapsed: pF/1's two sibling relations project on it.
  assert.equal(oriented(response, `m:${pF.ref(1)}`, g(G.international)).forward, 2);
  // Every edge joins two displayed nodes and splits its total by direction.
  const ids = new Set(response.nodes.map((item) => item.id));
  for (const item of response.edges) assert.ok(ids.has(item.a) && ids.has(item.b) && item.aToB + item.bToA === item.total);
});

test("connections: scopes, filters and pagination to completion", async (t) => {
  const f = await fullFixture();
  t.after(f.cleanup);
  const { pF, pM } = f.pubs;
  const total = async (scope: ConnectionsScope, filters?: ConnectionsFilters) => (await allPages(f.service, scope, filters)).total;

  const between = await allPages(f.service, { kind: "between", a: g(G.politiks), b: g(G.mercatus) });
  assert.equal(between.total, 127);
  assert.equal(between.pages, 5);
  assert.equal((await allPages(f.service, { kind: "between", a: g(G.mercatus), b: g(G.politiks) }, undefined, 7)).total, 127);
  assert.equal(await total({ kind: "internal", node: g(G.politiks) }), 8);
  assert.equal(await total({ kind: "external", node: g(G.politiks) }), 127);
  assert.equal(await total({ kind: "all", node: g(G.politiks) }), 135);
  assert.equal(await total({ kind: "all", node: g(G.mercatus) }), 128);
  assert.equal(await total({ kind: "external", node: UNASSIGNED }), 1);
  assert.equal(await total({ kind: "between", a: g(G.france), b: g(G.international) }), 6);
  assert.equal(await total({ kind: "internal", node: `p:${pF.id}` }), 1);
  assert.equal(await total({ kind: "all", node: `m:${pF.ref(2)}` }), 23);
  assert.equal(await total({ kind: "all", node: g(G.sciencia) }), 0, "unreadable generator = empty scope");
  assert.equal(await total({ kind: "all", node: `p:${f.pubs.pB.id}` }), 0, "unreadable publication = empty scope");

  const politiksMercatus: ConnectionsScope = { kind: "between", a: g(G.politiks), b: g(G.mercatus) };
  assert.equal(await total(politiksMercatus, { types: ["updates"] }), 31);
  assert.equal(await total(politiksMercatus, { types: ["updates", "supports"] }), 55);
  assert.equal(await total({ kind: "all", node: g(G.mercatus) }, { generator: G.international }), 40);
  assert.equal(await total({ kind: "all", node: g(G.mercatus) }, { generator: G.elections }), 7);
  assert.equal(await total({ kind: "all", node: g(G.mercatus) }, { generator: G.sciencia }), 0);
  assert.equal(await total({ kind: "all", node: g(G.politiks) }, { needsReview: true }), 7);
  assert.equal(await total({ kind: "all", node: g(G.politiks) }, { needsReview: false }), 128);
  // Period: bob's seven relations were created in one consecutive burst.
  const times = f.rel.c.map((item) => item.createdAt);
  assert.equal(await total(politiksMercatus, { from: times[0], to: times.at(-1) }), 7);
  assert.equal(await total(politiksMercatus, { from: times[1], to: times.at(-2) }), 5);
  assert.equal(await total(politiksMercatus, { to: "2026-10-19" }), 127, "a date-only upper bound includes its whole day");
  assert.equal(await total(politiksMercatus, { from: "2026-10-20" }), 0);
  const combined = await allPages(f.service, politiksMercatus, { types: ["updates"], needsReview: false, generator: G.france, to: "2026-10-19" }, 4);
  // updates pF→pM (16, one flagged) + bob's 7 under elections; pI→pM is outside france.
  assert.equal(combined.total, 15 + 7);

  // Items: newest first, endpoints described from the index, direction never inverted.
  const first = await f.service.connections(alice, parseConnectionsRequest({ scope: { kind: "all", node: `p:${pM.id}` }, limit: 100 })!);
  assert.equal(first.items.length, 100);
  for (let i = 1; i < first.items.length; i++) assert.ok(first.items[i - 1].createdAt >= first.items[i].createdAt);
  const fromBob = first.items.find((item) => item.id === f.rel.c[0].id)!;
  assert.equal(fromBob.source.ref, pM.ref(1));
  assert.equal(fromBob.source.generatorId, G.mercatus);
  assert.equal(fromBob.target.generatorId, G.elections);
  assert.equal(fromBob.target.nodeId, `m:${f.pubs.pE.ref(1)}`);
  assert.equal(fromBob.source.excerpt, "L’inflation ralentit.");
  assert.ok(!first.items.some((item) => item.id === f.rel.h.id || item.id === f.rel.proposal.id));
  assert.equal(parseConnectionsRequest({ scope: { kind: "all", node: "g:nope" } }), null);
});

test("preview: body re-read from the files, thread neighbours, connection directions, href", async (t) => {
  const f = await fullFixture();
  t.after(f.cleanup);
  const { pF, pI, pM, pB } = f.pubs;
  let preview = await f.service.preview(alice, pF.ref(2));
  assert.equal(preview.body, "Les syndicats contestent l’âge légal.");
  assert.equal(preview.href, `/dashboard/publications/${pF.id}#m-2`);
  assert.equal(preview.nodeId, `m:${pF.ref(2)}`);
  assert.deepEqual([preview.position, preview.total], [2, 4]);
  assert.equal(preview.parent?.ref, pF.ref(1));
  assert.equal(preview.parent?.generatorId, G.france);
  assert.deepEqual(preview.replies.map((item) => item.ref), [pF.ref(3)]);
  assert.equal(preview.author?.id, alice.id);
  assert.deepEqual([preview.publication.status, preview.publication.visibility, preview.publication.type], ["published", "public", "thread"]);
  assert.equal(preview.connections.length, 23);
  const outgoing = preview.connections.filter((item) => item.direction === "outgoing");
  assert.equal(outgoing.length, 22);
  assert.equal(outgoing.filter((item) => item.other.publicationId === pM.id).length, 20);
  assert.deepEqual(outgoing.filter((item) => item.other.publicationId === pI.id).map((item) => item.other.generatorId), [G.international, G.international]);
  const incoming = preview.connections.filter((item) => item.direction === "incoming");
  assert.deepEqual(incoming.map((item) => [item.id, item.other.ref, item.type]), [[f.rel.e.id, pF.ref(1), "expands"]]);
  const first = await f.service.preview(alice, pF.ref(1));
  assert.equal(first.parent, null);
  assert.deepEqual((await f.service.preview(alice, pF.ref(4))).replies, []);
  // Seen from the target, the same relation is incoming.
  const target = await f.service.preview(bob, pM.ref(1));
  assert.ok(target.connections.some((item) => item.id === f.rel.h.id && item.direction === "incoming"));
  assert.ok(target.connections.filter((item) => item.other.publicationId === pF.id).every((item) => item.direction === "incoming"));

  // External edit of the message file only (index.md untouched): the preview reads the new body at once.
  await writeFile(join(pF.dir, pF.files[1]), "Texte réécrit dans **Obsidian** hier.\n");
  preview = await f.service.preview(alice, pF.ref(2));
  assert.equal(preview.body, "Texte réécrit dans **Obsidian** hier.\n");
  assert.equal((await f.service.preview(alice, pF.ref(3))).parent?.excerpt, "Texte réécrit dans Obsidian hier.");

  // Unreadable = nonexistent.
  const notFound = (promise: Promise<unknown>) => assert.rejects(promise, (error) => error instanceof GraphNotFoundError);
  await notFound(f.service.preview(alice, pB.ref(1)));
  await notFound(f.service.preview(alice, `${pF.id}/9`));
  await notFound(f.service.preview(alice, "../../etc/passwd"));
  assert.equal((await f.service.preview(bob, pB.ref(1))).body, "Brouillon privé de Bob.");
});

test("migration and rebuild: pre-graph schema, rebuild(), deleted database; vault files untouched", async (t) => {
  const f = await fullFixture({ dbPath: "file" });
  t.after(f.cleanup);
  const { pF, pM } = f.pubs;
  const request = req([g(G.politiks), g(G.france), `p:${pF.id}`, g(G.mercatus), `p:${pM.id}`, UNASSIGNED]);
  const scopes: ConnectionsScope[] = [
    { kind: "between", a: g(G.politiks), b: g(G.mercatus) }, { kind: "internal", node: g(G.politiks) }, { kind: "all", node: `m:${pF.ref(2)}` },
  ];
  const observe = async (service: ReturnType<typeof createGraphService>) => ({
    view: await service.view(alice, request),
    bobView: await service.view(bob, req([UNASSIGNED, g(G.sciencia)])),
    connections: await Promise.all(scopes.map(async (scope) => (await allPages(service, scope, undefined, 100)).ids)),
  });
  const reference = await observe(f.service);
  const vaultHash = await hashTree(f.root);

  // A database from before the graph: the publication table without generator_id, no xi_index_meta, a stale row,
  // and Better Auth's tables, which must survive.
  const oldPath = join(f.root, "..", `${f.root.split("/").at(-1)}-old.sqlite`);
  t.after(async () => { for (const suffix of ["", "-wal", "-shm"]) await rm(`${oldPath}${suffix}`, { force: true }); });
  const old = openDb(oldPath);
  old.exec(`
    CREATE TABLE user (id TEXT PRIMARY KEY, name TEXT);
    INSERT INTO user VALUES ('${alice.id}', 'Alice');
    CREATE TABLE publication (
      id TEXT PRIMARY KEY, author_type TEXT NOT NULL, author_id TEXT NOT NULL, type TEXT NOT NULL, status TEXT NOT NULL,
      visibility TEXT NOT NULL, path TEXT NOT NULL, original_path TEXT, trashed_at TEXT, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, published_at TEXT, score REAL, excerpt TEXT NOT NULL DEFAULT '', index_mtime REAL NOT NULL
    );
    INSERT INTO publication VALUES ('${gid(999)}', 'human', '${alice.id}', 'post', 'published', 'public', 'posts/_users/x/post_20260101_001',
      NULL, NULL, 'a', 'b', '2026-01-01', NULL, 'stale', 1);
  `);
  old.close();
  const upgradedDb = openDb(oldPath);
  t.after(() => { if (upgradedDb.open) upgradedDb.close(); });
  const upgraded = stack(f.vault, upgradedDb);
  assert.deepEqual(await observe(upgraded.service), reference);
  assert.ok((upgradedDb.prepare("PRAGMA table_info(publication)").all() as { name: string }[]).some((column) => column.name === "generator_id"));
  assert.equal((upgradedDb.prepare("SELECT value FROM xi_index_meta WHERE key = 'schema_version'").get() as { value: string }).value.length > 0, true);
  assert.equal(upgradedDb.prepare("SELECT id FROM publication WHERE id = ?").get(gid(999)), undefined, "stale rows are gone");
  assert.equal((upgradedDb.prepare("SELECT name FROM user").get() as { name: string }).name, "Alice");

  // rebuild() from scratch, on the fixture's own database.
  await f.repo.rebuild();
  assert.deepEqual(await observe(f.service), reference);
  await upgraded.repo.rebuild();
  assert.deepEqual(await observe(upgraded.service), reference);
  // A rebuild from another connection on the same file (pnpm graph:reindex while the server runs).
  const otherDb = openDb(f.dbPath);
  await stack(f.vault, otherDb).repo.rebuild();
  otherDb.close();
  assert.deepEqual(await observe(f.service), reference);

  // Database file deleted: a fresh one is rebuilt from the vault alone.
  f.db.close();
  for (const suffix of ["", "-wal", "-shm"]) await rm(`${f.dbPath}${suffix}`, { force: true });
  const freshDb = openDb(f.dbPath);
  t.after(() => { if (freshDb.open) freshDb.close(); });
  const fresh = stack(f.vault, freshDb);
  await fresh.repo.reconcile();
  assert.deepEqual(await observe(fresh.service), reference);

  await fresh.service.preview(alice, pF.ref(2));
  assert.equal(await hashTree(f.root), vaultHash, "vault Markdown is byte-identical after reconcile/rebuild/view");
});

// ---------------------------------------------------------------------------------------------------------------
// Scripts as child processes, on a temporary vault and database only.
// ---------------------------------------------------------------------------------------------------------------

type Run = { code: number; stdout: string; stderr: string };
function runScript(script: string, args: string[], env: NodeJS.ProcessEnv): Promise<Run> {
  return new Promise((resolvePromise) => {
    execFile(join(REPO, "node_modules", ".bin", "tsx"), [join(REPO, "scripts", script), ...args], { cwd: REPO, env, timeout: 60_000 },
      (error, stdout, stderr) => resolvePromise({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr }));
  });
}

test("scripts: graph-seed-demo then graph-reindex on a temporary vault and database", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "xi-graph-scripts-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const vaultPath = join(dir, "vault");
  await mkdir(vaultPath);
  const dbPath = join(dir, "auth.sqlite");
  const env: NodeJS.ProcessEnv = {
    ...process.env, XI_VAULT_PATH: vaultPath, AUTH_DATABASE_PATH: dbPath, BETTER_AUTH_SECRET: "x".repeat(40), BETTER_AUTH_URL: "http://localhost:3000",
  };

  // Usage errors write nothing.
  const usage = await runScript("graph-seed-demo.ts", ["relative/path", alice.id], env);
  assert.equal(usage.code, 1);
  assert.match(usage.stderr, /Usage/);

  const seeded = await runScript("graph-seed-demo.ts", [vaultPath, alice.id], env);
  assert.equal(seeded.code, 0, seeded.stderr);
  assert.match(seeded.stdout, /5 générateurs, 5 publications, 6 relations/);
  const again = await runScript("graph-seed-demo.ts", [vaultPath, alice.id], env);
  assert.equal(again.code, 1);
  assert.match(again.stderr, /déjà/);

  // Reindex refuses to create the database (it must come from db:migrate).
  const missing = await runScript("graph-reindex.ts", [], env);
  assert.equal(missing.code, 1);
  new Database(dbPath).close();
  const vaultHash = await hashTree(vaultPath);
  const reindexed = await runScript("graph-reindex.ts", [], env);
  assert.equal(reindexed.code, 0, reindexed.stderr);
  assert.match(reindexed.stdout, /Index rebuilt: 5 publications, 7 messages, 5 generator files, 6 relation files\./);
  assert.equal(await hashTree(vaultPath), vaultHash, "reindex never writes to the vault");
  assert.equal((await runScript("graph-reindex.ts", [], { ...env, XI_VAULT_PATH: join(dir, "nope") })).code, 1);

  // The rebuilt index serves the demo graph.
  const db = openDb(dbPath);
  t.after(() => db.close());
  const { service, repo } = stack(await openVault(vaultPath), db);
  const graph = await repo.authorizedGraph(alice);
  assert.deepEqual(graph.generators.map((item) => item.slug), ["mercatus", "politiks", "politiks.france", "politiks.international", "sciencia"]);
  assert.equal(graph.publications.length, 5);
  assert.ok(graph.publications.every((item) => item.generatorId !== null));
  assert.equal(graph.relations.length, 5, "the AI proposal stays out of the graph");
  assert.equal(graph.relations.filter((item) => item.needsReview).length, 1);
  const roots = await service.view(alice, req([]));
  assert.deepEqual(roots.nodes.map((item) => item.slug), ["mercatus", "politiks", "sciencia"]);
  assert.equal(roots.nodes.reduce((sum, item) => sum + item.counts.internal, 0) + roots.edges.reduce((sum, item) => sum + item.total, 0), 5);
  // Another user sees the public demo too, but nothing is unassigned.
  assert.equal((await service.view(bob, req([]))).nodes.length, 3);
});
