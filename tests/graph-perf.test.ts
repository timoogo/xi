// Performance of the graph stack on a large vault generated on disk (temporary directory only, never XI_VAULT_PATH).
// Files are written directly in the documented format (docs/graph.md, docs/publications.md) for speed; the test
// checks that every one of them is accepted by the real parsers. Bounds are deliberately generous: they catch
// pathological regressions (quadratic scans, missing caches), not small slowdowns. Measured numbers are logged.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import Database from "better-sqlite3";
import { parseConnectionsRequest, parseViewRequest } from "../src/lib/graph/engine";
import { createGraphRepository } from "../src/lib/graph/repository";
import { createGraphService } from "../src/lib/graph/service";
import { GRAPH_LIMITS, SEMANTIC_TYPES, UNASSIGNED, type ViewRequest } from "../src/lib/graph/types";
import { createPublicationStore } from "../src/lib/publications/store";
import { openVault } from "../src/lib/publications/vault";

const SIZE = { generators: 200, publications: 3000, messagesPerPublication: 3, relations: 20_000, users: 10 };
// Measured on a dev laptop (2026-10): cold ≈ 6.5 s; warm view, view after a change, connections page ≈ 2 s each.
// Every request re-scans the vault (≈ 1 s per reconcile at 20k relation files) and the service reconciles twice per
// request (authorizedGraph, then messages/describeMessages), which is what dominates the warm numbers.
const BOUNDS_MS = { cold: 45_000, warmView: 10_000, changedView: 10_000, connections: 10_000, cappedView: 10_000 };

const users = Array.from({ length: SIZE.users }, (_, i) => `perfUser${String(i).padStart(2, "0")}AAAAAAAAAAAAAAAAAAAA`);
const viewer = { id: users[0] };
const uuid = (kind: number, n: number) => `${kind.toString(16).padStart(8, "0")}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

/** Deterministic PRNG (mulberry32): the same vault on every run. */
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function inBatches(tasks: (() => Promise<unknown>)[], size = 256) {
  for (let i = 0; i < tasks.length; i += size) await Promise.all(tasks.slice(i, i + size).map((task) => task()));
}

async function generateVault(root: string) {
  const rand = random(42);
  const pick = <T>(list: readonly T[]) => list[Math.floor(rand() * list.length)];
  const writes: (() => Promise<unknown>)[] = [];
  const file = (path: string, content: string) => writes.push(async () => {
    await mkdir(join(root, ...path.split("/").slice(0, -1)), { recursive: true });
    await writeFile(join(root, ...path.split("/")), content);
  });

  // 10 roots, 40 children, 150 grandchildren: flat folders, dotted slugs.
  const slugs: string[] = [];
  for (let r = 0; r < 10; r++) slugs.push(`g${r}`);
  for (let r = 0; r < 10; r++) for (let c = 0; c < 4; c++) slugs.push(`g${r}.c${c}`);
  for (let r = 0; r < 10 && slugs.length < SIZE.generators; r++) {
    for (let c = 0; c < 4; c++) for (let d = 0; d < 4 && slugs.length < SIZE.generators; d++) slugs.push(`g${r}.c${c}.d${d}`);
  }
  const generators = slugs.map((slug, i) => ({ id: uuid(1, i + 1), slug }));
  for (const { id, slug } of generators) {
    file(`generators/${slug}/index.md`, `---\nid: ${id}\nslug: ${slug}\ntitle: Générateur ${slug}\nowner_id: ${users[0]}\nvisibility: public\ncreated_at: 2026-01-01T00:00:00.000Z\n---\nDescription ${slug}.\n`);
  }

  const publications: { id: string; generator: string | null; dir: string }[] = [];
  const sequence = new Map<string, number>();
  const base = Date.parse("2026-01-01T00:00:00.000Z");
  for (let i = 0; i < SIZE.publications; i++) {
    const author = users[i % users.length];
    const seq = (sequence.get(author) ?? 0) + 1;
    sequence.set(author, seq);
    const id = uuid(2, i + 1);
    const generator = rand() < 0.1 ? null : pick(generators).id;
    const folder = `thread_20260101_${String(seq).padStart(3, "0")}`;
    const dir = `posts/_users/${author}/${folder}`;
    const date = new Date(base + i * 60_000).toISOString();
    const files = Array.from({ length: SIZE.messagesPerPublication }, (_, n) => `${n + 1}_message_${n + 1}.md`);
    for (const [n, name] of files.entries()) file(`${dir}/${name}`, `Message ${n + 1} de la publication ${i + 1}, avec un peu de **texte**.\n`);
    file(`${dir}/index.md`, [
      "---", `id: ${id}`, "type: thread", "author_type: human", `author_id: ${author}`, "status: published", "visibility: public",
      `created_at: ${date}`, `updated_at: ${date}`, `published_at: ${date}`, ...(generator ? [`generator: ${generator}`] : []), "---", "",
      `Résumé de la publication ${i + 1}.`, "", ...files.map((name) => `![[${dir}/${name.replace(/\.md$/, "")}]]`), "",
    ].join("\n"));
    publications.push({ id, generator, dir });
  }

  let validated = 0;
  const pairs = new Set<string>();
  for (let i = 0; pairs.size < SIZE.relations; i++) {
    const source = `${pick(publications).id}/${1 + Math.floor(rand() * SIZE.messagesPerPublication)}`;
    const target = `${pick(publications).id}/${1 + Math.floor(rand() * SIZE.messagesPerPublication)}`;
    const type = pick(SEMANTIC_TYPES);
    const key = `${type}|${source}|${target}`;
    if (source === target || pairs.has(key)) continue;
    pairs.add(key);
    const id = uuid(3, pairs.size);
    const proposed = rand() < 0.05;
    if (!proposed) validated++;
    const at = new Date(base + pairs.size * 1000).toISOString();
    file(`relations/${id}.md`, [
      "---", `id: ${id}`, `type: ${type}`, `source: ${source}`, `target: ${target}`, `status: ${proposed ? "proposed" : "validated"}`,
      `needs_review: ${rand() < 0.03}`, `origin: ${proposed ? "ai" : "human"}`, `created_by: ${users[0]}`, `created_at: ${at}`,
      ...(proposed ? [] : [`validated_by: ${users[0]}`, `validated_at: ${at}`]), "---", "",
    ].join("\n"));
  }
  await inBatches(writes);
  return { generators, publications, validated, files: writes.length };
}

async function time<T>(label: string, task: () => Promise<T>) {
  const start = performance.now();
  const result = await task();
  const ms = performance.now() - start;
  console.log(`[graph-perf] ${label}: ${ms.toFixed(0)} ms`);
  return { result, ms };
}

test("large vault: cold reconcile, warm view, view after one change, connections page, node cap", { timeout: 180_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "xi-graph-perf-"));
  const dbPath = `${root}.sqlite`;
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    for (const suffix of ["", "-wal", "-shm"]) await rm(`${dbPath}${suffix}`, { force: true });
  });
  const generated = await time("generate vault", () => generateVault(root));
  const vault = generated.result;
  console.log(`[graph-perf] vault: ${vault.files} files, ${SIZE.generators} generators, ${SIZE.publications} publications, ${SIZE.relations} relations (${vault.validated} validated)`);

  // A real database file in WAL mode, as the app opens it.
  const db = new Database(dbPath);
  t.after(() => { if (db.open) db.close(); });
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  const opened = await openVault(root);
  const store = createPublicationStore({ vault: opened, db });
  const repository = createGraphRepository({ vault: opened, db, publications: store });
  const service = createGraphService({ repository, publications: store, authors: () => new Map() });

  const cold = await time("cold reconcile + authorized graph", () => repository.authorizedGraph(viewer));
  // Every generated file is valid for the real parsers.
  assert.equal(cold.result.generators.length, SIZE.generators);
  assert.equal(cold.result.publications.length, SIZE.publications);
  assert.equal(cold.result.relations.length, vault.validated);
  assert.equal(cold.result.publications.filter((item) => item.generatorId === null).length, vault.publications.filter((item) => item.generator === null).length);
  assert.ok(cold.result.publications.every((item) => item.messageCount === SIZE.messagesPerPublication));
  assert.ok(cold.ms < BOUNDS_MS.cold, `cold ${cold.ms} ms`);

  const busiest = vault.generators[0].id;
  const publicationOf = cold.result.publications.find((item) => item.generatorId !== null)!;
  const request: ViewRequest = parseViewRequest({
    expanded: [{ id: `g:${busiest}` }, { id: UNASSIGNED }, { id: `g:${publicationOf.generatorId}` }, { id: `p:${publicationOf.id}` }],
  })!;
  const first = await time("first view (graph cached, engine cold)", () => service.view(viewer, request));
  const warm = await time("warm view", () => service.view(viewer, request));
  assert.deepEqual(warm.result, first.result);
  assert.ok(warm.ms < BOUNDS_MS.warmView, `warm view ${warm.ms} ms`);
  const roots = first.result.nodes.filter((item) => item.parent === null);
  // Every validated relation is either internal to one root or counted on the edges between roots.
  const rootView = await service.view(viewer, { expanded: [] });
  assert.equal(
    rootView.nodes.reduce((sum, item) => sum + item.counts.internal, 0) + rootView.edges.reduce((sum, item) => sum + item.total, 0),
    vault.validated,
  );
  assert.equal(roots.length, 11);

  // One external edit: a publication goes private for others; its index.md mtime changes.
  const target = vault.publications.find((item) => !item.dir.includes(users[0]))!;
  const index = join(root, ...target.dir.split("/"), "index.md");
  await writeFile(index, (await readFile(index, "utf8")).replace("visibility: public", "visibility: private"));
  const future = new Date(Date.now() + 5_000);
  await utimes(index, future, future);
  const changed = await time("view after one file change", () => service.view(viewer, request));
  assert.ok(changed.ms < BOUNDS_MS.changedView, `changed view ${changed.ms} ms`);
  const after = await repository.authorizedGraph(viewer);
  assert.equal(after.publications.length, SIZE.publications - 1);
  assert.ok(!after.relations.some((item) => item.sourcePublication === target.id || item.targetPublication === target.id));

  const scope = { kind: "between", a: roots[0].id, b: roots[1].id };
  const connections = await time("connections page (between two roots)", () => service.connections(viewer, parseConnectionsRequest({ scope })!));
  assert.ok(connections.ms < BOUNDS_MS.connections, `connections ${connections.ms} ms`);
  assert.ok(connections.result.total > 0);
  assert.equal(connections.result.items.length, Math.min(GRAPH_LIMITS.connectionsPageSize, connections.result.total));
  const next = await time("connections next page", () => service.connections(viewer, parseConnectionsRequest({ scope, cursor: connections.result.nextCursor })!));
  assert.ok(!next.result.items.some((item) => connections.result.items.some((other) => other.id === item.id)));

  // Many expansions with large limits: the response stays capped.
  const many = parseViewRequest({
    expanded: [
      ...vault.generators.slice(0, 50).map(({ id }) => ({ id: `g:${id}`, limit: GRAPH_LIMITS.maxChildLimit })),
      { id: UNASSIGNED, limit: GRAPH_LIMITS.maxChildLimit },
      ...after.publications.slice(0, 9).map(({ id }) => ({ id: `p:${id}`, limit: GRAPH_LIMITS.maxChildLimit })),
    ],
  })!;
  assert.equal(many.expanded.length, GRAPH_LIMITS.maxExpanded);
  assert.equal(parseViewRequest({ expanded: Array.from({ length: GRAPH_LIMITS.maxExpanded + 1 }, () => ({ id: UNASSIGNED })) }), null);
  const capped = await time("capped view (60 expansions)", () => service.view(viewer, many));
  assert.ok(capped.ms < BOUNDS_MS.cappedView, `capped view ${capped.ms} ms`);
  assert.equal(capped.result.truncated, true);
  assert.equal(capped.result.nodes.length, GRAPH_LIMITS.maxNodes);
  const ids = new Set(capped.result.nodes.map((item) => item.id));
  assert.equal(ids.size, capped.result.nodes.length);
  // Ancestor-closed even when truncated: every parent is in the response, every edge joins two returned nodes.
  for (const item of capped.result.nodes) assert.ok(item.parent === null || ids.has(item.parent));
  for (const item of capped.result.edges) assert.ok(ids.has(item.a) && ids.has(item.b));
});
