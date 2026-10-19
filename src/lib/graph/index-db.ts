import type Database from "better-sqlite3";
import { bumpIndexGeneration, migratePublicationIndex, readablePublicationSql } from "../publications/index-db";
import type { Visibility } from "../publications/types";
import type { RelationOrigin, RelationStatus, SemanticType } from "./types";

/**
 * Graph tables of the disposable index. Rows are keyed by vault-relative path, not by id: duplicate ids or slugs
 * are resolved at read time (first path wins), so removing the winner lets the next file take over without a rescan.
 */
export function migrateGraphIndex(db: Database.Database) {
  // Shares the schema version check: a mismatch drops graph tables too.
  migratePublicationIndex(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS graph_generator (
      path TEXT PRIMARY KEY,
      id TEXT NOT NULL,
      slug TEXT NOT NULL,
      title TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      visibility TEXT NOT NULL,
      created_at TEXT,
      index_mtime REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS graph_relation (
      path TEXT PRIMARY KEY,
      id TEXT NOT NULL,
      type TEXT NOT NULL,
      source_publication TEXT NOT NULL,
      source_n INTEGER NOT NULL,
      target_publication TEXT NOT NULL,
      target_n INTEGER NOT NULL,
      status TEXT NOT NULL,
      needs_review INTEGER NOT NULL,
      origin TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      index_mtime REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS graph_relation_id ON graph_relation (id);
    CREATE INDEX IF NOT EXISTS graph_relation_status ON graph_relation (status);
  `);
}

export type GeneratorRow = {
  path: string; id: string; slug: string; title: string; owner_id: string; visibility: Visibility; created_at: string | null; index_mtime: number;
};

export type RelationRow = {
  path: string; id: string; type: SemanticType; source_publication: string; source_n: number; target_publication: string; target_n: number;
  status: RelationStatus; needs_review: 0 | 1; origin: RelationOrigin; created_by: string; created_at: string; index_mtime: number;
};

export type ReadablePublicationRow = {
  id: string; author_id: string; type: "post" | "thread"; date: string; excerpt: string; generator_id: string | null; message_count: number;
};

export type ReadableMessageRow = { publication_id: string; n: number; position: number; excerpt: string };

const sameRow = <T extends object>(a: T | undefined, b: T) =>
  !!a && Object.entries(b).every(([key, value]) => (a as Record<string, unknown>)[key] === value);

export function createGraphIndex(db: Database.Database) {
  migrateGraphIndex(db);
  const upsertGenerator = db.prepare<[GeneratorRow]>(`
    INSERT INTO graph_generator (path, id, slug, title, owner_id, visibility, created_at, index_mtime)
    VALUES (@path, @id, @slug, @title, @owner_id, @visibility, @created_at, @index_mtime)
    ON CONFLICT (path) DO UPDATE SET id = excluded.id, slug = excluded.slug, title = excluded.title, owner_id = excluded.owner_id,
      visibility = excluded.visibility, created_at = excluded.created_at, index_mtime = excluded.index_mtime`);
  const generatorByPath = db.prepare<[string], GeneratorRow>("SELECT * FROM graph_generator WHERE path = ?");
  const generators = db.prepare<[], GeneratorRow>("SELECT * FROM graph_generator ORDER BY path");
  const removeGenerator = db.prepare<[string]>("DELETE FROM graph_generator WHERE path = ?");

  const upsertRelation = db.prepare<[RelationRow]>(`
    INSERT INTO graph_relation (path, id, type, source_publication, source_n, target_publication, target_n, status, needs_review, origin, created_by, created_at, index_mtime)
    VALUES (@path, @id, @type, @source_publication, @source_n, @target_publication, @target_n, @status, @needs_review, @origin, @created_by, @created_at, @index_mtime)
    ON CONFLICT (path) DO UPDATE SET id = excluded.id, type = excluded.type, source_publication = excluded.source_publication,
      source_n = excluded.source_n, target_publication = excluded.target_publication, target_n = excluded.target_n, status = excluded.status,
      needs_review = excluded.needs_review, origin = excluded.origin, created_by = excluded.created_by, created_at = excluded.created_at,
      index_mtime = excluded.index_mtime`);
  const relationByPath = db.prepare<[string], RelationRow>("SELECT * FROM graph_relation WHERE path = ?");
  const relations = db.prepare<[], RelationRow>("SELECT * FROM graph_relation ORDER BY path");
  // Duplicate ids: the first file (path order) is the relation, the others are ignored.
  const relationById = db.prepare<[string], RelationRow>("SELECT * FROM graph_relation WHERE id = ? ORDER BY path LIMIT 1");
  const removeRelation = db.prepare<[string]>("DELETE FROM graph_relation WHERE path = ?");

  const readable = readablePublicationSql("p");
  const readablePublications = db.prepare<[{ viewer: string }], ReadablePublicationRow>(`
    SELECT p.id, p.author_id, p.type, COALESCE(p.published_at, p.updated_at) AS date, p.excerpt, p.generator_id,
      (SELECT COUNT(*) FROM publication_message m WHERE m.publication_id = p.id) AS message_count
    FROM publication p WHERE ${readable}
    ORDER BY date DESC, p.id DESC`);
  const readablePublication = db.prepare<[{ viewer: string; id: string }], ReadablePublicationRow>(`
    SELECT p.id, p.author_id, p.type, COALESCE(p.published_at, p.updated_at) AS date, p.excerpt, p.generator_id,
      (SELECT COUNT(*) FROM publication_message m WHERE m.publication_id = p.id) AS message_count
    FROM publication p WHERE p.id = @id AND ${readable}`);
  const readableMessages = db.prepare<[{ viewer: string; id: string }], ReadableMessageRow>(`
    SELECT m.publication_id, m.n, m.position, m.excerpt FROM publication_message m JOIN publication p ON p.id = m.publication_id
    WHERE m.publication_id = @id AND ${readable} ORDER BY m.position`);
  // Validated relations whose two endpoint messages are indexed and whose two publications the viewer may read.
  const readableRelations = db.prepare<[{ viewer: string }], RelationRow>(`
    SELECT r.* FROM graph_relation r
    JOIN publication_message sm ON sm.publication_id = r.source_publication AND sm.n = r.source_n
    JOIN publication_message tm ON tm.publication_id = r.target_publication AND tm.n = r.target_n
    JOIN publication p ON p.id = r.source_publication
    JOIN publication q ON q.id = r.target_publication
    WHERE r.status = 'validated' AND ${readable} AND ${readablePublicationSql("q")}
      AND r.path = (SELECT MIN(d.path) FROM graph_relation d WHERE d.id = r.id)
    ORDER BY r.created_at DESC, r.id DESC`);

  const changed = <T>(run: () => T) => {
    bumpIndexGeneration(db);
    return run();
  };
  return {
    generators: () => generators.all(),
    generatorByPath: (path: string) => generatorByPath.get(path),
    upsertGenerator: (row: GeneratorRow) => { if (!sameRow(generatorByPath.get(row.path), row)) changed(() => upsertGenerator.run(row)); },
    removeGenerator: (path: string) => { if (removeGenerator.run(path).changes) bumpIndexGeneration(db); },
    relations: () => relations.all(),
    relationByPath: (path: string) => relationByPath.get(path),
    relationById: (id: string) => relationById.get(id),
    upsertRelation: (row: RelationRow) => { if (!sameRow(relationByPath.get(row.path), row)) changed(() => upsertRelation.run(row)); },
    removeRelation: (path: string) => { if (removeRelation.run(path).changes) bumpIndexGeneration(db); },
    readablePublications: (viewer: string) => readablePublications.all({ viewer }),
    readablePublication: (viewer: string, id: string) => readablePublication.get({ viewer, id }),
    readableMessages: (viewer: string, id: string) => readableMessages.all({ viewer, id }),
    readableRelations: (viewer: string) => readableRelations.all({ viewer }),
  };
}

export type GraphIndex = ReturnType<typeof createGraphIndex>;
