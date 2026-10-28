import { labelTestMessage } from "./test-content";
import { locked } from "../topics/lock";
import { parseMessage } from "./message-metadata";
import { threadNumbers } from "./conversation";
import { effectiveSocial, readGenerators, readSocial, writeSocial, PREFERENCES, type Preference } from "./social";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type Database from "better-sqlite3";
import { Document, parseDocument } from "yaml";
import { z } from "zod";
import { bumpIndexGeneration, indexGeneration, readablePublicationSql, createIndex, type IndexRow, type MessageRow, type SearchRow } from "./index-db";
import { ftsDocument, ftsQuery } from "../search/text";
import {
  excerpt, hasContent, messageEmbedTarget, plainText, messageSlug, parseIndex, parseSource, rewriteFolderLinks, serializeIndex,
  serializeSource, setMeta, slugify, sourceLinkLine, splitIndexBody, splitFrontmatter, splitSourcesSection, type SourceInput,
} from "./markdown";
import { canEdit, canManageTrash, canRead } from "./permissions";
import {
  VISIBILITIES, type PublicationMeta, type PublicationSnapshot, type TrashItem, type Viewer, type ConversationEntry, type ConversationPage,
} from "./types";
import {
  assertInVault, assertWithin, exists, FOLDER_NAME, fromVaultRelative, inside, listDir, NUMBERED_FILE, PUBLICATION_ID, readMarkdownTree,
  toVaultRelative, USER_ID, writeAtomic, type Vault,
} from "./vault";

export class PublicationError extends Error {
  constructor(readonly code: "not_found" | "invalid" | "stale_cursor" | "rate_limited", message: string) {
    super(message);
  }
}

// Unreadable and nonexistent publications are indistinguishable to callers.
const notFound = () => new PublicationError("not_found", "Publication introuvable.");
/** Marks drafts written by the watch engine; fixtures use `manual-fixture-v1` and `test_content`. */
export const WATCH_DRAFT = "watch-draft-v1";
const SOURCES_HEADING = /^#{1,6}\s*sources\s*$/im;
const invalid = (message: string) => new PublicationError("invalid", message);

const saveSchema = z.object({
  baseRevision: z.string().regex(/^[0-9a-f]{64}$/),
  summary: z.string().max(20_000),
  visibility: z.enum(VISIBILITIES),
  messages: z.array(z.object({
    key: z.string().min(1).max(64),
    file: z.string().regex(NUMBERED_FILE).nullable(),
    body: z.string().max(100_000),
  })).max(50),
});
export type SaveInput = z.input<typeof saveSchema>;

const line = z.string().trim().min(1).max(1_000).transform((value) => value.replace(/\s+/g, " "));
const sourceSchema = z.object({
  url: z.string().trim().max(2_000).refine((value) => {
    try { return ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; }
  }, "Une source doit indiquer son URL http(s) d’origine."),
  title: line.pipe(z.string().max(300)),
  publisher: line.pipe(z.string().max(200)),
  publishedAt: z.string().trim().regex(/^\d{4}(-\d{2}(-\d{2})?)?$/).optional().or(z.literal("").transform(() => undefined)),
  facts: z.array(line).min(1).max(30),
  reservations: z.array(line).max(30),
});
export type SourceFormInput = z.input<typeof sourceSchema>;

export type SaveResult =
  | { ok: true; snapshot: PublicationSnapshot; files: Record<string, string>; relocated: { from: string; to: string } | null }
  | { ok: false; conflict: PublicationSnapshot };

type Folder = {
  dir: string;
  doc: Document;
  meta: PublicationMeta;
  generatorId: string | null;
  summary: string;
  messages: PublicationSnapshot["messages"];
  sources: PublicationSnapshot["sources"];
  numbered: string[];
  revision: string;
  indexMtime: number;
};

type TrashInfo = { id: string; folder: string; originalPath: string; trashedAt: string };

/**
 * `search`: published, readable publications whose text contains every term (ranked by relevance) and/or that
 * declare every topic of `topicIds` (immutable UUIDs). A crossed topic search is a co-occurrence, not a relation.
 */
export type FeedScope = { kind: "home"; tab?: "for-you" | "following" } | { kind: "own" } | { kind: "author"; authorId: string } | { kind: "conversation"; publicationId: string }
  | { kind: "search"; text?: string; topicIds?: string[]; origin?: "declared" | "inferred" };
const TOPIC_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export type FeedPage = { items: PublicationSnapshot[]; nextCursor: string | null };

/**
 * Re-parse gate of a live folder: index.md's mtime, or the folder's own when later. The folder's mtime moves when a
 * file is created, deleted or renamed in it (a message file removed in Obsidian, every atomic write), so a deleted
 * message never lingers in the index (and in the graph) while index.md is untouched.
 */
async function folderMtime(dir: string) {
  const [index, folder] = await Promise.all([stat(inside(dir, "index.md")), stat(dir)]);
  const entries = await listDir(dir);
  const messageTimes = await Promise.all(entries.filter(entry => NUMBERED_FILE.test(entry.name)).map(entry => stat(inside(dir, entry.name)).then(info => info.mtimeMs, () => 0)));
  return Math.max(index.mtimeMs, folder.mtimeMs, ...messageTimes);
}

const byNumber = (a: string, b: string) => parseInt(a, 10) - parseInt(b, 10) || a.localeCompare(b);
const maxNumber = (files: string[]) => Math.max(0, ...files.map((file) => parseInt(file, 10)));

export function createPublicationStore({ vault, db, now = () => new Date() }: { vault: Vault; db: Database.Database; now?: () => Date }) {
  const index = createIndex(db);
  const usersDir = inside(vault.postsDir, "_users");
  const generatorsDir = inside(vault.postsDir, "_generators");
  const trashDir = inside(vault.postsDir, ".trash");
  const locks = new Map<string, Promise<unknown>>();
  let indexedAt = 0;
  let indexing: Promise<void> | undefined;
  const rel = (path: string) => toVaultRelative(vault, path);

  /** Serializes writers of one publication (or one user's folder allocation) within this process. */
  function withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
    const run = (locks.get(key) ?? Promise.resolve()).then(task);
    const tail = run.catch(() => undefined);
    locks.set(key, tail);
    void tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
    return run;
  }

  function userDir(userId: string) {
    if (!USER_ID.test(userId)) throw invalid("Utilisateur invalide.");
    return inside(usersDir, userId);
  }

  async function readFolder(dir: string): Promise<Folder | null> {
    let indexMtime: number;
    let tree: Awaited<ReturnType<typeof readMarkdownTree>>;
    try {
      await assertInVault(vault, dir);
      indexMtime = await folderMtime(dir);
      tree = await readMarkdownTree(dir);
    } catch {
      return null;
    }
    const indexText = tree.files.get("index.md");
    if (indexText === undefined) return null;
    const parsed = parseIndex(indexText);
    if (!parsed.meta) return null;
    const numbered = [...tree.files.keys()].filter((name) => NUMBERED_FILE.test(name));
    const { summary, order } = splitIndexBody(parsed.body, (file) => numbered.includes(file));
    const sources = [...tree.files.keys()]
      .filter((name) => name.startsWith("_sources/") && NUMBERED_FILE.test(name.slice(9)))
      .map((name) => name.slice(9)).sort(byNumber)
      .map((file) => {
        const source = parseSource(tree.files.get(`_sources/${file}`)!);
        return { ...source, file, title: source.title ?? file.replace(/\.md$/, "") };
      });
    return {
      dir, doc: parsed.doc, meta: parsed.meta, generatorId: parsed.generatorId, summary, sources, numbered, revision: tree.revision, indexMtime,
      messages: order.map((file, i) => {
        const message = parseMessage(file, tree.files.get(file)!);
        const reply = parsed.doc.get("reply_to");
        if (i === 0 && !message.replyTo && typeof reply === "string" && /^[0-9a-f-]{36}\/\d+$/.test(reply)) message.replyTo = reply;
        return message;
      }),
    };
  }

  // A folder only counts if its location and its frontmatter agree on the author.
  function owned(folder: Folder | null, userId: string, id?: string): folder is Folder {
    return !!folder && folder.meta.authorId === userId && (!id || folder.meta.id === id);
  }

  function toRow(folder: Folder, trash?: TrashInfo): IndexRow {
    const { meta } = folder;
    return {
      id: meta.id, author_type: meta.authorType, author_id: meta.authorId, type: meta.type, status: meta.status,
      visibility: meta.visibility, path: rel(folder.dir), original_path: trash?.originalPath ?? null,
      trashed_at: trash?.trashedAt ?? null, created_at: meta.createdAt, updated_at: meta.updatedAt,
      published_at: meta.publishedAt, score: meta.score, excerpt: excerpt(folder.summary || folder.messages[0]?.body || ""),
      revision:folder.revision, generator_id: folder.generatorId, test_content: folder.doc.get("test_content") === true ? 1 : 0, reply_to: folder.messages[0]?.replyTo ?? null, index_mtime: folder.indexMtime,
    };
  }

  /** Searchable text (summary + live messages) and the topics the publication declares in its frontmatter. */
  function searchRow(folder: Folder): SearchRow {
    const raw = folder.doc.toJS() as Record<string, unknown>;
    const primary = typeof raw.primary_topic === "string" && TOPIC_ID.test(raw.primary_topic) ? raw.primary_topic : null;
    const declared = Array.isArray(raw.topics) ? raw.topics.filter((id): id is string => typeof id === "string" && TOPIC_ID.test(id)) : [];
    const topics = [...new Set([...(primary ? [primary] : []), ...declared])].map(topic_id => ({ topic_id, role: topic_id === primary ? "primary" as const : "secondary" as const }));
    return { text: ftsDocument([folder.summary, ...folder.messages.map(message => message.body)].map(plainText).join("\n")), topics };
  }

  function indexFolder(folder: Folder, trash?: TrashInfo) {
    index.upsert(toRow(folder, trash), messageRows(folder), searchRow(folder));
  }

  /** Thread order gives positions; a number used twice (external edit) keeps its first message only, refs stay unambiguous. */
  function messageRows(folder: Folder): MessageRow[] {
    const rows: MessageRow[] = [];
    const used = new Set<number>();
    for (const message of folder.messages) {
      const n = parseInt(message.file, 10);
      if (used.has(n)) continue;
      used.add(n);
      rows.push({ publication_id: folder.meta.id, n, file: message.file, position: rows.length + 1, excerpt: excerpt(message.body), reply_to: message.replyTo ?? (folder.doc.get("thread_continuation") === true && rows.length ? `${folder.meta.id}/${rows[rows.length - 1].n}` : null), created_at: message.createdAt ?? folder.meta.createdAt, updated_at: message.updatedAt ?? message.createdAt ?? folder.meta.createdAt, deleted: 0 });
    }
    const deleted = (folder.doc.toJS() as Record<string, unknown>).deleted_messages;
    if (Array.isArray(deleted)) for (const item of deleted) {
      if (!Number.isSafeInteger(item?.n) || item.n < 1 || used.has(item.n)) continue;
      used.add(item.n);
      rows.push({ publication_id: folder.meta.id, n: item.n, file: `${item.n}_deleted.md`, position: Number.isSafeInteger(item.position) ? item.position : rows.length + 1, excerpt: "", reply_to: typeof item.reply_to === "string" ? item.reply_to : null, created_at: typeof item.created_at === "string" ? item.created_at : folder.meta.createdAt, updated_at: folder.meta.updatedAt, deleted: 1 });
    }
    return rows;
  }

  async function readTrashInfo(userId: string, id: string): Promise<TrashInfo | null> {
    try {
      const info = JSON.parse(await readFile(inside(trashDir, userId, id, "trash.json"), "utf8")) as Record<string, unknown>;
      if (info.id !== id || typeof info.folder !== "string" || !FOLDER_NAME.test(info.folder)) return null;
      if (typeof info.originalPath !== "string" || typeof info.trashedAt !== "string") return null;
      return info as TrashInfo;
    } catch {
      return null;
    }
  }

  /**
   * Brings the index in line with one user's files: external edits, Obsidian moves/renames, deletions.
   * index.md's mtime gates re-parsing; content is always read from files when served.
   */
  async function reconcileUser(userId: string) {
    if (!USER_ID.test(userId)) return;
    const seen = new Set<string>();
    const known = new Map(index.byAuthor(userId).map((row) => [row.path, row]));
    const accept = (folder: Folder, trash?: TrashInfo) => {
      const existing = index.get(folder.meta.id);
      if (seen.has(folder.meta.id) || (existing && existing.author_id !== userId)) return;
      seen.add(folder.meta.id);
      indexFolder(folder, trash);
    };
    const live = index.byAuthor(userId).some(row => row.author_type === "ai") || await exists(inside(generatorsDir, userId)) ? inside(generatorsDir, userId) : userDir(userId);
    for (const entry of await listDir(live)) {
      if (!entry.isDirectory() || !FOLDER_NAME.test(entry.name)) continue;
      const dir = inside(live, entry.name);
      const mtime = await folderMtime(dir).catch(() => null);
      if (mtime === null) continue;
      const row = known.get(rel(dir));
      if (row && !row.trashed_at && row.index_mtime === mtime && !seen.has(row.id)) {
        seen.add(row.id);
        continue;
      }
      const folder = await readFolder(dir);
      if (owned(folder, userId) && folder.meta.authorType === (live.startsWith(generatorsDir + "/") ? "ai" : "human")) accept(folder);
    }
    for (const entry of await listDir(inside(trashDir, userId))) {
      if (!entry.isDirectory() || !PUBLICATION_ID.test(entry.name)) continue;
      const info = await readTrashInfo(userId, entry.name);
      if (!info) continue;
      const folder = await readFolder(inside(trashDir, userId, entry.name, info.folder));
      if (owned(folder, userId, entry.name)) accept(folder, info);
    }
    for (const row of index.byAuthor(userId)) if (!seen.has(row.id)) index.remove(row.id);
  }

  async function reconcileAll() {
    const users = new Set(index.all().map((row) => row.author_id));
    for (const base of [usersDir, generatorsDir, trashDir]) {
      for (const entry of await listDir(base)) if (entry.isDirectory() && USER_ID.test(entry.name)) users.add(entry.name);
    }
    for (const userId of users) await reconcileUser(userId);
    const insert = db.prepare("INSERT OR IGNORE INTO feed_follow (viewer_id, author_id) VALUES (?, ?)");
    const settings = await Promise.all([...users].map(async id => ({ id, effective: effectiveSocial(await readSocial(vault, {id}), await readGenerators(vault, {id})) })));
    db.transaction(() => {
      const old = JSON.stringify(db.prepare("SELECT * FROM feed_follow ORDER BY viewer_id, author_id").all());
      db.exec("DELETE FROM feed_follow");
      for (const { id, effective } of settings) for (const author of effective.following) insert.run(id, author);
      if (old !== JSON.stringify(db.prepare("SELECT * FROM feed_follow ORDER BY viewer_id, author_id").all())) bumpIndexGeneration(db);
    })();
    indexedAt = Date.now();
  }

  async function ensureIndexed() {
    if (indexedAt && Date.now() - indexedAt < 60_000) return;
    if (!indexing) indexing = reconcileAll().finally(() => { indexing = undefined; });
    await indexing;
  }

  /** Watcher entry point. Re-read only the affected publication, including in-place message edits. */
  async function invalidatePath(path: string) {
    const relative = path.startsWith(vault.root + "/") ? rel(path) : path;
    const row = index.all().find(item => relative === item.path || relative.startsWith(item.path + "/"));
    if (row) {
      const folder = await readFolder(fromVaultRelative(vault, row.path));
      if (folder && owned(folder, row.author_id, row.id)) indexFolder(folder, row.trashed_at ? {id: row.id, folder: basename(row.path), originalPath: row.original_path!, trashedAt: row.trashed_at} : undefined);
      else await reconcileUser(row.author_id);
    } else {
      // New directories, moves and social settings can change the indexed perimeter.
      indexedAt = 0;
      await ensureIndexed();
      bumpIndexGeneration(db);
    }
  }

  async function locate(id: string) {
    if (!PUBLICATION_ID.test(id)) throw notFound();
    const row = index.get(id);
    if (!row) await ensureIndexed();
    const current = index.get(id);
    if (!current) throw notFound();
    return current;
  }

  async function loadLive(id: string) {
    let row = await locate(id);
    if (row.trashed_at) throw notFound();
    let folder = await readFolder(fromVaultRelative(vault, row.path));
    if (!folder) {
      await reconcileUser(row.author_id);
      row = index.get(id)!;
      if (!row || row.trashed_at) throw notFound();
      folder = await readFolder(fromVaultRelative(vault, row.path));
    }
    if (!owned(folder, row.author_id, id)) throw notFound();
    return folder;
  }

  async function loadEditable(viewer: Viewer, id: string) {
    const folder = await loadLive(id);
    if (!canEdit(viewer, folder.meta)) throw notFound();
    return folder;
  }

  function snapshot(folder: Folder): PublicationSnapshot {
    return { ...folder.meta, summary: folder.summary, messages: folder.messages, sources: folder.sources, revision: folder.revision, analysis: folder.doc.get("analysis") === true };
  }

  async function writeIndex(folder: Folder, meta: PublicationMeta, summary: string, order: string[]) {
    setMeta(folder.doc, meta);
    const folderPath = rel(folder.dir);
    await writeAtomic(inside(folder.dir, "index.md"), serializeIndex(folder.doc, summary, order.map((file) => messageEmbedTarget(folderPath, file))));
  }

  async function reindex(dir: string, trash?: TrashInfo) {
    const folder = await readFolder(dir);
    if (!folder) throw invalid("La publication n’a pas pu être relue.");
    indexFolder(folder, trash);
    return folder;
  }

  /** Moves a folder, then repoints the vault-relative links its own notes hold (embeds, sources). */
  async function relocate(from: string, to: string, linksFrom: string) {
    await rename(from, to);
    const linksTo = rel(to);
    if (linksFrom === linksTo) return;
    for (const [name, content] of (await readMarkdownTree(to)).files) {
      const updated = rewriteFolderLinks(content, linksFrom, linksTo);
      if (updated !== content) await writeAtomic(inside(to, ...name.split("/")), updated);
    }
  }

  async function nextSequence(userId: string, date: string) {
    const names = (await listDir(userDir(userId))).map((entry) => entry.name);
    for (const entry of await listDir(inside(trashDir, userId))) {
      if (entry.isDirectory() && PUBLICATION_ID.test(entry.name)) {
        names.push(...(await listDir(inside(trashDir, userId, entry.name))).map((child) => child.name));
      }
    }
    const used = names.map((name) => FOLDER_NAME.exec(name)).filter((match) => match?.[2] === date).map((match) => Number(match![3]));
    return String(Math.max(0, ...used) + 1).padStart(3, "0");
  }

  const stamp = (date: Date) => date.toISOString().slice(0, 10).replaceAll("-", "");

  async function create(viewer: Viewer, replyTo?: string) {
    if (replyTo !== undefined) {
      const match = /^([0-9a-f-]{36})\/(\d+)$/.exec(replyTo);
      if (!match) throw invalid("Message parent invalide.");
      const parent = await get(viewer, match[1]);
      if (!parent.messages.some(message => parseInt(message.file, 10) === Number(match[2]))) throw notFound();
    }
    const live = userDir(viewer.id);
    await mkdir(live, { recursive: true, mode: 0o700 });
    await assertInVault(vault, live);
    return withLock(`user:${viewer.id}`, async () => {
      const date = now();
      const dir = inside(live, `post_${stamp(date)}_${await nextSequence(viewer.id, stamp(date))}`);
      await mkdir(dir, { mode: 0o700 });
      const at = date.toISOString();
      const meta: PublicationMeta = {
        id: randomUUID(), type: "post", authorType: "human", authorId: viewer.id, status: "draft", visibility: "private",
        createdAt: at, updatedAt: at, publishedAt: null, score: null,
      };
      const doc = new Document({});
      setMeta(doc, meta);
      if (replyTo) doc.set("reply_to", replyTo);
      await writeAtomic(inside(dir, "index.md"), serializeIndex(doc, "", []));
      return (await reindex(dir)).meta.id;
    });
  }

  /** Indexed publications of an agent; fixtures (`test`) never count toward real publication quotas. Call ensureIndexed first. */
  function agentPublications(agentId: string) {
    return index.byAuthor(agentId).filter(row => row.author_type === "ai" && row.status === "published" && !row.trashed_at && row.published_at)
      .map(row => ({ id: row.id, publishedAt: new Date(row.published_at!), test: row.test_content === 1, excerpt: row.excerpt }));
  }

  async function ownsAgent(owner: string, agentId: string) {
    return (await readGenerators(vault, { id: owner })).some(agent => agent.id === agentId && agent.ownerId === owner);
  }

  /**
   * Agent folders are written by the web server (fixtures, reviews) and the watch worker (drafts):
   * the in-process locks order local callers, the SQLite lock (outside the watched `posts/`)
   * serializes processes, and the disk rescan then sees folders another process created
   * (idempotency by id, sequence numbers).
   */
  async function agentLock<T>(id: string, agentId: string, task: () => Promise<T>) {
    const lockDir = inside(vault.root, ".xi-locks");
    await mkdir(lockDir, { recursive: true, mode: 0o700 });
    if (await assertWithin(vault.root, lockDir) !== lockDir) throw invalid("Dossier de verrou invalide.");
    return withLock(`generated-publication:${id}`, () => withLock(`generated:${agentId}`, () => locked(lockDir, async () => {
      await reconcileUser(agentId);
      return task();
    })));
  }

  /**
   * The only writer of new agent folders: everything is staged in a hidden folder, then renamed
   * into place. Source notes use the human format; each message ends with links to its sources.
   */
  async function createAgentFolder(agentId: string, input: {
    id: string; status: PublicationMeta["status"]; visibility: "private" | "public"; doc: Document; summary: string;
    messages: { body: string; sources: number[] }[]; sources: (SourceInput & { accessedAt: string })[];
  }) {
    const live = inside(generatorsDir, agentId);
    await mkdir(live, { recursive: true, mode: 0o700 });
    if (await assertInVault(vault, live) !== live) throw invalid("Dossier de publication invalide.");
    const date = now(), at = date.toISOString();
    const type = input.messages.length > 1 ? "thread" : "post";
    const used = (await listDir(live)).map(entry => FOLDER_NAME.exec(entry.name)).filter(match => match?.[2] === stamp(date)).map(match => Number(match![3]));
    const sequence = String(Math.max(0, ...used) + 1).padStart(3, "0");
    const target = inside(live, `${type}_${stamp(date)}_${sequence}`);
    const stage = inside(live, `.${input.id}-${randomUUID()}`);
    await mkdir(stage, { mode: 0o700 });
    try {
      const meta: PublicationMeta = { id: input.id, type, authorType: "ai", authorId: agentId, status: input.status, visibility: input.visibility, createdAt: at, updatedAt: at, publishedAt: input.status === "published" ? at : null, score: null };
      setMeta(input.doc, meta);
      const sourceFiles = input.sources.map((source, i) => `${i + 1}_${slugify(source.title, "source")}.md`);
      if (sourceFiles.length) await mkdir(inside(stage, "_sources"), { mode: 0o700 });
      for (const [i, source] of input.sources.entries()) await writeAtomic(inside(stage, "_sources", sourceFiles[i]), serializeSource(source, source.accessedAt));
      const order: string[] = [];
      for (const [i, message] of input.messages.entries()) {
        const file = `${i + 1}_${messageSlug(message.body)}.md`;
        order.push(file);
        const links = message.sources.map(n => sourceLinkLine(rel(target), sourceFiles[n], input.sources[n].title, input.sources[n].publisher));
        await writeAtomic(inside(stage, file), links.length ? `${message.body.trimEnd()}\n\n## Sources\n${links.join("\n")}\n` : message.body);
      }
      // Parent relations for conversations are derived from ordered messages,
      // leaving reply_to available for explicit secondary branches.
      input.doc.set("thread_continuation", true);
      await writeAtomic(inside(stage, "index.md"), serializeIndex(input.doc, input.summary, order.map(file => messageEmbedTarget(rel(target), file))));
      await rename(stage, target);
      return snapshot(await reindex(target));
    } finally { await rm(stage, { recursive: true, force: true }); }
  }

  /**
   * Fictitious test publication confirmed by the owner. Public visibility requires explicit
   * confirmation; the request UUID makes retries idempotent; `testDailyLimit` caps fixtures over a
   * rolling 24 h and is not part of the content fingerprint.
   */
  async function publishGenerated(viewer: Viewer, agentId: string, raw: unknown, options: { testDailyLimit?: number } = {}): Promise<PublicationSnapshot> {
    const data = z.object({
      id: z.string().regex(PUBLICATION_ID), summary: z.string().min(1).max(20_000),
      messages: z.array(z.string().min(1).max(100_000)).min(1).max(10),
      topicIds: z.array(z.uuid()).min(1).max(31),
      visibility: z.enum(["private", "public"]).default("private"),
      publicConfirmed: z.boolean().default(false),
    }).strict().parse(raw);
    if (data.visibility === "public" && !data.publicConfirmed) throw invalid("Confirmation publique requise.");
    if (!await ownsAgent(viewer.id, agentId)) throw notFound();
    await ensureIndexed();
    return agentLock(data.id, agentId, async () => {
      const fingerprint = createHash("sha256").update(JSON.stringify(data)).digest("hex");
      if (index.get(data.id)) {
        const folder = await loadLive(data.id);
        if (folder.meta.authorType !== "ai" || folder.meta.authorId !== agentId || folder.doc.get("generation_fingerprint") !== fingerprint) throw invalid("Cet aperçu a déjà été utilisé pour un autre contenu.");
        return snapshot(folder);
      }
      if (options.testDailyLimit !== undefined) {
        const since = now().getTime() - 86_400_000;
        if (agentPublications(agentId).filter(p => p.test && p.publishedAt.getTime() > since).length >= options.testDailyLimit) throw new PublicationError("rate_limited", "Limite quotidienne de publications de test atteinte pour ce ΞAgent.");
      }
      const doc = new Document({ generator: agentId, topics: data.topicIds, primary_topic: data.topicIds[0], test_content: true, generated_by: "manual-fixture-v1", confirmed_by: viewer.id, generation_fingerprint: fingerprint });
      return createAgentFolder(agentId, {
        id: data.id, status: "published", visibility: data.visibility, doc, summary: data.summary, sources: [],
        messages: data.messages.map((body, i) => ({ body: labelTestMessage(body, i, data.messages.length), sources: [] })),
      });
    });
  }

  const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
  const draftSchema = z.object({
    id: z.string().regex(PUBLICATION_ID), summary: z.string().trim().min(1).max(2_000), topicIds: z.array(z.uuid()).min(1).max(31),
    messages: z.array(z.object({ body: z.string().trim().min(1).max(10_000), sources: z.array(z.number().int().min(0)).min(1).max(20) }).strict()).min(1).max(10),
    sources: z.array(z.object({
      url: z.string().max(2_000).refine(value => /^https?:\/\//i.test(value), "URL http(s) attendue."), title: z.string().trim().min(1).max(300), publisher: z.string().trim().min(1).max(200),
      publishedAt: day.optional(), accessedAt: day, facts: z.array(z.string().trim().min(1).max(1_000)).min(1).max(30), reservations: z.array(z.string().trim().min(1).max(1_000)).max(10),
    }).strict()).min(1).max(20),
    watch: z.record(z.string(), z.unknown()),
  }).strict();

  /**
   * Private draft written by the watch worker from a verified candidate: status `draft`,
   * visibility `private`, never labelled as a fixture (`generated_by: watch-draft-v1`, no
   * `test_content`). Every message has at least one source note. Idempotent by id.
   */
  async function saveWatchDraft(owner: string, agentId: string, raw: unknown): Promise<PublicationSnapshot> {
    const data = draftSchema.parse(raw);
    if (data.messages.some(message => message.sources.some(n => n >= data.sources.length))) throw invalid("Source de message inconnue.");
    if (data.messages.some(message => SOURCES_HEADING.test(message.body))) throw invalid("Les sources sont ajoutées par Ξ, pas par le texte.");
    if (!await ownsAgent(owner, agentId)) throw notFound();
    await ensureIndexed();
    return agentLock(data.id, agentId, async () => {
      if (index.get(data.id)) {
        const folder = await loadLive(data.id);
        if (folder.meta.authorType !== "ai" || folder.meta.authorId !== agentId || folder.doc.get("generated_by") !== WATCH_DRAFT) throw invalid("Identifiant de brouillon déjà utilisé.");
        return snapshot(folder);
      }
      const doc = new Document({ generator: agentId, topics: data.topicIds, primary_topic: data.topicIds[0], generated_by: WATCH_DRAFT, review: "pending", watch: data.watch });
      return createAgentFolder(agentId, { id: data.id, status: "draft", visibility: "private", doc, summary: data.summary, messages: data.messages, sources: data.sources });
    });
  }

  /**
   * Owner review of a watch draft. `update` replaces the prose of each message and keeps its
   * sources section (the caller checks the prose against those sources); `reject` keeps the
   * folder as a rejected draft; `approve` publishes it **privately** (manual end-to-end test).
   */
  async function reviewWatchDraft(viewer: Viewer, agentId: string, id: string, raw: unknown) {
    const data = z.object({ action: z.enum(["update", "approve", "reject"]), revision: z.string().min(1).max(200), messages: z.array(z.string().max(10_000)).max(10).optional() }).strict().parse(raw);
    if (!PUBLICATION_ID.test(id) || !await ownsAgent(viewer.id, agentId)) throw notFound();
    await ensureIndexed();
    // Same locks as the worker's automatic publication: a review and a publication never interleave.
    return agentLock(id, agentId, async () => {
      const folder = await loadLive(id);
      if (folder.meta.authorType !== "ai" || folder.meta.authorId !== agentId || folder.doc.get("generated_by") !== WATCH_DRAFT) throw notFound();
      if (folder.meta.status !== "draft" || folder.doc.get("review") !== "pending") throw invalid("Ce brouillon n’est plus modifiable.");
      if (folder.revision !== data.revision) return { ok: false as const, conflict: snapshot(folder) };
      const at = now().toISOString();
      const files = folder.messages.map(message => message.file);
      if (data.action === "update") {
        if (!data.messages || data.messages.length !== folder.messages.length) throw invalid("Chaque message du brouillon doit être conservé.");
        for (const [i, message] of folder.messages.entries()) {
          const prose = data.messages[i].trim();
          if (!prose || SOURCES_HEADING.test(prose)) throw invalid("Message vide ou section de sources modifiée.");
          await writeAtomic(inside(folder.dir, message.file), `${prose}\n\n${splitSourcesSection(message.body).sources}`);
        }
        folder.doc.set("review_edited", { by: viewer.id, at });
        await writeIndex(folder, { ...folder.meta, updatedAt: at }, folder.summary, files);
      } else {
        folder.doc.set("review", data.action === "approve" ? "approved" : "rejected");
        folder.doc.set("reviewed", { by: viewer.id, at });
        await writeIndex(folder, data.action === "approve" ? { ...folder.meta, status: "published", visibility: "private", publishedAt: at, updatedAt: at } : { ...folder.meta, updatedAt: at }, folder.summary, files);
      }
      return { ok: true as const, snapshot: snapshot(await reindex(folder.dir)) };
    });
  }

  /**
   * Automatic publication of a watch draft, decided at the exact moment of writing: under the
   * cross-process lock the folder is re-read, it must still be a pending draft at the revision that
   * was validated, then `guard` re-checks configuration and ceilings (null = allowed) and `record`
   * stores the decision before the lock is released. Already published: reported, never repeated.
   */
  async function publishWatchDraft(owner: string, agentId: string, id: string, options: {
    visibility: "private" | "public"; revision: string; details: Record<string, unknown>;
    guard: () => Promise<string | null>; record: (snapshot: PublicationSnapshot) => void;
  }): Promise<{ outcome: "published" | "already"; snapshot: PublicationSnapshot } | { outcome: "missing" | "unavailable" | "modified" | "blocked"; reason: string }> {
    if (!PUBLICATION_ID.test(id) || !await ownsAgent(owner, agentId)) return { outcome: "missing", reason: "Brouillon introuvable ou ΞAgent d’un autre compte." };
    await ensureIndexed();
    return agentLock(id, agentId, async () => {
      const folder = await loadLive(id).catch(() => null);
      if (!folder || folder.meta.authorType !== "ai" || folder.meta.authorId !== agentId || folder.doc.get("generated_by") !== WATCH_DRAFT) return { outcome: "missing" as const, reason: "Brouillon introuvable." };
      if (folder.meta.status === "published") return { outcome: "already" as const, snapshot: snapshot(folder) };
      const review = folder.doc.get("review");
      if (review !== "pending") return { outcome: "unavailable" as const, reason: review === "rejected" ? "Brouillon rejeté par le propriétaire." : "Brouillon retiré." };
      if (folder.revision !== options.revision) return { outcome: "modified" as const, reason: "Brouillon modifié depuis sa validation : approbation manuelle requise." };
      const blocked = await options.guard();
      if (blocked) return { outcome: "blocked" as const, reason: blocked };
      const at = now().toISOString();
      folder.doc.set("review", "auto-published");
      folder.doc.set("auto_publication", { at, visibility: options.visibility, ...options.details });
      await writeIndex(folder, { ...folder.meta, status: "published", visibility: options.visibility, publishedAt: at, updatedAt: at }, folder.summary, folder.messages.map(message => message.file));
      const published = snapshot(await reindex(folder.dir));
      options.record(published);
      return { outcome: "published" as const, snapshot: published };
    });
  }

  /** A pending draft that must never be published (obsolete, superseded, invalid sources). */
  async function retireWatchDraft(owner: string, agentId: string, id: string, reason: string) {
    if (!PUBLICATION_ID.test(id) || !await ownsAgent(owner, agentId)) return false;
    await ensureIndexed();
    return agentLock(id, agentId, async () => {
      const folder = await loadLive(id).catch(() => null);
      if (!folder || folder.meta.authorId !== agentId || folder.doc.get("generated_by") !== WATCH_DRAFT || folder.meta.status !== "draft" || folder.doc.get("review") !== "pending") return false;
      folder.doc.set("review", "retired");
      folder.doc.set("retired", { at: now().toISOString(), reason });
      await writeIndex(folder, { ...folder.meta, updatedAt: now().toISOString() }, folder.summary, folder.messages.map(message => message.file));
      await reindex(folder.dir);
      return true;
    });
  }

  async function get(viewer: Viewer, id: string) {
    const folder = await loadLive(id);
    const {viewer:reader} = await authorized(viewer);
    if (!canRead(reader, folder.meta)) throw notFound();
    return withParent(snapshot(folder), reader);
  }


  // Trash is structural only when this exact message still has an independently readable child.
  const structuralReadableSql = (publication: string, message: string) => readablePublicationSql(publication).replace(`${publication}.trashed_at IS NULL`, `(${publication}.trashed_at IS NULL OR EXISTS (SELECT 1 FROM publication_message child JOIN publication cp ON cp.id=child.publication_id WHERE child.reply_to=(${message}.publication_id || '/' || ${message}.n) AND child.deleted=0 AND ${readablePublicationSql("cp")}))`);

  // Thread continuation (`thread_continuation`) is indexed as reply_to but is never a reply.
  function withReplyCounts(item: PublicationSnapshot, viewer: Viewer) {
    const counts = db.prepare<{viewer:string;parent:string;self:string;thread:string},{reply_to:string;total:number}>(`SELECT m.reply_to, COUNT(*) AS total FROM publication_message m JOIN publication p ON p.id=m.publication_id WHERE m.reply_to LIKE @parent AND NOT (m.publication_id=@self AND m.n IN (SELECT value FROM json_each(@thread))) AND ${structuralReadableSql("p", "m")} AND (m.deleted=0 OR EXISTS (SELECT 1 FROM publication_message child JOIN publication cp ON cp.id=child.publication_id WHERE child.reply_to=(m.publication_id || '/' || m.n) AND child.deleted=0 AND ${readablePublicationSql("cp")})) GROUP BY m.reply_to`).all({viewer:viewer.id,parent:item.id+"/%",self:item.id,thread:JSON.stringify(threadNumbers(item.messages, item.id))});
    const byRef = new Map(counts.map(row => [row.reply_to,row.total]));
    const messages = item.messages.map(message => ({...message,replyCount:byRef.get(`${item.id}/${parseInt(message.file,10)}`) ?? 0}));
    for (const row of index.messages(item.id)) {
      const replyCount = byRef.get(`${item.id}/${row.n}`) ?? 0;
      if (row.deleted && replyCount) messages.splice(Math.min(row.position-1,messages.length),0,{file:row.file,body:"",replyTo:row.reply_to,deleted:true,replyCount});
    }
    return {...item,messages};
  }

  async function withParent(item: PublicationSnapshot, viewer: Viewer) {
    item = withReplyCounts(item, viewer);
    const ownRow = index.get(item.id);
    const own = ownRow && await readFolder(fromVaultRelative(vault, ownRow.path));
    const previousId = own?.doc.get("previous_version");
    if (typeof previousId === "string") {
      const previousRow = index.get(previousId);
      const previous = previousRow && !previousRow.trashed_at && await readFolder(fromVaultRelative(vault, previousRow.path));
      if (previous && canRead(viewer, previous.meta)) item = { ...item, previousVersion: previousId };
    }
    const reply = item.messages[0]?.replyTo;
    if (!reply) return item;
    const [id, n] = reply.split("/");
    if (id === item.id) return item;
    const row = index.get(id);
    if (!row || row.trashed_at) return item;
    const parent = await readFolder(fromVaultRelative(vault, row.path));
    if (!parent || !canRead(viewer, parent.meta)) return item;
    const message = parent.messages.find(m => parseInt(m.file, 10) === Number(n));
    return message ? { ...item, parentContext: { publicationId: id, ref: reply, excerpt: excerpt(message.body) } } : item;
  }

  async function getEditable(viewer: Viewer, id: string) {
    return snapshot(await loadEditable(viewer, id));
  }

  /**
   * Optimistic concurrency: nothing is written unless the folder is exactly the revision the client edited.
   * Otherwise the current files are returned and the author decides; Obsidian edits are never overwritten silently.
   */
  async function save(viewer: Viewer, id: string, raw: SaveInput): Promise<SaveResult> {
    const parsed = saveSchema.safeParse(raw);
    if (!parsed.success) throw invalid("Contenu de publication invalide.");
    const input = parsed.data;
    return withLock(id, async () => {
      let folder = await loadEditable(viewer, id);
      if (folder.revision !== input.baseRevision) return { ok: false, conflict: snapshot(folder) };
      if (folder.meta.status === "published" && folder.doc.get("analysis") === true) throw invalid("Une analyse publiée est immuable. Créez une correction datée.");
      const referenced = input.messages.flatMap((message) => message.file ?? []);
      const current = new Map(folder.messages.map((message) => [message.file, message.body]));
      if (new Set(referenced).size !== referenced.length || referenced.some((file) => !current.has(file))) throw invalid("Message inconnu.");
      const kept = input.messages.filter((message) => message.file !== null || hasContent(message.body));
      const type = kept.length > 1 ? "thread" : "post";

      // Draft folders follow their type (post_ ↔ thread_); published folders keep their name for external links.
      let relocated: { from: string; to: string } | null = null;
      const name = FOLDER_NAME.exec(basename(folder.dir));
      if (folder.meta.status === "draft" && name && name[1] !== type) {
        const target = inside(dirname(folder.dir), `${type}_${name[2]}_${name[3]}`);
        if (!(await exists(target))) {
          const from = rel(folder.dir);
          await relocate(folder.dir, target, from);
          relocated = { from, to: rel(target) };
          folder = (await readFolder(target))!;
        }
      }
      const fix = (text: string) => relocated ? rewriteFolderLinks(text, relocated.from, relocated.to) : text;
      const onDisk = new Map(folder.messages.map((message) => [message.file, message.body]));

      // Numbers of removed messages stay reserved: a message ref must never point to another message later.
      const removedDir = inside(trashDir, viewer.id, id, "removed-messages");
      const removedFiles = (await listDir(removedDir)).map((entry) => entry.name.replace(/^\d+_/, "")).filter((name) => NUMBERED_FILE.test(name));
      let next = Math.max(maxNumber(folder.numbered), maxNumber(removedFiles)) + 1;
      const files: Record<string, string> = {};
      const order: string[] = [];
      for (const message of kept) {
        let body = fix(message.body);
        const old = message.file ? folder.messages.find(item => item.file === message.file) : undefined;
        if ((old && onDisk.get(message.file!) !== body) || (!old && folder.meta.status === "published")) {
          const parts = splitFrontmatter(body);
          const doc = parts.yaml ? parseDocument(parts.yaml) : new Document({});
          if (doc.errors.length) throw invalid("Métadonnées du message invalides.");
          doc.set("created_at", old ? old.createdAt ?? folder.meta.createdAt : now().toISOString());
          if (old) doc.set("updated_at", now().toISOString());
          body = `---\n${doc.toString()}---\n${parts.body}`;
        }
        const file = message.file ?? `${next++}_${messageSlug(body)}.md`;
        if (onDisk.get(file) !== body) await writeAtomic(inside(folder.dir, file), body);
        files[message.key] = file;
        order.push(file);
      }
      const deletedValue = (folder.doc.toJS() as Record<string, unknown>).deleted_messages;
      const deletedMessages: {n:number;reply_to:string|null;created_at:string;position?:number}[] = Array.isArray(deletedValue) ? deletedValue : [];
      for (const file of onDisk.keys()) {
        if (order.includes(file)) continue;
        const removed = folder.messages.find(item => item.file === file)!;
        deletedMessages.push({n: parseInt(file, 10), position: folder.messages.findIndex(item => item.file === file)+1, reply_to: removed.replyTo ?? null, created_at: removed.createdAt ?? folder.meta.createdAt});
        await mkdir(removedDir, { recursive: true, mode: 0o700 });
        await rename(inside(folder.dir, file), inside(removedDir, `${Date.now()}_${file}`));
      }
      if (deletedMessages.length) folder.doc.set("deleted_messages", deletedMessages);
      await writeIndex(folder, { ...folder.meta, type, visibility: input.visibility, updatedAt: now().toISOString() }, fix(input.summary), order);
      return { ok: true, snapshot: snapshot(await reindex(folder.dir)), files, relocated };
    });
  }

  async function createCorrection(viewer: Viewer, id: string) {
    const previous = await loadEditable(viewer, id);
    if (previous.meta.status !== "published") throw invalid("La version précédente doit être publiée.");
    const newId = await create(viewer);
    const target = await loadEditable(viewer, newId);
    for (const [file, body] of (await readMarkdownTree(previous.dir)).files) {
      if (file === "index.md") continue;
      const path = inside(target.dir, ...file.split("/"));
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeAtomic(path, rewriteFolderLinks(body, rel(previous.dir), rel(target.dir)));
    }
    target.doc = previous.doc;
    target.doc.set("previous_version", id);
    target.doc.set("analysis", true);
    target.doc.set("version_created_at", now().toISOString());
    await writeIndex(target, { ...target.meta, type: previous.meta.type, visibility: previous.meta.visibility }, previous.summary, previous.messages.map(m => m.file));
    await reindex(target.dir);
    return newId;
  }

  async function publish(viewer: Viewer, id: string, baseRevision: string): Promise<SaveResult> {
    return withLock(id, async () => {
      const folder = await loadEditable(viewer, id);
      if (folder.revision !== baseRevision) return { ok: false, conflict: snapshot(folder) };
      if (folder.meta.status === "draft") {
        if (!folder.summary && !folder.messages.length) throw invalid("Écrivez quelque chose avant de publier.");
        const at = now().toISOString();
        await writeIndex(folder, { ...folder.meta, status: "published", publishedAt: at, updatedAt: at }, folder.summary, folder.messages.map((message) => message.file));
      }
      return { ok: true, snapshot: snapshot(await reindex(folder.dir)), files: {}, relocated: null };
    });
  }

  async function addSource(viewer: Viewer, id: string, baseRevision: string, raw: SourceFormInput) {
    const parsed = sourceSchema.safeParse(raw);
    if (!parsed.success) throw invalid(parsed.error.issues[0]?.message ?? "Source invalide.");
    const source = parsed.data;
    return withLock(id, async () => {
      const folder = await loadEditable(viewer, id);
      if (folder.revision !== baseRevision) return { ok: false as const, conflict: snapshot(folder) };
      if (folder.meta.status === "published" && folder.doc.get("analysis") === true) throw invalid("Une analyse publiée est immuable. Créez une correction datée.");
      const sourcesDir = inside(folder.dir, "_sources");
      await mkdir(sourcesDir, { recursive: true, mode: 0o700 });
      const file = `${maxNumber(folder.sources.map((item) => item.file)) + 1}_${slugify(source.title, "source")}.md`;
      await writeAtomic(inside(sourcesDir, file), serializeSource(source, now().toISOString().slice(0, 10)));
      const updated = await reindex(folder.dir);
      return { ok: true as const, revision: updated.revision, line: sourceLinkLine(rel(folder.dir), file, source.title, source.publisher), snapshot: snapshot(updated) };
    });
  }

  /** The whole folder moves to the author's private trash; it leaves every shared view at once. */
  async function trash(viewer: Viewer, id: string) {
    await withLock(id, async () => {
      const folder = await loadEditable(viewer, id);
      const target = inside(trashDir, viewer.id, id);
      await mkdir(target, { recursive: true, mode: 0o700 });
      const info: TrashInfo = { id, folder: basename(folder.dir), originalPath: rel(folder.dir), trashedAt: now().toISOString() };
      await writeAtomic(inside(target, "trash.json"), `${JSON.stringify(info, null, 2)}\n`);
      await rename(folder.dir, inside(target, info.folder));
      await reindex(inside(target, info.folder), info);
    });
  }

  async function restore(viewer: Viewer, id: string) {
    return withLock(id, async () => {
      const row = await locate(id);
      const info = row.trashed_at ? await readTrashInfo(row.author_id, id) : null;
      if (!info) throw notFound();
      const folder = await readFolder(inside(trashDir, row.author_id, id, info.folder));
      if (!owned(folder, row.author_id, id) || !canManageTrash(viewer, folder.meta)) throw notFound();
      const live = userDir(viewer.id);
      await mkdir(live, { recursive: true, mode: 0o700 });
      return withLock(`user:${viewer.id}`, async () => {
        // The original folder name is reused when free; otherwise a fresh number, with links repointed.
        const original = info.originalPath.split("/");
        const name = FOLDER_NAME.exec(original.at(-1) ?? "");
        let target = original.length === 4 && original[0] === "posts" && original[1] === "_users" && original[2] === viewer.id && name
          ? inside(live, original[3]) : null;
        if (!target || await exists(target)) {
          const date = name?.[2] ?? stamp(now());
          target = inside(live, `${folder.meta.type}_${date}_${await nextSequence(viewer.id, date)}`);
        }
        await relocate(folder.dir, target, info.originalPath);
        await rm(inside(trashDir, viewer.id, id, "trash.json"), { force: true });
        await reindex(target);
        // Only vault-relative names leave the store.
        return { id, folder: basename(target), renamed: rel(target) !== info.originalPath };
      });
    });
  }

  /**
   * One page of readable publications. Home uses the chosen editorial/chronological
   * policy; author/own lists remain chronological. Preferences filter home only.
   * Each item is re-read from its files and re-checked, so a stale index can never widen access.
   */
  async function page(viewer: Viewer, scope: FeedScope, cursor?: string | null, limit = 20): Promise<FeedPage> {
    const size = Math.min(Math.max(Math.floor(limit), 1), 50);
    await ensureIndexed();
    const {effective,viewer:reader} = await authorized(viewer);
    const forYou = scope.kind === "home" && scope.tab !== "following";
    // Explicit preference tiers remain authoritative. Within a tier, take one
    // publication per author per round, ordered by editorial score then freshness.
    let after: { order: string; id: string } | null = null;
    if (cursor) try {
      const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
      if (typeof parsed?.order === "string" && typeof parsed?.id === "string") after = parsed;
    } catch { /* Legacy or invalid links restart from the first page. */ }
    const clauses = [readablePublicationSql("p")];
    const match = scope.kind === "search" && scope.text ? ftsQuery(scope.text) : null;
    const topicIds = scope.kind === "search" ? [...new Set(scope.topicIds ?? [])] : [];
    if (scope.kind === "search") {
      // Nothing searchable (empty text, only stop words, malformed ids): no result rather than everything.
      if ((scope.text && !match) || (!match && !topicIds.length) || topicIds.some(id => !TOPIC_ID.test(id))) return { items: [], nextCursor: null };
      if (topicIds.length) clauses.push(`(SELECT COUNT(*) FROM publication_topic t WHERE t.publication_id = p.id AND t.topic_id IN (SELECT value FROM json_each(@topics))${scope.origin ? ` AND t.origin = '${scope.origin === "inferred" ? "inferred" : "declared"}'` : ""}) = @topicCount`);
    }
    if (scope.kind !== "own") clauses.push("p.status = 'published'");
    if (scope.kind === "own") clauses.push("p.author_id = @viewer AND p.author_type = 'human'");
    if (scope.kind === "author") clauses.push("p.author_id = @author");
    if (scope.kind === "conversation") clauses.push("p.reply_to LIKE @parent");
    if (scope.kind === "home") {
      clauses.push("COALESCE((SELECT value FROM json_each(@preferences) WHERE key=p.author_id), 'normal') != 'hidden'");
      if (scope.tab === "following") clauses.push("EXISTS (SELECT 1 FROM feed_follow f WHERE f.viewer_id=@viewer AND f.author_id=p.author_id)");
      // A reply stays in its parent's conversation when that parent belongs to this feed.
      clauses.push(`(p.reply_to IS NULL OR COALESCE(p.score,0)>0 OR NOT EXISTS (SELECT 1 FROM publication parent WHERE parent.id=substr(p.reply_to,1,instr(p.reply_to,'/')-1)
        AND ${readablePublicationSql("parent")} AND parent.status='published'
        AND COALESCE((SELECT value FROM json_each(@preferences) WHERE key=parent.author_id),'normal')!='hidden'
        ${scope.tab === "following" ? "AND EXISTS (SELECT 1 FROM feed_follow f WHERE f.viewer_id=@viewer AND f.author_id=parent.author_id)" : ""}))`);
    }
    const preferenceSql = forYou ? "CASE (SELECT value FROM json_each(@preferences) WHERE key=p.author_id) WHEN 'priority' THEN 1 WHEN 'less' THEN -1 ELSE 0 END" : "0";
    const scoreSql = forYou ? "COALESCE(p.score,0)" : "0";
    // bm25: lower is more relevant. Outside a text search every row ranks equally.
    const source = match ? "publication p JOIN (SELECT rowid AS fts_rowid, bm25(publication_fts) AS relevance FROM publication_fts WHERE publication_fts MATCH @match) f ON f.fts_rowid = p.rowid" : "publication p";
    const rows = db.prepare<Record<string, string | number | null>, IndexRow>(`WITH candidates AS (
      SELECT p.*, ${match ? "f.relevance" : "0"} AS relevance_rank, ${preferenceSql} AS preference_rank, ${scoreSql} AS score_rank, COALESCE(p.published_at,p.updated_at) AS sort_date
      FROM ${source} WHERE ${clauses.join(" AND ")}), ranked AS (
      SELECT *, ${forYou ? "ROW_NUMBER() OVER (PARTITION BY author_id ORDER BY score_rank DESC,sort_date DESC,id DESC)" : "0"} AS author_round FROM candidates)
      SELECT * FROM ranked ORDER BY relevance_rank ASC,preference_rank DESC,author_round ASC,score_rank DESC,sort_date DESC,id DESC`).all({
        viewer: viewer.id, preferences: JSON.stringify(effective.preferences),
        author: scope.kind === "author" ? scope.authorId : null,
        parent: scope.kind === "conversation" ? scope.publicationId + "/%" : null,
        match, topics: JSON.stringify(topicIds), topicCount: topicIds.length,
      });
    // A changing author rank cannot safely use an old numeric offset. The opaque
    // fingerprint covers only this viewer's ordered feed, never private global activity.
    const order = createHash("sha256").update(JSON.stringify([viewer.id, scope, rows.map(row => row.id)])).digest("hex");
    if (after && after.order !== order) throw new PublicationError("stale_cursor", "Le fil a changé. Rechargez la liste.");
    const start = after ? rows.findIndex(row => row.id === after.id) + 1 : 0;
    const items: PublicationSnapshot[] = [];
    let more = false;
    for (const row of rows.slice(start)) {
      const folder = await readFolder(fromVaultRelative(vault, row.path));
      if (!owned(folder, row.author_id, row.id) || !canRead(reader, folder.meta)) continue;
      if (items.length === size) { more = true; break; }
      items.push(await withParent(snapshot(folder), reader));
    }
    return { items, nextCursor: more ? Buffer.from(JSON.stringify({ order, id: items.at(-1)!.id })).toString("base64url") : null };
  }

  async function authorized(viewer: Viewer) {
    const agents = await readGenerators(vault, viewer);
    const managedAgents = agents.filter(agent => agent.ownerId === viewer.id).map(agent => agent.id).sort();
    const previous = db.prepare<[string], {author_id:string}>("SELECT author_id FROM feed_managed_agent WHERE viewer_id = ? ORDER BY author_id").all(viewer.id).map(row => row.author_id);
    if (JSON.stringify(previous) !== JSON.stringify(managedAgents)) db.transaction(() => {
      db.prepare("DELETE FROM feed_managed_agent WHERE viewer_id = ?").run(viewer.id);
      for (const id of managedAgents) db.prepare("INSERT INTO feed_managed_agent VALUES (?, ?)").run(viewer.id, id);
      bumpIndexGeneration(db);
    })();
    const effective = effectiveSocial(await readSocial(vault, viewer), agents);
    // Refresh the shared SQL permission projection used by the graph and conversations.
    const existing = db.prepare<[string], {author_id:string}>("SELECT author_id FROM feed_follow WHERE viewer_id = ? ORDER BY author_id").all(viewer.id).map(row => row.author_id);
    const following = [...effective.following].sort();
    if (JSON.stringify(existing) !== JSON.stringify(following)) db.transaction(() => {
      db.prepare("DELETE FROM feed_follow WHERE viewer_id = ?").run(viewer.id);
      const insert = db.prepare("INSERT INTO feed_follow(viewer_id, author_id) VALUES (?, ?)");
      for (const author of following) insert.run(viewer.id, author);
      bumpIndexGeneration(db);
    })();
    return { effective, viewer: {id: viewer.id, following, managedAgents} };
  }

  const realtimeReaders = new Map<string, {generation:string; value: Awaited<ReturnType<typeof authorized>>}>();
  async function realtimeState(viewer: Viewer) {
    await ensureIndexed();
    let cached = realtimeReaders.get(viewer.id);
    if (!cached || cached.generation !== indexGeneration(db)) {
      const value = await authorized(viewer);
      cached = {generation:indexGeneration(db),value};
      // Bound memory on long-lived servers; cache keys never cross viewers.
      if (realtimeReaders.size > 1000) realtimeReaders.clear();
      realtimeReaders.set(viewer.id,cached);
    }
    const {effective} = cached.value;
    const rows = db.prepare<{viewer:string},IndexRow>(`SELECT p.* FROM publication p WHERE ${readablePublicationSql("p")} ORDER BY p.id`).all({viewer:viewer.id});
    return {version: indexGeneration(db), settingsRevision:JSON.stringify({following:[...effective.following].sort(),preferences:effective.preferences}), publications: rows.map(row => ({id:row.id, revision:row.revision ?? `${row.index_mtime}:${row.updated_at}`}))};
  }

  async function conversation(viewer: Viewer, ref: string, cursor?: string | null): Promise<ConversationPage> {
    if (!/^[0-9a-f-]{36}\/[1-9]\d*$/.test(ref)) throw notFound();
    await ensureIndexed();
    const {viewer: reader} = await authorized(viewer);
    // One snapshot (and one reply count query) per publication, whatever the number of entries.
    const sources = new Map<string, Promise<{row: IndexRow; publication: PublicationSnapshot} | null>>();
    const readable = (id: string) => {
      if (!sources.has(id)) sources.set(id, (async () => {
        const row = index.get(id);
        const folder = row && await readFolder(fromVaultRelative(vault, row.path));
        return row && folder && canRead(reader, folder.meta) ? {row, publication: withReplyCounts(snapshot(folder), reader)} : null;
      })());
      return sources.get(id)!;
    };
    const entry = async (target: string): Promise<ConversationEntry | null> => {
      const [id, number] = target.split("/");
      const source = await readable(id);
      if (!source) return null;
      const indexed = index.messages(id).find(message => message.n === Number(number));
      if (!indexed) return null;
      const {row, publication} = source;
      const replyCount = publication.messages.find(message => parseInt(message.file,10) === Number(number))?.replyCount ?? db.prepare<{viewer:string;ref:string},{total:number}>(`SELECT COUNT(*) AS total FROM publication_message m JOIN publication p ON p.id=m.publication_id WHERE m.reply_to=@ref AND m.deleted=0 AND ${readablePublicationSql("p")}`).get({viewer:viewer.id,ref:target})!.total;
      if (row.trashed_at || indexed.deleted) {
        const child = db.prepare<{viewer:string;ref:string}, {n:number}>(`SELECT m.n FROM publication_message m JOIN publication p ON p.id = m.publication_id WHERE m.reply_to = @ref AND m.deleted = 0 AND ${readablePublicationSql("p")} LIMIT 1`).get({viewer:viewer.id,ref:target});
        return child ? {ref:target,publicationId:id,message:null,publication:null,deleted:true,replyCount} : null;
      }
      const message = publication.messages.find(message => parseInt(message.file,10) === Number(number));
      return message ? {ref:target, publicationId:id, message, publication, deleted:false,replyCount} : null;
    };
    const parent = await entry(ref);
    if (!parent) throw notFound();
    // The thread of the selected message is built from its publication's order, never from dates;
    // its members are neither ancestors nor replies of one another.
    const publicationId = ref.split("/")[0];
    const own = await readable(publicationId);
    const spine = new Set<string>();
    const thread: ConversationEntry[] = [];
    if (own && !own.row.trashed_at) {
      for (const n of threadNumbers(own.publication.messages, publicationId)) spine.add(`${publicationId}/${n}`);
      if (spine.size > 1 && spine.has(ref)) for (const target of spine) {
        const member = target === ref ? parent : await entry(target);
        if (member) thread.push(member);
      }
    }
    const ancestors: ConversationEntry[] = [];
    const seen = new Set([ref, ...thread.map(member => member.ref)]);
    let current = thread[0]?.ref ?? ref;
    while (true) {
      const [id, number] = current.split("/");
      const next = index.messages(id).find(message => message.n === Number(number))?.reply_to;
      if (!next || seen.has(next)) break;
      seen.add(next);
      const ancestor = await entry(next);
      if (!ancestor) break;
      ancestors.unshift(ancestor);
      current = next;
    }
    let after: [string,string] | null = null;
    if (cursor) {
      try {
        const parsed = JSON.parse(Buffer.from(cursor,"base64url").toString("utf8"));
        if (Array.isArray(parsed) && parsed.length === 3 && parsed[0] === ref && typeof parsed[1] === "string" && typeof parsed[2] === "string") after = [parsed[1],parsed[2]];
        else throw new Error();
      } catch { throw invalid("Curseur de réponses invalide."); }
    }
    const query = db.prepare<{viewer:string;ref:string;date:string|null;after:string|null}, MessageRow>(`SELECT m.* FROM publication_message m JOIN publication p ON p.id=m.publication_id
      WHERE m.reply_to=@ref AND ${structuralReadableSql("p", "m")}
      AND (@date IS NULL OR m.created_at>@date OR (m.created_at=@date AND (m.publication_id || '/' || m.n)>@after))
      ORDER BY m.created_at ASC, (m.publication_id || '/' || m.n) ASC LIMIT 11`);
    const children: ConversationEntry[] = [];
    let last: MessageRow | undefined;
    let more = false;
    // Continue across stale/unreadable rows without a short page or exposing their count.
    while (children.length <= 10) {
      const rows = query.all({viewer:viewer.id,ref,date:after?.[0] ?? null,after:after?.[1] ?? null});
      if (!rows.length) break;
      for (const row of rows) {
        const childRef = `${row.publication_id}/${row.n}`;
        after = [row.created_at ?? "",childRef];
        if (seen.has(childRef) || spine.has(childRef)) continue;
        const child = await entry(childRef);
        if (!child) continue;
        if (children.length === 10) { more = true; break; }
        children.push(child);
        last = row;
      }
      if (more || rows.length < 11) break;
    }
    return {parent,ancestors,thread,children,nextCursor:more && last ? Buffer.from(JSON.stringify([ref,last.created_at,`${last.publication_id}/${last.n}`])).toString("base64url") : null};
  }

  const replies = (viewer: Viewer, publicationId: string, cursor?: string | null) => page(viewer, { kind: "conversation", publicationId }, cursor);
  const social = (viewer: Viewer) => readSocial(vault, viewer);
  const generators = (viewer: Viewer) => readGenerators(vault, viewer);
  /**
   * Explicit topic subscription, persisted with the other social settings. Idempotent. The caller checks that the
   * viewer may see the topic. Nothing else happens: no agent, no watch, no publication.
   */
  /** Adds or removes a topic from one of the viewer's explicit topic lists; idempotent. */
  async function setTopicMembership(viewer: Viewer, list: "topics" | "knowledge", topicId: string, member: boolean) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(topicId)) throw invalid("Topic invalide.");
    return withLock(`social:${viewer.id}`, async () => {
      const settings = await readSocial(vault, viewer);
      if (settings[list].includes(topicId) === member) return settings;
      settings[list] = member ? [...settings[list], topicId] : settings[list].filter(id => id !== topicId);
      await writeSocial(vault, viewer, settings);
      return settings;
    });
  }
  const setTopicSubscription = (viewer: Viewer, topicId: string, subscribed: boolean) => setTopicMembership(viewer, "topics", topicId, subscribed);
  /** "Mes connaissances": only this explicit action registers a topic as known. */
  const setTopicKnowledge = (viewer: Viewer, topicId: string, known: boolean) => setTopicMembership(viewer, "knowledge", topicId, known);

  /**
   * Topics declared by the readable, real (non-fixture) publications of these ΞAgents: what they actually published,
   * as opposed to their declared specializations. Counts per agent and topic.
   */
  async function agentContributions(viewerId: string, agentIds: string[]) {
    if (!agentIds.length) return [];
    await ensureIndexed();
    // The viewer's own agents: their private publications are readable by their owner.
    await authorized({ id: viewerId });
    return db.prepare<{ viewer: string; agents: string }, { agent_id: string; topic_id: string; count: number }>(`
      SELECT p.author_id AS agent_id, t.topic_id, COUNT(*) AS count FROM publication p JOIN publication_topic t ON t.publication_id = p.id AND t.origin = 'declared'
      WHERE p.author_type = 'ai' AND p.author_id IN (SELECT value FROM json_each(@agents)) AND p.status = 'published' AND p.test_content = 0 AND ${readablePublicationSql("p")}
      GROUP BY p.author_id, t.topic_id`).all({ viewer: viewerId, agents: JSON.stringify(agentIds) });
  }

  async function setSocial(viewer: Viewer, authorId: string, change: { following?: boolean; preference?: Preference | null }) {
    if (!USER_ID.test(authorId) || (change.preference !== undefined && change.preference !== null && !PREFERENCES.includes(change.preference))) throw invalid("Préférence invalide.");
    return withLock(`social:${viewer.id}`, async () => {
      const settings = await readSocial(vault, viewer);
      if (change.following === true && !settings.following.includes(authorId)) settings.following.push(authorId);
      if (change.following === false) settings.following = settings.following.filter(id => id !== authorId);
      if (change.preference === null) delete settings.preferences[authorId];
      else if (change.preference !== undefined) settings.preferences[authorId] = change.preference;
      await writeSocial(vault, viewer, settings);
      const effective = effectiveSocial(settings, await readGenerators(vault, viewer));
      db.transaction(() => {
        db.prepare("DELETE FROM feed_follow WHERE viewer_id = ?").run(viewer.id);
        const insert = db.prepare("INSERT INTO feed_follow(viewer_id, author_id) VALUES (?, ?)");
        for (const author of effective.following) insert.run(viewer.id, author);
        bumpIndexGeneration(db);
      })();
      return settings;
    });
  }

  async function listTrash(viewer: Viewer): Promise<TrashItem[]> {
    await reconcileUser(viewer.id);
    return index.trash(viewer.id).map((row) => ({
      id: row.id, type: row.type, status: row.status, visibility: row.visibility, excerpt: row.excerpt, trashedAt: row.trashed_at!,
    }));
  }

  /** Public, published, non-fixture publications: the only content topic discovery reads (docs/topic-discovery.md). */
  async function publicPublications() {
    await ensureIndexed();
    return index.all().filter(row => !row.trashed_at && row.status === "published" && row.visibility === "public" && !row.test_content)
      .map(row => ({ id: row.id, revision: row.revision ?? "", authorId: row.author_id, authorType: row.author_type, generatorId: row.generator_id }));
  }
  /** The content of one such publication, or null once it is no longer public (trashed, private, fixture). */
  async function publicContent(id: string) {
    const row = index.get(id);
    if (!row || row.trashed_at || row.status !== "published" || row.visibility !== "public" || row.test_content) return null;
    const folder = await loadLive(id).catch(() => null);
    if (!folder || folder.meta.visibility !== "public" || folder.meta.status !== "published") return null;
    return snapshot(folder);
  }
  const setInferredTopics = (id: string, topics: { topic_id: string; score: number }[]) => index.setInferred(id, topics);
  /** Which of these publications the viewer can read now (same rule as every feed); used before showing evidence. */
  async function readableIds(viewerId: string, ids: string[]) {
    const wanted = ids.filter(id => PUBLICATION_ID.test(id));
    if (!wanted.length) return new Set<string>();
    await ensureIndexed();
    return new Set(db.prepare<{ viewer: string; ids: string }, { id: string }>(`SELECT p.id FROM publication p
      WHERE p.id IN (SELECT value FROM json_each(@ids)) AND p.status = 'published' AND ${readablePublicationSql("p")}`)
      .all({ viewer: viewerId, ids: JSON.stringify(wanted) }).map(row => row.id));
  }

  return { publicPublications, publicContent, setInferredTopics, readableIds, setTopicKnowledge, agentContributions, refreshAccess: authorized, publishGenerated, setTopicSubscription, saveWatchDraft, reviewWatchDraft, publishWatchDraft, retireWatchDraft, agentPublications, ensureIndexed, invalidatePath, conversation, realtimeState, replies, createCorrection, social, setSocial, generators, create, get, getEditable, save, publish, addSource, trash, restore, page, listTrash, reconcileAll };
}

export type PublicationStore = ReturnType<typeof createPublicationStore>;
