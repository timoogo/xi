import { readFile, stat } from "node:fs/promises";
import type Database from "better-sqlite3";
import { dropIndexTables, indexGeneration } from "../publications/index-db";
import type { PublicationStore } from "../publications/store";
import { assertWithin, inside, listDir, PUBLICATION_ID, type Vault } from "../publications/vault";
import { parseGenerator, parseRelation, splitMessageRef } from "./format";
import { createGraphIndex, migrateGraphIndex, type GeneratorRow, type ReadableMessageRow } from "./index-db";
import type { AuthorizedGraph, GeneratorData, GraphRepository, MessageData, MessageRef, PublicationData, Viewer } from "./types";

export type GraphRepositoryHandle = GraphRepository & { reconcile(): Promise<void>; rebuild(): Promise<void> };

/** Accepted generators (duplicates resolved) and their parents: depends on the index only, shared by every viewer. */
type Structure = { key: string; generators: Map<string, GeneratorRow & { parentId: string | null }>; visible: Map<string, Set<string>> };

const CACHE_SIZE = 200;
const TITLE_LENGTH = 90;

function titleOf(excerpt: string) {
  if (!excerpt) return "Sans titre";
  return excerpt.length > TITLE_LENGTH ? `${excerpt.slice(0, TITLE_LENGTH - 1).trimEnd()}…` : excerpt;
}

/**
 * First folder (binary path order) wins on duplicate id or slug. Parent: nearest accepted generator whose slug is a
 * dotted prefix, so a missing intermediate level attaches the child to the next existing ancestor.
 */
export function resolveGenerators(rows: GeneratorRow[]) {
  const ids = new Map<string, GeneratorRow>();
  const slugs = new Map<string, string>();
  for (const row of [...rows].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    if (ids.has(row.id) || slugs.has(row.slug)) continue;
    ids.set(row.id, row);
    slugs.set(row.slug, row.id);
  }
  const result = new Map<string, GeneratorRow & { parentId: string | null }>();
  for (const row of ids.values()) {
    const parts = row.slug.split(".");
    let parentId: string | null = null;
    for (let length = parts.length - 1; length > 0 && !parentId; length--) parentId = slugs.get(parts.slice(0, length).join(".")) ?? null;
    result.set(row.id, { ...row, parentId });
  }
  return result;
}

export function createGraphRepository({ vault, db, publications }: { vault: Vault; db: Database.Database; publications: PublicationStore }): GraphRepositoryHandle {
  const index = createGraphIndex(db);
  const generatorsDir = inside(vault.root, "generators");
  const relationsDir = inside(vault.root, "relations");
  // Files that failed to parse, by vault-relative path → mtime: not re-read until they change.
  const invalid = new Map<string, number>();
  let structure: Structure | null = null;
  const graphs = new Map<string, { key: string; graph: AuthorizedGraph }>();

  /**
   * mtime of a regular file reached without any symlink (its real path is the path itself); null when missing, not a
   * file, or resolving elsewhere, even inside the vault: generators/ and relations/ only hold what is really there.
   */
  async function vaultFileMtime(path: string) {
    try {
      const real = await assertWithin(vault.root, path);
      if (real !== path) return null;
      const info = await stat(real);
      return info.isFile() ? { real, mtime: info.mtimeMs } : null;
    } catch {
      return null;
    }
  }

  async function scan<T>(
    entries: { path: string; file: string }[], known: (path: string) => number | undefined, all: () => { path: string }[],
    parse: (content: string) => T | null, upsert: (path: string, value: T, mtime: number) => void, remove: (path: string) => void, prefix: string,
  ) {
    const seen = new Set<string>();
    // Stats run in bounded parallel batches: a sequential realpath + stat per file dominated large vaults.
    const stats: Awaited<ReturnType<typeof vaultFileMtime>>[] = [];
    for (let i = 0; i < entries.length; i += 64) {
      stats.push(...await Promise.all(entries.slice(i, i + 64).map(({ file }) => vaultFileMtime(file))));
    }
    for (const [i, { path }] of entries.entries()) {
      const found = stats[i];
      if (!found) continue;
      seen.add(path);
      if (known(path) === found.mtime || invalid.get(path) === found.mtime) continue;
      const value = await readFile(found.real, "utf8").then(parse, () => null);
      if (value === null) {
        invalid.set(path, found.mtime);
        remove(path);
      } else {
        invalid.delete(path);
        upsert(path, value, found.mtime);
      }
    }
    for (const row of all()) if (!seen.has(row.path)) remove(row.path);
    for (const path of invalid.keys()) if (path.startsWith(prefix) && !seen.has(path)) invalid.delete(path);
  }

  // Flat layout only: generators/<folder>/index.md and relations/<file>.md, hidden entries (temporary files) skipped.
  async function entriesOf(dir: string, folder: string, kind: "dir" | "file") {
    // The folder itself must not be a symlink (to another vault folder, e.g. posts/, or outside).
    if (!(await assertWithin(vault.root, dir).then((real) => real === dir, () => false))) return [];
    const result: { path: string; file: string }[] = [];
    for (const entry of await listDir(dir)) {
      if (entry.name.startsWith(".")) continue;
      try {
        if (kind === "dir" && entry.isDirectory()) result.push({ path: `${folder}/${entry.name}`, file: inside(dir, entry.name, "index.md") });
        if (kind === "file" && entry.isFile() && entry.name.endsWith(".md")) result.push({ path: `${folder}/${entry.name}`, file: inside(dir, entry.name) });
      } catch { /* Names that are not valid path segments are not vault notes Xi can address. */ }
    }
    return result;
  }

  async function runReconcile() {
    await publications.reconcileAll();
    await scan(
      await entriesOf(generatorsDir, "generators", "dir"), (path) => index.generatorByPath(path)?.index_mtime, index.generators, parseGenerator,
      (path, { generator }, mtime) => index.upsertGenerator({
        path, id: generator.id, slug: generator.slug, title: generator.title, owner_id: generator.ownerId, visibility: generator.visibility,
        created_at: generator.createdAt, index_mtime: mtime,
      }),
      index.removeGenerator, "generators/",
    );
    await scan(
      await entriesOf(relationsDir, "relations", "file"), (path) => index.relationByPath(path)?.index_mtime, index.relations, parseRelation,
      (path, { relation }, mtime) => {
        const source = splitMessageRef(relation.source)!;
        const target = splitMessageRef(relation.target)!;
        index.upsertRelation({
          path, id: relation.id, type: relation.type, source_publication: source.publicationId, source_n: source.n,
          target_publication: target.publicationId, target_n: target.n, status: relation.status, needs_review: relation.needsReview ? 1 : 0,
          origin: relation.origin, created_by: relation.createdBy, created_at: relation.createdAt, index_mtime: mtime,
        });
      },
      index.removeRelation, "relations/",
    );
  }

  // One reconciliation at a time; callers arriving during a run share the next one (it starts after their call).
  let chain: Promise<void> = Promise.resolve();
  let pending: Promise<void> | null = null;
  const enqueue = (task: () => Promise<void>) => (chain = chain.catch(() => undefined).then(task));
  function reconcile() {
    pending ??= enqueue(async () => {
      pending = null;
      await runReconcile();
    });
    return pending;
  }

  function rebuild() {
    return enqueue(async () => {
      // One transaction: other connections see the old tables or the new empty ones, never missing tables.
      db.transaction(() => {
        dropIndexTables(db);
        migrateGraphIndex(db);
      })();
      invalid.clear();
      structure = null;
      graphs.clear();
      await runReconcile();
    });
  }

  function currentStructure() {
    const key = indexGeneration(db);
    if (structure?.key !== key) {
      structure = { key, generators: resolveGenerators(index.generators()), visible: new Map() };
      graphs.clear();
    }
    return structure;
  }

  /** Effective visibility: readable (owner, or public) and every ancestor visible too. */
  function visibleGenerators(model: Structure, userId: string) {
    let visible = model.visible.get(userId);
    if (visible) return visible;
    visible = new Set();
    const bySlugDepth = [...model.generators.values()].sort((a, b) => a.slug.split(".").length - b.slug.split(".").length);
    for (const generator of bySlugDepth) {
      const readable = generator.owner_id === userId || generator.visibility === "public";
      if (readable && (!generator.parentId || visible.has(generator.parentId))) visible.add(generator.id);
    }
    model.visible.set(userId, visible);
    return visible;
  }

  async function authorizedGraph(viewer: Viewer): Promise<AuthorizedGraph> {
    await reconcile();
    const model = currentStructure();
    const hit = graphs.get(viewer.id);
    if (hit?.key === model.key) return copy(hit.graph);
    const visible = visibleGenerators(model, viewer.id);
    const generators: GeneratorData[] = [...model.generators.values()]
      .filter((generator) => visible.has(generator.id))
      .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
      .map(({ id, slug, title, parentId }) => ({ id, slug, title, parentId }));
    const publicationsData: PublicationData[] = index.readablePublications(viewer.id).map((row) => {
      // belongs_to only counts when the author may read the generator, and the viewer too (else it would leak).
      const generatorId = row.generator_id && visible.has(row.generator_id) && visibleGenerators(model, row.author_id).has(row.generator_id)
        ? row.generator_id : null;
      return { id: row.id, generatorId, title: titleOf(row.excerpt), authorId: row.author_id, type: row.type, date: row.date, messageCount: row.message_count };
    });
    const relations = index.readableRelations(viewer.id).map((row) => ({
      id: row.id, type: row.type, source: `${row.source_publication}/${row.source_n}`, target: `${row.target_publication}/${row.target_n}`,
      sourcePublication: row.source_publication, targetPublication: row.target_publication, needsReview: row.needs_review === 1,
      createdAt: row.created_at,
    }));
    const graph = { generators, publications: publicationsData, relations };
    if (graphs.size >= CACHE_SIZE) graphs.delete(graphs.keys().next().value!);
    graphs.set(viewer.id, { key: model.key, graph });
    return copy(graph);
  }

  // Callers get their own arrays: sorting or filtering them never alters the cached graph.
  const copy = (graph: AuthorizedGraph): AuthorizedGraph => ({
    generators: [...graph.generators], publications: [...graph.publications], relations: [...graph.relations],
  });

  function toMessages(rows: ReadableMessageRow[]): MessageData[] {
    return rows.map((row, i) => ({
      ref: `${row.publication_id}/${row.n}`, publicationId: row.publication_id, position: row.position, excerpt: row.excerpt,
      replyTo: i > 0 ? `${rows[i - 1].publication_id}/${rows[i - 1].n}` : null,
    }));
  }

  async function messages(viewer: Viewer, publicationId: string, options?: ReadOptions) {
    if (!PUBLICATION_ID.test(publicationId)) return null;
    if (!options?.reconciled) await reconcile();
    if (!index.readablePublication(viewer.id, publicationId)) return null;
    return toMessages(index.readableMessages(viewer.id, publicationId));
  }

  async function describeMessages(viewer: Viewer, refs: MessageRef[], options?: ReadOptions) {
    const result = new Map<MessageRef, MessageData>();
    const wanted = new Map<string, Set<MessageRef>>();
    for (const ref of refs) {
      const parts = splitMessageRef(ref);
      if (parts) wanted.set(parts.publicationId, (wanted.get(parts.publicationId) ?? new Set()).add(ref));
    }
    if (!wanted.size) return result;
    if (!options?.reconciled) await reconcile();
    for (const [publicationId, set] of wanted) {
      for (const message of toMessages(index.readableMessages(viewer.id, publicationId))) if (set.has(message.ref)) result.set(message.ref, message);
    }
    return result;
  }

  return { authorizedGraph, messages, describeMessages, reconcile, rebuild };
}
