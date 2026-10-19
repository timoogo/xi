import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type Database from "better-sqlite3";
import { Document } from "yaml";
import { z } from "zod";
import { createIndex, type IndexRow, type MessageRow } from "./index-db";
import {
  excerpt, hasContent, messageEmbedTarget, messageSlug, parseIndex, parseSource, rewriteFolderLinks, serializeIndex,
  serializeSource, setMeta, slugify, sourceLinkLine, splitIndexBody,
} from "./markdown";
import { canEdit, canManageTrash, canRead } from "./permissions";
import {
  VISIBILITIES, type PublicationMeta, type PublicationSnapshot, type TrashItem, type Viewer,
} from "./types";
import {
  assertInVault, exists, FOLDER_NAME, fromVaultRelative, inside, listDir, NUMBERED_FILE, PUBLICATION_ID, readMarkdownTree,
  toVaultRelative, USER_ID, writeAtomic, type Vault,
} from "./vault";

export class PublicationError extends Error {
  constructor(readonly code: "not_found" | "invalid", message: string) {
    super(message);
  }
}

// Unreadable and nonexistent publications are indistinguishable to callers.
const notFound = () => new PublicationError("not_found", "Publication introuvable.");
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
  messages: { file: string; body: string }[];
  sources: PublicationSnapshot["sources"];
  numbered: string[];
  revision: string;
  indexMtime: number;
};

type TrashInfo = { id: string; folder: string; originalPath: string; trashedAt: string };

export type FeedScope = { kind: "home" } | { kind: "own" } | { kind: "author"; authorId: string };
export type FeedPage = { items: PublicationSnapshot[]; nextCursor: string | null };

const encodeCursor = (value: [string, string]) => Buffer.from(JSON.stringify(value)).toString("base64url");
function decodeCursor(cursor?: string | null): [string, string] | null {
  if (!cursor) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && PUBLICATION_ID.test(String(value[1]))) return [value[0], value[1]];
  } catch { /* An invalid cursor starts from the newest publications. */ }
  return null;
}

/**
 * Re-parse gate of a live folder: index.md's mtime, or the folder's own when later. The folder's mtime moves when a
 * file is created, deleted or renamed in it (a message file removed in Obsidian, every atomic write), so a deleted
 * message never lingers in the index (and in the graph) while index.md is untouched.
 */
async function folderMtime(dir: string) {
  const [index, folder] = await Promise.all([stat(inside(dir, "index.md")), stat(dir)]);
  return Math.max(index.mtimeMs, folder.mtimeMs);
}

const byNumber = (a: string, b: string) => parseInt(a, 10) - parseInt(b, 10) || a.localeCompare(b);
const maxNumber = (files: string[]) => Math.max(0, ...files.map((file) => parseInt(file, 10)));

export function createPublicationStore({ vault, db, now = () => new Date() }: { vault: Vault; db: Database.Database; now?: () => Date }) {
  const index = createIndex(db);
  const usersDir = inside(vault.postsDir, "_users");
  const trashDir = inside(vault.postsDir, ".trash");
  const locks = new Map<string, Promise<unknown>>();
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
        return { file, title: source.title ?? file.replace(/\.md$/, ""), url: source.url, publisher: source.publisher };
      });
    return {
      dir, doc: parsed.doc, meta: parsed.meta, generatorId: parsed.generatorId, summary, sources, numbered, revision: tree.revision, indexMtime,
      messages: order.map((file) => ({ file, body: tree.files.get(file)! })),
    };
  }

  // A folder only counts if its location and its frontmatter agree on the author.
  function owned(folder: Folder | null, userId: string, id?: string): folder is Folder {
    return !!folder && folder.meta.authorType === "human" && folder.meta.authorId === userId && (!id || folder.meta.id === id);
  }

  function toRow(folder: Folder, trash?: TrashInfo): IndexRow {
    const { meta } = folder;
    return {
      id: meta.id, author_type: meta.authorType, author_id: meta.authorId, type: meta.type, status: meta.status,
      visibility: meta.visibility, path: rel(folder.dir), original_path: trash?.originalPath ?? null,
      trashed_at: trash?.trashedAt ?? null, created_at: meta.createdAt, updated_at: meta.updatedAt,
      published_at: meta.publishedAt, score: meta.score, excerpt: excerpt(folder.summary || folder.messages[0]?.body || ""),
      generator_id: folder.generatorId, index_mtime: folder.indexMtime,
    };
  }

  /** Thread order gives positions; a number used twice (external edit) keeps its first message only, refs stay unambiguous. */
  function messageRows(folder: Folder): MessageRow[] {
    const rows: MessageRow[] = [];
    const used = new Set<number>();
    for (const message of folder.messages) {
      const n = parseInt(message.file, 10);
      if (used.has(n)) continue;
      used.add(n);
      rows.push({ publication_id: folder.meta.id, n, file: message.file, position: rows.length + 1, excerpt: excerpt(message.body) });
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
      index.upsert(toRow(folder, trash), messageRows(folder));
    };
    const live = userDir(userId);
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
      if (owned(folder, userId)) accept(folder);
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
    for (const base of [usersDir, trashDir]) {
      for (const entry of await listDir(base)) if (entry.isDirectory() && USER_ID.test(entry.name)) users.add(entry.name);
    }
    for (const userId of users) await reconcileUser(userId);
  }

  async function locate(id: string) {
    if (!PUBLICATION_ID.test(id)) throw notFound();
    const row = index.get(id);
    if (row) await reconcileUser(row.author_id);
    else await reconcileAll();
    const current = index.get(id);
    if (!current) throw notFound();
    return current;
  }

  async function loadLive(id: string) {
    const row = await locate(id);
    if (row.trashed_at) throw notFound();
    const folder = await readFolder(fromVaultRelative(vault, row.path));
    if (!owned(folder, row.author_id, id)) throw notFound();
    return folder;
  }

  async function loadEditable(viewer: Viewer, id: string) {
    const folder = await loadLive(id);
    if (!canEdit(viewer, folder.meta)) throw notFound();
    return folder;
  }

  function snapshot(folder: Folder): PublicationSnapshot {
    return { ...folder.meta, summary: folder.summary, messages: folder.messages, sources: folder.sources, revision: folder.revision };
  }

  async function writeIndex(folder: Folder, meta: PublicationMeta, summary: string, order: string[]) {
    setMeta(folder.doc, meta);
    const folderPath = rel(folder.dir);
    await writeAtomic(inside(folder.dir, "index.md"), serializeIndex(folder.doc, summary, order.map((file) => messageEmbedTarget(folderPath, file))));
  }

  async function reindex(dir: string, trash?: TrashInfo) {
    const folder = await readFolder(dir);
    if (!folder) throw invalid("La publication n’a pas pu être relue.");
    index.upsert(toRow(folder, trash), messageRows(folder));
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

  async function create(viewer: Viewer) {
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
      await writeAtomic(inside(dir, "index.md"), serializeIndex(doc, "", []));
      return (await reindex(dir)).meta.id;
    });
  }

  async function get(viewer: Viewer, id: string) {
    const folder = await loadLive(id);
    if (!canRead(viewer, folder.meta)) throw notFound();
    return snapshot(folder);
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
        const body = fix(message.body);
        const file = message.file ?? `${next++}_${messageSlug(body)}.md`;
        if (onDisk.get(file) !== body) await writeAtomic(inside(folder.dir, file), body);
        files[message.key] = file;
        order.push(file);
      }
      for (const file of onDisk.keys()) {
        if (order.includes(file)) continue;
        await mkdir(removedDir, { recursive: true, mode: 0o700 });
        await rename(inside(folder.dir, file), inside(removedDir, `${Date.now()}_${file}`));
      }
      await writeIndex(folder, { ...folder.meta, type, visibility: input.visibility, updatedAt: now().toISOString() }, fix(input.summary), order);
      return { ok: true, snapshot: snapshot(await reindex(folder.dir)), files, relocated };
    });
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
      const sourcesDir = inside(folder.dir, "_sources");
      await mkdir(sourcesDir, { recursive: true, mode: 0o700 });
      const file = `${maxNumber(folder.sources.map((item) => item.file)) + 1}_${slugify(source.title, "source")}.md`;
      await writeAtomic(inside(sourcesDir, file), serializeSource(source, now().toISOString().slice(0, 10)));
      const updated = (await readFolder(folder.dir))!;
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
   * One page of full publications, newest publication date first. "home": published, the viewer's own
   * plus public ones; "author": one author's published ones; "own": the viewer's drafts and published.
   * Each item is re-read from its files and re-checked, so a stale index can never widen access.
   */
  async function page(viewer: Viewer, scope: FeedScope, cursor?: string | null, limit = 20): Promise<FeedPage> {
    const before = decodeCursor(cursor);
    const author = scope.kind === "home" ? null : scope.kind === "own" ? viewer.id : scope.authorId;
    if (author === null) await reconcileAll();
    else await reconcileUser(author);
    const rows = index.page({
      viewer: viewer.id, drafts: scope.kind === "own" ? 1 : 0, author,
      before: before?.[0] ?? null, beforeId: before?.[1] ?? null, limit: Math.min(Math.max(limit, 1), 50) + 1,
    });
    const more = rows.length > limit;
    const items: PublicationSnapshot[] = [];
    for (const row of rows.slice(0, limit)) {
      const folder = await readFolder(fromVaultRelative(vault, row.path));
      if (owned(folder, row.author_id, row.id) && canRead(viewer, folder.meta)) items.push(snapshot(folder));
    }
    const last = rows[limit - 1];
    return { items, nextCursor: more && last ? encodeCursor([last.published_at ?? last.updated_at, last.id]) : null };
  }

  async function listTrash(viewer: Viewer): Promise<TrashItem[]> {
    await reconcileUser(viewer.id);
    return index.trash(viewer.id).map((row) => ({
      id: row.id, type: row.type, status: row.status, visibility: row.visibility, excerpt: row.excerpt, trashedAt: row.trashed_at!,
    }));
  }

  return { create, get, getEditable, save, publish, addSource, trash, restore, page, listTrash, reconcileAll };
}

export type PublicationStore = ReturnType<typeof createPublicationStore>;
