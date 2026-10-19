// Security audit of the knowledge graph: what a viewer may not read must be indistinguishable from what does not exist,
// at every level (generators, publications, messages, relations, counters, connections, previews, cursors).
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { serializeRelation, type RelationRecord } from "../src/lib/graph/format";
import { createRelationWriter, RelationError, type HumanActor } from "../src/lib/graph/relations";
import { createGraphRepository } from "../src/lib/graph/repository";
import { graphResponse, readJson } from "../src/lib/graph/server";
import { createGraphService, GraphNotFoundError, type GraphService } from "../src/lib/graph/service";
import type { ConnectionsScope, NodeId, Viewer } from "../src/lib/graph/types";
import { createPublicationStore } from "../src/lib/publications/store";
import { openVault } from "../src/lib/publications/vault";

const alice = { id: "aliceAAAAAAAAAAAAAAAAAAAAAAAAAAA" };
const bob = { id: "bobBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" };
const mallory = { id: "malloryMMMMMMMMMMMMMMMMMMMMMMMMM" };
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// ---------------------------------------------------------------------------------------------------------------
// Vault fixture, written as Obsidian would. Every item has fixed names and dates, so the same subset written into
// another vault gives byte-identical files: the "reduced" vault is the oracle of what a viewer may observe.
// ---------------------------------------------------------------------------------------------------------------

type Gen = { id: string; slug: string; owner: string; visibility: "private" | "followers" | "public" };
type Pub = {
  id: string; seq: number; author: string; status: "draft" | "published"; visibility: "private" | "followers" | "public";
  generator?: string; files: string[];
};
type Rel = { id: string; source: string; target: string; status: RelationRecord["status"]; minute: number; needsReview?: boolean };

const G = {
  politiks: { id: uuid(1), slug: "politiks", owner: alice.id, visibility: "public" },
  france: { id: uuid(2), slug: "politiks.france", owner: alice.id, visibility: "public" },
  sciencia: { id: uuid(3), slug: "sciencia", owner: alice.id, visibility: "private" },
  bio: { id: uuid(4), slug: "sciencia.bio", owner: alice.id, visibility: "public" },
  club: { id: uuid(5), slug: "club", owner: alice.id, visibility: "followers" },
  bobgen: { id: uuid(6), slug: "bobgen", owner: bob.id, visibility: "private" },
} satisfies Record<string, Gen>;

const two = ["1_un.md", "2_deux.md"];
const P = {
  open: { id: uuid(101), seq: 1, author: alice.id, status: "published", visibility: "public", generator: G.france.id, files: two },
  free: { id: uuid(102), seq: 2, author: alice.id, status: "published", visibility: "public", files: ["1_un.md"] },
  secret: { id: uuid(103), seq: 3, author: alice.id, status: "published", visibility: "private", generator: G.france.id, files: two },
  fans: { id: uuid(104), seq: 4, author: alice.id, status: "published", visibility: "followers", generator: G.france.id, files: ["1_un.md"] },
  draft: { id: uuid(105), seq: 5, author: alice.id, status: "draft", visibility: "public", generator: G.politiks.id, files: ["1_un.md"] },
  hiddenGen: { id: uuid(106), seq: 6, author: alice.id, status: "published", visibility: "public", generator: G.sciencia.id, files: ["1_un.md"] },
  hiddenSub: { id: uuid(107), seq: 7, author: alice.id, status: "published", visibility: "public", generator: G.bio.id, files: ["1_un.md"] },
  clubbed: { id: uuid(108), seq: 8, author: alice.id, status: "published", visibility: "public", generator: G.club.id, files: ["1_un.md"] },
  intoBob: { id: uuid(109), seq: 9, author: alice.id, status: "published", visibility: "public", generator: G.bobgen.id, files: ["1_un.md"] },
  bobs: { id: uuid(110), seq: 10, author: bob.id, status: "published", visibility: "public", generator: G.bobgen.id, files: two },
  bobPrivate: { id: uuid(111), seq: 11, author: bob.id, status: "published", visibility: "private", files: ["1_un.md"] },
} satisfies Record<string, Pub>;

const m = (pub: Pub, n = 1) => `${pub.id}/${n}`;
const R = {
  openFree: { id: uuid(201), source: m(P.open), target: m(P.free), status: "validated", minute: 1 },
  toSecret: { id: uuid(202), source: m(P.open), target: m(P.secret), status: "validated", minute: 2 },
  toFans: { id: uuid(203), source: m(P.open, 2), target: m(P.fans), status: "validated", minute: 3, needsReview: true },
  toDraft: { id: uuid(204), source: m(P.free), target: m(P.draft), status: "validated", minute: 4 },
  secretInternal: { id: uuid(205), source: m(P.secret), target: m(P.secret, 2), status: "validated", minute: 5 },
  toBob: { id: uuid(206), source: m(P.open), target: m(P.bobs), status: "validated", minute: 6 },
  fromHiddenGen: { id: uuid(207), source: m(P.hiddenGen), target: m(P.open), status: "validated", minute: 7, needsReview: true },
  subToClub: { id: uuid(208), source: m(P.hiddenSub), target: m(P.clubbed), status: "validated", minute: 8 },
  bobPrivateLink: { id: uuid(209), source: m(P.bobPrivate), target: m(P.open, 2), status: "validated", minute: 9 },
  proposed: { id: uuid(210), source: m(P.open, 2), target: m(P.free), status: "proposed", minute: 10 },
  rejected: { id: uuid(211), source: m(P.free), target: m(P.open, 2), status: "rejected", minute: 11 },
  missingMessage: { id: uuid(212), source: m(P.open), target: m(P.free, 7), status: "validated", minute: 12 },
  open2Bob: { id: uuid(213), source: m(P.open, 2), target: m(P.bobs, 2), status: "validated", minute: 13 },
} satisfies Record<string, Rel>;

const ALL_GENS: Gen[] = Object.values(G);
const ALL_PUBS: Pub[] = Object.values(P);
const ALL_RELS: Rel[] = Object.values(R);

const folderOf = (pub: Pub) => `${pub.files.length > 1 ? "thread" : "post"}_20261019_${String(pub.seq).padStart(3, "0")}`;
const pubDir = (root: string, pub: Pub) => join(root, "posts", "_users", pub.author, folderOf(pub));

async function writeGenerator(root: string, gen: Gen, visibility = gen.visibility) {
  await mkdir(join(root, "generators", gen.slug), { recursive: true });
  const yaml = `id: ${gen.id}\nslug: ${gen.slug}\ntitle: Titre ${gen.slug}\nowner_id: ${gen.owner}\nvisibility: ${visibility}\n`;
  await writeFile(join(root, "generators", gen.slug, "index.md"), `---\n${yaml}---\nDescription ${gen.slug}.\n`);
}

function indexMd(pub: Pub, visibility = pub.visibility) {
  const yaml = [
    `id: ${pub.id}`, `type: ${pub.files.length > 1 ? "thread" : "post"}`, "author_type: human", `author_id: ${pub.author}`, `status: ${pub.status}`,
    `visibility: ${visibility}`, "created_at: 2026-10-19T10:00:00.000Z", "updated_at: 2026-10-19T10:00:00.000Z",
    ...(pub.status === "published" ? [`published_at: 2026-10-19T10:${String(pub.seq).padStart(2, "0")}:00.000Z`] : []),
    ...(pub.generator ? [`generator: ${pub.generator}`] : []),
  ].join("\n");
  const folder = `posts/_users/${pub.author}/${folderOf(pub)}`;
  const embeds = pub.files.map((file) => `![[${folder}/${file.replace(/\.md$/, "")}]]`).join("\n");
  return `---\n${yaml}\n---\n\nRésumé ${pub.id}\n\n${embeds}\n`;
}

async function writePublication(root: string, pub: Pub) {
  const dir = pubDir(root, pub);
  await mkdir(dir, { recursive: true });
  for (const file of pub.files) await writeFile(join(dir, file), `Contenu ${pub.id} ${file}\n`);
  await writeFile(join(dir, "index.md"), indexMd(pub));
}

function relationRecord(rel: Rel): RelationRecord {
  const at = `2026-10-19T11:${String(rel.minute).padStart(2, "0")}:00.000Z`;
  return {
    id: rel.id, type: "supports", source: rel.source, target: rel.target, status: rel.status, needsReview: rel.needsReview ?? false,
    origin: "human", createdBy: alice.id, createdAt: at,
    validatedBy: rel.status === "validated" ? alice.id : null, validatedAt: rel.status === "validated" ? at : null,
  };
}

async function writeRelation(root: string, rel: Rel, status = rel.status) {
  await mkdir(join(root, "relations"), { recursive: true });
  await writeFile(join(root, "relations", `${rel.id}.md`), serializeRelation(relationRecord({ ...rel, status })));
}

async function setup(items: { gens?: Gen[]; pubs?: Pub[]; rels?: Rel[] } = {}) {
  const root = await mkdtemp(join(tmpdir(), "xi-graph-sec-"));
  for (const gen of items.gens ?? ALL_GENS) await writeGenerator(root, gen);
  for (const pub of items.pubs ?? ALL_PUBS) await writePublication(root, pub);
  for (const rel of items.rels ?? ALL_RELS) await writeRelation(root, rel);
  const vault = await openVault(root);
  const db = new Database(":memory:");
  let clock = Date.parse("2026-10-19T12:00:00.000Z");
  const now = () => new Date(clock += 1000);
  const store = createPublicationStore({ vault, db, now });
  const repo = createGraphRepository({ vault, db, publications: store });
  const writer = createRelationWriter({ vault, db, repository: repo, now });
  const service = createGraphService({ repository: repo, publications: store, authors: () => new Map() });
  return { root: vault.root, vault, db, store, repo, writer, service, cleanup: () => rm(root, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------------------------------------------
// Oracle: the rules of docs/graph.md restated independently of the implementation.
// ---------------------------------------------------------------------------------------------------------------

const pubReadable = (viewer: Viewer, pub: Pub) => pub.author === viewer.id || (pub.status === "published" && pub.visibility === "public");
function parentOf(gen: Gen, gens: Gen[]) {
  const parts = gen.slug.split(".");
  for (let length = parts.length - 1; length > 0; length--) {
    const parent = gens.find((other) => other.slug === parts.slice(0, length).join("."));
    if (parent) return parent;
  }
  return null;
}
function genVisible(viewer: Viewer, gen: Gen, gens: Gen[]): boolean {
  const parent = parentOf(gen, gens);
  return (gen.owner === viewer.id || gen.visibility === "public") && (!parent || genVisible(viewer, parent, gens));
}
const refExists = (ref: string, pubs: Pub[]) => {
  const pub = pubs.find((item) => ref.startsWith(`${item.id}/`));
  return !!pub && pub.files.some((file) => ref === `${pub.id}/${parseInt(file, 10)}`);
};

/** Exactly what `viewer` may know of, as if nothing else had ever been written. */
function reducedFor(viewer: Viewer, gens = ALL_GENS, pubs = ALL_PUBS, rels = ALL_RELS) {
  const readable = pubs.filter((pub) => pubReadable(viewer, pub));
  return {
    gens: gens.filter((gen) => genVisible(viewer, gen, gens)),
    pubs: readable,
    rels: rels.filter((rel) => rel.status === "validated" && refExists(rel.source, readable) && refExists(rel.target, readable)),
  };
}

/** Everything the three routes can tell `viewer`: fully expanded view, every scope's connections, every preview. */
async function observe(service: GraphService, viewer: Viewer) {
  const collapsed = await service.view(viewer, { expanded: [] });
  const expanded = new Set<NodeId>();
  let full = collapsed;
  for (;;) {
    const next = full.nodes.filter((node) => node.level !== "message").map((node) => node.id);
    if (next.every((id) => expanded.has(id))) break;
    for (const id of next) expanded.add(id);
    full = await service.view(viewer, { expanded: [...expanded].map((id) => ({ id, limit: 200 })) });
  }
  const connections: Record<string, unknown> = {};
  const scopes: ConnectionsScope[] = [];
  for (const node of full.nodes) for (const kind of ["all", "internal", "external"] as const) scopes.push({ kind, node: node.id });
  for (const edge of full.edges) scopes.push({ kind: "between", a: edge.a, b: edge.b });
  for (const scope of scopes) connections[JSON.stringify(scope)] = await service.connections(viewer, { scope, limit: 100 });
  // Paginated listing, one relation per page, cursor after cursor.
  const pages = [];
  let cursor: string | null = null;
  do {
    const page = await service.connections(viewer, { scope: { kind: "all", node: "g:unassigned" }, limit: 1, cursor });
    pages.push(page);
    cursor = page.nextCursor;
  } while (cursor && pages.length < 50);
  const previews: Record<string, unknown> = {};
  for (const node of full.nodes.filter((item) => item.level === "message")) previews[node.id] = await service.preview(viewer, node.id.slice(2));
  return { collapsed, full, connections, pages, previews };
}

const FORBIDDEN_FOR_BOB = [
  P.secret.id, P.fans.id, P.draft.id, G.sciencia.id, G.bio.id, G.club.id,
  R.toSecret.id, R.toFans.id, R.toDraft.id, R.secretInternal.id, R.proposed.id, R.rejected.id, R.missingMessage.id,
];

async function assertSameAsReduced(viewer: Viewer, full: GraphService, gens = ALL_GENS, pubs = ALL_PUBS, rels = ALL_RELS) {
  const reduced = await setup(reducedFor(viewer, gens, pubs, rels));
  try {
    const expected = await observe(reduced.service, viewer);
    const actual = await observe(full, viewer);
    assert.deepEqual(actual, expected);
    return actual;
  } finally {
    await reduced.cleanup();
  }
}

const notFound = (promise: Promise<unknown>) => assert.rejects(promise, (error) => error instanceof GraphNotFoundError);

// ---------------------------------------------------------------------------------------------------------------

test("oracle: each viewer observes exactly what a vault holding only their readable items would show", async (t) => {
  const { service, cleanup } = await setup();
  t.after(cleanup);
  const seen = await assertSameAsReduced(bob, service);
  const text = JSON.stringify(seen);
  for (const id of FORBIDDEN_FOR_BOB) assert.ok(!text.includes(id), `bob observes ${id}`);
  // Sanity: the oracle is not vacuous.
  assert.ok(text.includes(R.openFree.id) && text.includes(R.toBob.id) && text.includes(R.fromHiddenGen.id));
  await assertSameAsReduced(mallory, service);
  // The author sees her own private, followers and draft publications and their relations.
  const mine = JSON.stringify(await observe(service, alice));
  for (const id of [P.secret.id, P.fans.id, P.draft.id, R.toSecret.id, R.toFans.id, R.toDraft.id, R.secretInternal.id]) assert.ok(mine.includes(id));
  for (const id of [R.proposed.id, R.rejected.id, R.missingMessage.id, R.bobPrivateLink.id, P.bobPrivate.id, G.bobgen.id]) assert.ok(!mine.includes(id));
});

test("counters: inaccessible relations are absent from node counts, edges and totals; the author still counts them", async (t) => {
  const { service, cleanup } = await setup();
  t.after(cleanup);
  const node = async (viewer: Viewer, id: NodeId) => {
    const view = await service.view(viewer, { expanded: [{ id: `g:${G.politiks.id}` }, { id: `g:${G.france.id}` }, { id: `p:${P.open.id}` }] });
    return view.nodes.find((item) => item.id === id)!;
  };
  // open → free, → bobs (x2), ← hiddenGen for bob; plus → secret, → fans for alice; bobPrivate link only for bob (his own).
  assert.deepEqual((await node(bob, `p:${P.open.id}`)).counts, { internal: 0, external: 5, needsReview: 1 });
  assert.equal((await node(bob, `p:${P.open.id}`)).childCount, 2);
  assert.deepEqual((await node(alice, `p:${P.open.id}`)).counts, { internal: 0, external: 6, needsReview: 2 });
  // france: bob sees one publication (open); alice also sees secret and fans, and secret's internal relation.
  assert.equal((await node(bob, `g:${G.france.id}`)).childCount, 1);
  assert.equal((await node(alice, `g:${G.france.id}`)).childCount, 3);
  assert.deepEqual((await node(alice, `g:${G.france.id}`)).counts, { internal: 3, external: 4, needsReview: 2 });
  // politiks: the draft below it only exists for its author.
  assert.equal((await node(bob, `g:${G.politiks.id}`)).childCount, 1);
  assert.equal((await node(alice, `g:${G.politiks.id}`)).childCount, 2);

  const message = async (viewer: Viewer) => (await service.view(viewer, { expanded: [{ id: `g:${G.politiks.id}` }, { id: `g:${G.france.id}` }, { id: `p:${P.open.id}` }] }))
    .nodes.find((item) => item.id === `m:${m(P.open)}`)!.counts;
  assert.deepEqual(await message(bob), { internal: 0, external: 3, needsReview: 1 });
  assert.deepEqual(await message(alice), { internal: 0, external: 4, needsReview: 1 });

  const total = async (viewer: Viewer, node: NodeId) => (await service.connections(viewer, { scope: { kind: "all", node } })).total;
  assert.equal(await total(bob, `m:${m(P.open)}`), 3);
  assert.equal(await total(alice, `m:${m(P.open)}`), 4);
  const preview = async (viewer: Viewer) => (await service.preview(viewer, m(P.open))).connections.map((item) => item.id).sort();
  assert.deepEqual(await preview(bob), [R.openFree.id, R.toBob.id, R.fromHiddenGen.id].sort());
  assert.deepEqual(await preview(alice), [R.openFree.id, R.toSecret.id, R.toBob.id, R.fromHiddenGen.id].sort());
});

test("hidden generators: subtree hidden, publications re-homed to g:unassigned, belongs_to needs the author's read access", async (t) => {
  const { service, cleanup } = await setup();
  t.after(cleanup);
  const parents = async (viewer: Viewer) => {
    const view = await service.view(viewer, { expanded: [{ id: "g:unassigned", limit: 200 }, ...ALL_GENS.map((gen) => ({ id: `g:${gen.id}`, limit: 200 }))] });
    return new Map(view.nodes.filter((node) => node.level === "publication").map((node) => [node.id.slice(2), node.parent]));
  };
  const bobs = await parents(bob);
  for (const pub of [P.hiddenGen, P.hiddenSub, P.clubbed, P.free, P.intoBob]) assert.equal(bobs.get(pub.id), "g:unassigned", pub.id);
  // Bob reads his private generator: his own publication is attached to it, alice's (she cannot read it) is not.
  assert.equal(bobs.get(P.bobs.id), `g:${G.bobgen.id}`);
  const alices = await parents(alice);
  assert.equal(alices.get(P.hiddenGen.id), `g:${G.sciencia.id}`);
  assert.equal(alices.get(P.hiddenSub.id), `g:${G.bio.id}`);
  assert.equal(alices.get(P.intoBob.id), "g:unassigned");
  assert.equal(alices.get(P.bobs.id), "g:unassigned");
  // Filtering connections by a hidden generator behaves like an unknown generator.
  for (const generator of [G.sciencia.id, G.bio.id, G.club.id]) {
    assert.deepEqual(
      await service.connections(bob, { scope: { kind: "all", node: "g:unassigned" }, filters: { generator } }),
      await service.connections(bob, { scope: { kind: "all", node: "g:unassigned" }, filters: { generator: uuid(999) } }),
    );
  }
});

test("forged node ids, refs and cursors for inaccessible items answer exactly like nonexistent ones", async (t) => {
  const { service, cleanup } = await setup();
  t.after(cleanup);
  const ghost = { pub: uuid(901), gen: uuid(902) };
  const pairs: [NodeId, NodeId][] = [
    [`p:${P.secret.id}`, `p:${ghost.pub}`], [`p:${P.draft.id}`, `p:${ghost.pub}`], [`p:${P.fans.id}`, `p:${ghost.pub}`],
    [`m:${m(P.secret)}`, `m:${ghost.pub}/1`], [`m:${m(P.open, 7)}`, `m:${ghost.pub}/1`],
    [`g:${G.sciencia.id}`, `g:${ghost.gen}`], [`g:${G.bio.id}`, `g:${ghost.gen}`], [`g:${G.club.id}`, `g:${ghost.gen}`],
  ];
  for (const [hidden, missing] of pairs) {
    assert.deepEqual(await service.view(bob, { expanded: [{ id: hidden }] }), await service.view(bob, { expanded: [{ id: missing }] }), hidden);
    for (const kind of ["all", "internal", "external"] as const) {
      assert.deepEqual(await service.connections(bob, { scope: { kind, node: hidden } }), { items: [], total: 0, nextCursor: null });
    }
    assert.deepEqual(
      await service.connections(bob, { scope: { kind: "between", a: hidden, b: `p:${P.open.id}` } }),
      await service.connections(bob, { scope: { kind: "between", a: missing, b: `p:${P.open.id}` } }),
    );
  }
  for (const ref of [m(P.secret), m(P.secret, 2), m(P.fans), m(P.draft), m(P.open, 7), `${ghost.pub}/1`]) {
    await notFound(service.preview(bob, ref));
  }
  await notFound(service.preview(mallory, m(P.bobPrivate)));
  // Mallory's errors carry the same message whatever the reason.
  const message = async (ref: string) => service.preview(mallory, ref).then(() => "found", (error: Error) => `${error.constructor.name}:${error.message}`);
  assert.equal(await message(m(P.secret)), await message(`${ghost.pub}/1`));

  // A cursor built from a hidden relation's key only positions the keyset: same page as in a vault without it.
  const forged = (rel: Rel) => Buffer.from(JSON.stringify([Date.parse(relationRecord(rel).createdAt), rel.id])).toString("base64url");
  const reduced = await setup(reducedFor(bob));
  t.after(reduced.cleanup);
  for (const rel of [R.toSecret, R.toDraft, R.proposed, R.missingMessage]) {
    const request = { scope: { kind: "all", node: `p:${P.open.id}` } as ConnectionsScope, cursor: forged(rel), limit: 2 };
    assert.deepEqual(await service.connections(bob, request), await reduced.service.connections(bob, request));
  }
  for (const cursor of ["", "garbage", Buffer.from("[1e309,\"x\"]").toString("base64url"), Buffer.from("{\"a\":1}").toString("base64url")]) {
    const request = { scope: { kind: "all", node: `p:${P.open.id}` } as ConnectionsScope, cursor, limit: 100 };
    const page = await service.connections(bob, request);
    assert.ok(page.items.every((item) => !FORBIDDEN_FOR_BOB.includes(item.id)));
  }
});

test("disk edits revoke at once: visibility public→private, status change, trash, folder deletion, message file deletion", async (t) => {
  const { root, store, service, cleanup } = await setup();
  t.after(cleanup);
  await observe(service, bob); // Warm every cache.

  // public → private, edited directly on disk: only index.md's mtime tells the index.
  await writeFile(join(pubDir(root, P.free), "index.md"), indexMd(P.free, "private"));
  await notFound(service.preview(bob, m(P.free)));
  let pubs = ALL_PUBS.map((pub) => (pub === P.free ? { ...pub, visibility: "private" as const } : pub));
  let seen = JSON.stringify(await assertSameAsReduced(bob, service, ALL_GENS, pubs));
  assert.ok(!seen.includes(P.free.id) && !seen.includes(R.openFree.id));
  assert.ok((await service.preview(alice, m(P.open))).connections.some((item) => item.id === R.openFree.id));

  // A validated relation turned into a proposal (or rejected) on disk leaves every view at once.
  await writeRelation(root, R.toBob, "proposed");
  await writeRelation(root, R.open2Bob, "rejected");
  let rels = ALL_RELS.map((rel) => (rel === R.toBob ? { ...rel, status: "proposed" as const } : rel === R.open2Bob ? { ...rel, status: "rejected" as const } : rel));
  seen = JSON.stringify(await assertSameAsReduced(bob, service, ALL_GENS, pubs, rels));
  assert.ok(!seen.includes(R.toBob.id) && !seen.includes(R.open2Bob.id));
  assert.ok(!JSON.stringify(await observe(service, alice)).includes(R.toBob.id));
  await writeRelation(root, R.toBob, "validated");
  rels = ALL_RELS.map((rel) => (rel === R.open2Bob ? { ...rel, status: "rejected" as const } : rel));
  assert.ok(JSON.stringify(await assertSameAsReduced(bob, service, ALL_GENS, pubs, rels)).includes(R.toBob.id));

  // Trash through the store: gone for everyone, its author included.
  await store.trash(alice, P.hiddenGen.id);
  pubs = pubs.filter((pub) => pub !== P.hiddenGen);
  await assertSameAsReduced(bob, service, ALL_GENS, pubs, rels);
  for (const viewer of [alice, bob]) {
    const text = JSON.stringify(await observe(service, viewer));
    assert.ok(!text.includes(P.hiddenGen.id) && !text.includes(R.fromHiddenGen.id));
  }

  // Folder deleted in the file manager.
  await rm(pubDir(root, P.bobs), { recursive: true });
  pubs = pubs.filter((pub) => pub !== P.bobs);
  await assertSameAsReduced(bob, service, ALL_GENS, pubs, rels);

  // A single message file deleted, index.md untouched: the message and its relations disappear too.
  await rm(join(pubDir(root, P.open), "2_deux.md"));
  // (index.md still embeds it, so the oracle vault would differ in title and type: checked directly instead.)
  for (const viewer of [alice, bob]) {
    const text = JSON.stringify(await observe(service, viewer));
    assert.ok(text.includes(`m:${m(P.open)}`));
    for (const gone of [`m:${m(P.open, 2)}`, R.toFans.id, R.bobPrivateLink.id]) assert.ok(!text.includes(gone), `${viewer.id} ${gone}`);
    await notFound(service.preview(viewer, m(P.open, 2)));
  }
});

test("generators: deleting the file or making it private hides the subtree and re-homes its publications without leaking counts", async (t) => {
  const { root, service, cleanup } = await setup();
  t.after(cleanup);
  await observe(service, bob);
  // politiks private: politiks.france disappears for bob along with it, open goes to g:unassigned.
  await writeGenerator(root, G.politiks, "private");
  let gens = ALL_GENS.map((gen) => (gen === G.politiks ? { ...gen, visibility: "private" as const } : gen));
  let seen = JSON.stringify(await assertSameAsReduced(bob, service, gens));
  assert.ok(!seen.includes(G.politiks.id) && !seen.includes(G.france.id));
  const unassigned = (await service.view(bob, { expanded: [{ id: "g:unassigned", limit: 200 }] })).nodes.find((node) => node.id === `p:${P.open.id}`);
  assert.equal(unassigned?.parent, "g:unassigned");
  // Alice still sees her generators.
  assert.ok(JSON.stringify(await service.view(alice, { expanded: [] })).includes(G.politiks.id));

  // Deleting a generator's file removes it for its owner as well; its child attaches to the next existing ancestor.
  await writeGenerator(root, G.politiks);
  await rm(join(root, "generators", G.france.slug), { recursive: true });
  gens = ALL_GENS.filter((gen) => gen !== G.france);
  seen = JSON.stringify(await assertSameAsReduced(bob, service, gens));
  assert.ok(!seen.includes(G.france.id));
  const alicesView = JSON.stringify(await observe(service, alice));
  assert.ok(!alicesView.includes(G.france.id));

  // An invalid generator file (here an unknown visibility) is ignored: fail closed.
  await writeGenerator(root, G.politiks, "everyone" as Gen["visibility"]);
  gens = gens.filter((gen) => gen !== G.politiks);
  await assertSameAsReduced(bob, service, gens);
});

test("relation writes: AI only proposes, never alters a validated relation; proposals stay invisible until a human validates", async (t) => {
  const { root, writer, service, cleanup } = await setup();
  t.after(cleanup);
  const ai = { kind: "ai" as const, generatorId: G.politiks.id };
  const before = await observe(service, bob);
  const proposal = await writer.createRelation(ai, { type: "expands", source: m(P.free), target: m(P.open, 2) });
  assert.equal(proposal.status, "proposed");
  assert.deepEqual(await observe(service, bob), before);
  assert.ok(!JSON.stringify(await observe(service, alice)).includes(proposal.id));

  const file = join(root, "relations", `${R.openFree.id}.md`);
  const bytes = await readFile(file, "utf8");
  const code = (promise: Promise<unknown>) => promise.then(() => "ok", (error: RelationError) => error.code);
  assert.equal(await code(writer.reviewRelation(ai as unknown as HumanActor, R.openFree.id, "rejected")), "forbidden");
  assert.equal(await code(writer.reviewRelation(ai as unknown as HumanActor, proposal.id, "validated")), "forbidden");
  assert.equal(await code(writer.setNeedsReview(ai, R.openFree.id, false)), "forbidden");
  // A human cannot reject a validated relation either.
  assert.equal(await code(writer.reviewRelation({ kind: "human", userId: alice.id }, R.openFree.id, "rejected")), "invalid");
  assert.equal(await readFile(file, "utf8"), bytes);
  // Flagging is the one thing an AI may do; status stays validated.
  await writer.setNeedsReview(ai, R.openFree.id, true);
  assert.match(await readFile(file, "utf8"), /status: validated/);

  // An AI acts within its generator owner's read access only: bob's generator cannot reach alice's private messages.
  const bobAi = { kind: "ai" as const, generatorId: G.bobgen.id };
  assert.equal(await code(writer.createRelation(bobAi, { type: "supports", source: m(P.bobs), target: m(P.secret) })), "not_found");
  assert.equal(await code(writer.createRelation({ kind: "ai", generatorId: uuid(999) }, { type: "supports", source: m(P.bobs), target: m(P.open) })), "not_found");
  // Unreadable endpoints are not_found for humans too, exactly like nonexistent ones.
  assert.equal(await code(writer.createRelation({ kind: "human", userId: bob.id }, { type: "supports", source: m(P.bobs), target: m(P.secret) })), "not_found");
  assert.equal(await code(writer.createRelation({ kind: "human", userId: bob.id }, { type: "supports", source: m(P.bobs), target: `${uuid(901)}/1` })), "not_found");

  // The source author validates: only then does the relation appear.
  await writer.reviewRelation({ kind: "human", userId: alice.id }, proposal.id, "validated");
  assert.ok(JSON.stringify(await observe(service, bob)).includes(proposal.id));
});

test("symlinks: generators/ and relations/ entries or folders resolving elsewhere, even inside the vault, are refused", async (t) => {
  const { root, repo, writer, cleanup } = await setup({ gens: [G.politiks], pubs: [P.free, P.open], rels: [R.openFree] });
  t.after(cleanup);
  const extra: Gen = { id: uuid(20), slug: "extra", owner: alice.id, visibility: "public" };
  // A valid generator and relation stored elsewhere in the vault, reached through symlinks.
  await mkdir(join(root, "notes", "extra"), { recursive: true });
  await writeFile(join(root, "notes", "extra", "index.md"), `---\nid: ${extra.id}\nslug: extra\nowner_id: ${alice.id}\nvisibility: public\n---\n`);
  await mkdir(join(root, "generators", "extra"));
  await symlink(join(root, "notes", "extra", "index.md"), join(root, "generators", "extra", "index.md"));
  await symlink(join(root, "notes", "extra"), join(root, "generators", "linked"));
  const hiddenRel = { ...R.toBob, id: uuid(221), source: m(P.free), target: m(P.open, 2) } satisfies Rel;
  await writeFile(join(root, "notes", "rel.md"), serializeRelation(relationRecord(hiddenRel)));
  await symlink(join(root, "notes", "rel.md"), join(root, "relations", `${hiddenRel.id}.md`));
  let graph = await repo.authorizedGraph(alice);
  assert.deepEqual(graph.generators.map((gen) => gen.id), [G.politiks.id]);
  assert.deepEqual(graph.relations.map((rel) => rel.id), [R.openFree.id]);

  // The whole folders replaced by symlinks to other vault folders.
  await rm(join(root, "generators"), { recursive: true });
  await rm(join(root, "relations"), { recursive: true });
  await mkdir(join(root, "notes", "gens", "extra"), { recursive: true });
  await writeFile(join(root, "notes", "gens", "extra", "index.md"), `---\nid: ${extra.id}\nslug: extra\nowner_id: ${alice.id}\nvisibility: public\n---\n`);
  await mkdir(join(root, "notes", "rels"));
  await writeFile(join(root, "notes", "rels", `${hiddenRel.id}.md`), serializeRelation(relationRecord(hiddenRel)));
  await symlink(join(root, "notes", "gens"), join(root, "generators"));
  await symlink(join(root, "notes", "rels"), join(root, "relations"));
  graph = await repo.authorizedGraph(alice);
  assert.deepEqual(graph.generators, []);
  assert.deepEqual(graph.relations, []);
  // And the writer refuses to write through the symlinked folder.
  await assert.rejects(writer.createRelation({ kind: "human", userId: alice.id }, { type: "supports", source: m(P.open), target: m(P.free) }));
  assert.deepEqual(await readdir(join(root, "notes", "rels")), [`${hiddenRel.id}.md`]);
});

test("route guard: 401 before anything else without a session, 400 on invalid input, generic 404/500; oversized bodies are invalid", async () => {
  let called = 0;
  const task = async () => { called++; return { ok: true }; };
  let response = await graphResponse({}, task, async () => null);
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  response = await graphResponse(null, task, async () => null);
  assert.equal(response.status, 401);
  assert.equal(called, 0);
  response = await graphResponse(null, task, async () => bob);
  assert.equal(response.status, 400);
  assert.equal(called, 0);

  const big = JSON.stringify({ expanded: [], padding: "x".repeat(2_000_000) });
  assert.equal(await readJson(new Request("http://localhost/api/graph/view", { method: "POST", body: big })), undefined);
  const chunked = new ReadableStream({ start(controller) { for (let i = 0; i < 40; i++) controller.enqueue(new TextEncoder().encode("x".repeat(10_000))); controller.close(); } });
  assert.equal(await readJson(new Request("http://localhost/api/graph/view", { method: "POST", body: chunked, duplex: "half" } as RequestInit)), undefined);
  assert.deepEqual(await readJson(new Request("http://localhost/api/graph/view", { method: "POST", body: "{\"expanded\":[]}" })), { expanded: [] });
  assert.equal(await readJson(new Request("http://localhost/api/graph/view", { method: "POST", body: "{nope" })), undefined);
});
