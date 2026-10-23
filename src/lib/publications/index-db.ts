import type Database from "better-sqlite3";
import type { PublicationMeta } from "./types";

/**
 * SQLite is a disposable index of the Markdown files (lists, feed, ID → folder, graph).
 * It can be dropped and rebuilt from the vault at any time; it never holds content.
 */

// Bump whenever an index table changes shape: every index table is then dropped and rebuilt from the vault.
export const INDEX_SCHEMA_VERSION = "5";
const INDEX_TABLES = ["publication_message", "publication", "graph_generator", "graph_relation", "feed_follow", "feed_managed_agent"];

/** Drops every derived table (never Better Auth's): the next reconciliation rebuilds them from the vault. */
export function dropIndexTables(db: Database.Database) {
  db.transaction(() => {
    for (const table of INDEX_TABLES) db.exec(`DROP TABLE IF EXISTS ${table}`);
    db.exec("DELETE FROM xi_index_meta WHERE key = 'schema_version'");
  })();
  bumpIndexGeneration(db);
}

function checkSchemaVersion(db: Database.Database) {
  db.exec("CREATE TABLE IF NOT EXISTS xi_index_meta (key TEXT PRIMARY KEY, value TEXT)");
  const row = db.prepare<[], { value: string }>("SELECT value FROM xi_index_meta WHERE key = 'schema_version'").get();
  if (row?.value === INDEX_SCHEMA_VERSION) return;
  db.transaction(() => {
    for (const table of INDEX_TABLES) db.exec(`DROP TABLE IF EXISTS ${table}`);
    db.prepare("INSERT INTO xi_index_meta (key, value) VALUES ('schema_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .run(INDEX_SCHEMA_VERSION);
  })();
  bumpIndexGeneration(db);
}

// In-process change counter of the index, used to memoize derived views (graph). Other connections are
// covered by PRAGMA data_version, which changes when another connection commits.
const generations = new WeakMap<Database.Database, number>();
export function bumpIndexGeneration(db: Database.Database) {
  generations.set(db, (generations.get(db) ?? 0) + 1);
}
export function indexGeneration(db: Database.Database) {
  return `${generations.get(db) ?? 0}:${db.pragma("data_version", { simple: true }) as number}`;
}

export function migratePublicationIndex(db: Database.Database) {
  checkSchemaVersion(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS feed_managed_agent (viewer_id TEXT NOT NULL, author_id TEXT NOT NULL, PRIMARY KEY (viewer_id, author_id));
    CREATE TABLE IF NOT EXISTS feed_follow (viewer_id TEXT NOT NULL, author_id TEXT NOT NULL, PRIMARY KEY (viewer_id, author_id));
    CREATE TABLE IF NOT EXISTS publication (
      id TEXT PRIMARY KEY,
      author_type TEXT NOT NULL,
      author_id TEXT NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      visibility TEXT NOT NULL,
      path TEXT NOT NULL,
      original_path TEXT,
      trashed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      published_at TEXT,
      score REAL,
      excerpt TEXT NOT NULL DEFAULT '',
      generator_id TEXT,
      reply_to TEXT,
      revision TEXT NOT NULL DEFAULT '',
      index_mtime REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS publication_author ON publication (author_id, trashed_at);
    CREATE INDEX IF NOT EXISTS publication_feed ON publication (status, visibility, trashed_at, published_at);
    -- Messages in thread order; n is the number of the file {n}_{slug}.md, the stable part of a message ref.
    CREATE TABLE IF NOT EXISTS publication_message (
      publication_id TEXT NOT NULL,
      n INTEGER NOT NULL,
      file TEXT NOT NULL,
      position INTEGER NOT NULL,
      excerpt TEXT NOT NULL DEFAULT '',
      reply_to TEXT,
      created_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT '',
      deleted INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (publication_id, n)
    );
    CREATE INDEX IF NOT EXISTS message_parent_chronology ON publication_message(reply_to, created_at, publication_id, n);
  `);
}

/**
 * SQL equivalent of canRead (permissions.ts) for a publication row aliased `alias`, viewer bound as @viewer.
 * Kept next to the schema so every graph query shares one definition (tested against canRead).
 */
export function readablePublicationSql(alias: string) {
  return `(${alias}.trashed_at IS NULL AND ((${alias}.author_type = 'human' AND ${alias}.author_id = @viewer)
    OR (${alias}.author_type = 'ai' AND EXISTS (SELECT 1 FROM feed_managed_agent a WHERE a.viewer_id = @viewer AND a.author_id = ${alias}.author_id))
    OR (${alias}.status = 'published' AND (${alias}.visibility = 'public' OR (${alias}.visibility = 'followers' AND EXISTS (SELECT 1 FROM feed_follow f WHERE f.viewer_id = @viewer AND f.author_id = ${alias}.author_id))))))`;
}

export type IndexRow = {
  id: string; author_type: PublicationMeta["authorType"]; author_id: string; type: PublicationMeta["type"];
  status: PublicationMeta["status"]; visibility: PublicationMeta["visibility"]; path: string; original_path: string | null;
  trashed_at: string | null; created_at: string; updated_at: string; published_at: string | null; score: number | null;
  excerpt: string; generator_id: string | null; reply_to?: string | null; revision?: string; index_mtime: number;
};

export type MessageRow = { publication_id: string; n: number; file: string; position: number; excerpt: string; reply_to?: string | null; created_at?: string; updated_at?: string; deleted?: number };

export type PageQuery = { viewer: string; drafts: 0 | 1; author: string | null; before: string | null; beforeId: string | null; limit: number };

const sameRows = <T extends object>(a: T[], b: T[]) =>
  a.length === b.length && a.every((row, i) => Object.entries(row).every(([key, value]) => (b[i] as Record<string, unknown>)[key] === value));

export function createIndex(db: Database.Database) {
  migratePublicationIndex(db);
  const upsert = db.prepare(`
    INSERT INTO publication (id, author_type, author_id, type, status, visibility, path, original_path, trashed_at, created_at, updated_at, published_at, score, excerpt, generator_id, reply_to, revision, index_mtime)
    VALUES (@id, @author_type, @author_id, @type, @status, @visibility, @path, @original_path, @trashed_at, @created_at, @updated_at, @published_at, @score, @excerpt, @generator_id, @reply_to, @revision, @index_mtime)
    ON CONFLICT (id) DO UPDATE SET author_type = excluded.author_type, author_id = excluded.author_id, type = excluded.type,
      status = excluded.status, visibility = excluded.visibility, path = excluded.path, original_path = excluded.original_path,
      trashed_at = excluded.trashed_at, created_at = excluded.created_at, updated_at = excluded.updated_at,
      published_at = excluded.published_at, score = excluded.score, excerpt = excluded.excerpt, generator_id = excluded.generator_id, reply_to = excluded.reply_to,
      revision = excluded.revision, index_mtime = excluded.index_mtime`);
  const byId = db.prepare<[string], IndexRow>("SELECT * FROM publication WHERE id = ?");
  const byAuthor = db.prepare<[string], IndexRow>("SELECT * FROM publication WHERE author_id = ?");
  const allRows = db.prepare<[], IndexRow>("SELECT * FROM publication");
  const remove = db.prepare<[string]>("DELETE FROM publication WHERE id = ?");
  const messagesOf = db.prepare<[string], MessageRow>("SELECT * FROM publication_message WHERE publication_id = ? ORDER BY position");
  const removeMessages = db.prepare<[string]>("DELETE FROM publication_message WHERE publication_id = ?");
  const insertMessage = db.prepare<[MessageRow]>(
    "INSERT INTO publication_message (publication_id, n, file, position, excerpt, reply_to, created_at, updated_at, deleted) VALUES (@publication_id, @n, @file, @position, @excerpt, @reply_to, @created_at, @updated_at, @deleted)");
  // Unchanged rows are not rewritten, so the generation only moves on real changes (trash entries are re-read each time).
  const write = db.transaction((row: IndexRow, messages: MessageRow[]) => {
    const existing = byId.get(row.id);
    const normalizedRow = {...row, reply_to: row.reply_to ?? null, revision:row.revision ?? ""};
    const normalizedMessages = messages.map(message => ({reply_to:null,created_at:row.created_at,updated_at:row.created_at,deleted:0,...message}));
    if (existing && sameRows([existing], [normalizedRow]) && sameRows(messagesOf.all(row.id), normalizedMessages)) return;
    upsert.run(normalizedRow);
    removeMessages.run(row.id);
    for (const message of messages) insertMessage.run({ reply_to: null, created_at: row.created_at, updated_at: row.created_at, deleted: 0, ...message });
    bumpIndexGeneration(db);
  });
  const drop = db.transaction((id: string) => {
    removeMessages.run(id);
    if (remove.run(id).changes) bumpIndexGeneration(db);
  });
  // Keyset pagination on (sort date, id): stable while publications are added.
  const page = db.prepare<[PageQuery], IndexRow>(`
    SELECT * FROM publication
    WHERE trashed_at IS NULL
      AND (author_id = @viewer OR (status = 'published' AND visibility = 'public' AND author_type = 'human'))
      AND (status = 'published' OR (@drafts = 1 AND author_id = @viewer))
      AND (@author IS NULL OR author_id = @author)
      AND (@before IS NULL OR COALESCE(published_at, updated_at) < @before OR (COALESCE(published_at, updated_at) = @before AND id < @beforeId))
    ORDER BY COALESCE(published_at, updated_at) DESC, id DESC
    LIMIT @limit`);
  const trash = db.prepare<[string], IndexRow>("SELECT * FROM publication WHERE author_id = ? AND trashed_at IS NOT NULL ORDER BY trashed_at DESC");
  return {
    upsert: (row: IndexRow, messages: MessageRow[]) => write(row, messages),
    get: (id: string) => byId.get(id),
    byAuthor: (authorId: string) => byAuthor.all(authorId),
    all: () => allRows.all(),
    remove: (id: string) => drop(id),
    messages: (id: string) => messagesOf.all(id),
    page: (query: PageQuery) => page.all(query),
    trash: (authorId: string) => trash.all(authorId),
  };
}

export type PublicationIndex = ReturnType<typeof createIndex>;
