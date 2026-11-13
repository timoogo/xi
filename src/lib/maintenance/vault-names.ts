// One-off renaming of an existing vault to the readable names that new files already get:
// topics `<tag>.md`, watch sources `<address>.md`, message and source files `<n>_<descriptive_slug>.md`.
// Identities never change: they stay in the frontmatter (`id`) and in message numbers (`<publication>/<n>`).
// Run with the app and the worker stopped: a plan (dry run) first, then `apply`, which backs up the vault and the
// database before touching anything. Idempotent: a second run plans nothing.

import { cp, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type Database from "better-sqlite3";
import { parse } from "yaml";
import { messageSlug, parseSource, slugify } from "../publications/markdown";
import {
  exists, FOLDER_NAME, listDir, NUMBERED_FILE, readMarkdownTree, recordFileName, recordFiles, writeAtomic,
} from "../publications/vault";
import { locked } from "../topics/lock";
import { sourceStem } from "../watch/sources";

export type Rename = { kind: "topic" | "source" | "message" | "publication-source"; from: string; to: string };
export type FolderPlan = { folder: string; publication: string; renames: Rename[] };
export type VaultNamesPlan = { records: Rename[]; folders: FolderPlan[]; problems: string[] };
/** Journal of an applied folder: lets a rerun finish the database remap even after an interruption. */
type Journal = { folders: { folder: string; publication: string; from: string; to: string }[] };

const JOURNAL = ".xi-vault-names.json";
const frontmatter = (text: string) => { const yaml = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1]; return yaml ? parse(yaml) as Record<string, unknown> : {}; };

/** Record directories: shared topics, each owner's personal topics, watch sources. */
async function recordDirs(root: string) {
  const dirs: { dir: string; stem: (data: Record<string, unknown>) => string | null; kind: Rename["kind"] }[] = [];
  const tag = (data: Record<string, unknown>) => typeof data.tag === "string" ? data.tag : null;
  dirs.push({ dir: join(root, "topics"), stem: tag, kind: "topic" });
  for (const entry of await listDir(join(root, ".xi-personal-topics"))) if (entry.isDirectory()) dirs.push({ dir: join(root, ".xi-personal-topics", entry.name), stem: tag, kind: "topic" });
  dirs.push({ dir: join(root, "watch", "sources"), stem: data => { try { return typeof data.url === "string" ? sourceStem(data.url) : null; } catch { return null; } }, kind: "source" });
  return dirs;
}

/** Renames of one record directory, in creation order so collisions are settled the same way on every run. */
async function planRecords(root: string, dir: string, stemOf: (data: Record<string, unknown>) => string | null, kind: Rename["kind"], problems: string[]) {
  let files: Map<string, string>;
  try { files = await recordFiles(dir); } catch (error) { problems.push(`${relative(root, dir)} : ${(error as Error).message}`); return []; }
  const names = new Set((await listDir(dir)).map(entry => entry.name));
  const records = await Promise.all([...files].map(async ([id, file]) => ({ id, file, data: frontmatter(await readFile(join(dir, file), "utf8")) })));
  records.sort((a, b) => String(a.data.createdAt ?? "").localeCompare(String(b.data.createdAt ?? "")) || a.id.localeCompare(b.id));
  const renames: Rename[] = [];
  for (const record of records) {
    const stem = stemOf(record.data);
    if (!stem) { problems.push(`${relative(root, join(dir, record.file))} : nom lisible indéterminable, conservé.`); continue; }
    const target = recordFileName(stem, record.id, name => name !== record.file && names.has(name), record.file);
    if (target === record.file) continue;
    names.delete(record.file); names.add(target);
    renames.push({ kind, from: relative(root, join(dir, record.file)), to: relative(root, join(dir, target)) });
  }
  return renames;
}

/** Live publication folders (trash excluded: a restored publication keeps the names it was trashed with). */
async function publicationFolders(root: string) {
  const folders: string[] = [];
  for (const base of ["_users", "_generators"]) for (const author of await listDir(join(root, "posts", base))) {
    if (!author.isDirectory() || author.name.startsWith(".")) continue;
    for (const entry of await listDir(join(root, "posts", base, author.name))) if (entry.isDirectory() && FOLDER_NAME.test(entry.name)) folders.push(join(root, "posts", base, author.name, entry.name));
  }
  return folders.sort();
}

/** Message and source files whose name is not the descriptive slug of their content. Numbers never change. */
async function planFolder(root: string, dir: string): Promise<FolderPlan | null> {
  const { files } = await readMarkdownTree(dir);
  const publication = frontmatter(files.get("index.md") ?? "").id;
  if (typeof publication !== "string") return null;
  const renames: Rename[] = [];
  for (const [name, content] of files) {
    const inSources = name.startsWith("_sources/"), file = inSources ? name.slice(9) : name;
    if ((!inSources && name.includes("/")) || !NUMBERED_FILE.test(file)) continue;
    const n = parseInt(file, 10);
    const target = `${n}_${inSources ? slugify(parseSource(content).title ?? "", "source") : messageSlug(content)}.md`;
    if (target === file) continue;
    const to = inSources ? `_sources/${target}` : target;
    if (files.has(to)) continue;
    renames.push({ kind: inSources ? "publication-source" : "message", from: name, to });
  }
  return renames.length ? { folder: relative(root, dir), publication, renames } : null;
}

export async function planVaultNames(root: string): Promise<VaultNamesPlan> {
  const problems: string[] = [];
  const records: Rename[] = [];
  for (const { dir, stem, kind } of await recordDirs(root)) records.push(...await planRecords(root, dir, stem, kind, problems));
  const folders: FolderPlan[] = [];
  for (const dir of await publicationFolders(root)) {
    const plan = await planFolder(root, dir).catch((error: Error) => { problems.push(`${relative(root, dir)} : ${error.message}`); return null; });
    if (plan) folders.push(plan);
  }
  return { records, folders, problems };
}

/** Obsidian links inside a folder name files by vault path: `[[<folder>/<file>]]`, `[[…|alias]]`, `[[…#heading]]`. */
export function rewriteFileLinks(text: string, folder: string, renames: Rename[]) {
  return renames.reduce((result, { from, to }) => result.replace(
    new RegExp(`\\[\\[${escape(`${folder}/${from.replace(/\.md$/, "")}`)}(?=[\\]|#])`, "g"),
    `[[${folder}/${to.replace(/\.md$/, "")}`,
  ), text);
}
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Renames one folder's files on a hidden copy, then swaps it in: an interruption leaves either the old folder or the
 * new one (and `recoverFolders` finishes a swap left half-way). Returns the old and new revisions.
 */
async function applyFolder(root: string, plan: FolderPlan) {
  const dir = join(root, plan.folder), parent = join(dir, ".."), name = plan.folder.split("/").at(-1)!;
  const before = (await readMarkdownTree(dir)).revision;
  const staged = join(parent, `.${name}.renaming`), old = join(parent, `.${name}.previous`);
  await rm(staged, { recursive: true, force: true });
  await cp(dir, staged, { recursive: true, preserveTimestamps: true });
  for (const item of plan.renames) await rename(join(staged, item.from), join(staged, item.to));
  for (const [file, content] of (await readMarkdownTree(staged)).files) {
    const updated = rewriteFileLinks(content, plan.folder, plan.renames);
    if (updated !== content) await writeAtomic(join(staged, ...file.split("/")), updated);
  }
  const after = (await readMarkdownTree(staged)).revision;
  await rename(dir, old);
  await rename(staged, dir);
  await rm(old, { recursive: true, force: true });
  return { before, after };
}

/** Finishes a swap interrupted between its two renames; drops abandoned staging copies. */
async function recoverFolders(root: string) {
  for (const base of ["_users", "_generators"]) for (const author of await listDir(join(root, "posts", base))) {
    if (!author.isDirectory()) continue;
    const parent = join(root, "posts", base, author.name);
    const names = new Set((await listDir(parent)).map(entry => entry.name));
    for (const entry of names) {
      const match = /^\.(.+)\.(renaming|previous)$/.exec(entry);
      if (!match || !FOLDER_NAME.test(match[1])) continue;
      const live = names.has(match[1]);
      if (match[2] === "previous") {
        if (live) await rm(join(parent, entry), { recursive: true, force: true });
        else if (names.has(`.${match[1]}.renaming`)) { await rename(join(parent, `.${match[1]}.renaming`), join(parent, match[1])); names.add(match[1]); await rm(join(parent, entry), { recursive: true, force: true }); }
        else { await rename(join(parent, entry), join(parent, match[1])); names.add(match[1]); }
      } else if (live && !names.has(`.${match[1]}.previous`)) await rm(join(parent, entry), { recursive: true, force: true });
    }
  }
}

async function readJournal(root: string): Promise<Journal> {
  try { return JSON.parse(await readFile(join(root, JOURNAL), "utf8")) as Journal; } catch { return { folders: [] }; }
}

/**
 * Knowledge learned by Konstruktor is tied to a publication revision, and a revision hashes file names: a pure rename
 * would hide it until a reanalysis. Content is unchanged, so the learned rows follow the new revision.
 */
function remapRevisions(db: Database.Database, journal: Journal) {
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'xi_agent_knowledge'").get();
  if (!table) return 0;
  const update = db.prepare("UPDATE xi_agent_knowledge SET revision = ? WHERE publication = ? AND revision = ?");
  let changed = 0;
  db.transaction(() => { for (const item of journal.folders) changed += update.run(item.to, item.publication, item.from).changes; })();
  return changed;
}

export type VaultNamesResult = { plan: VaultNamesPlan; backup: { vault: string; database: string | null }; knowledge: number };

/** Applies the plan after a full backup of the vault (and of the database when given). Never overwrites a file. */
export async function applyVaultNames(root: string, { db, backupDir }: { db?: Database.Database; backupDir: string }): Promise<VaultNamesResult> {
  if (await exists(backupDir)) throw new Error(`Sauvegarde déjà présente : ${backupDir}. Choisissez un autre dossier.`);
  const outside = relative(root, backupDir);
  if (outside !== ".." && !outside.startsWith("../")) throw new Error("La sauvegarde doit être hors du vault.");
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  const vaultCopy = join(backupDir, "vault");
  await cp(root, vaultCopy, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false });
  let databaseCopy: string | null = null;
  if (db) { databaseCopy = join(backupDir, "xi-auth.sqlite"); await db.backup(databaseCopy); }

  const topicsDir = join(root, "topics"), watchDir = join(root, "watch"), locksDir = join(root, ".xi-locks");
  for (const dir of [topicsDir, watchDir, locksDir]) await mkdir(dir, { recursive: true, mode: 0o700 });
  const plan = await locked(topicsDir, () => locked(watchDir, () => locked(locksDir, async () => {
    await recoverFolders(root);
    const current = await planVaultNames(root);
    for (const item of current.records) {
      const from = join(root, item.from), to = join(root, item.to);
      if (await stat(to).then(() => true, () => false)) { current.problems.push(`${item.to} existe déjà : ${item.from} conservé.`); continue; }
      await rename(from, to);
    }
    const journal = await readJournal(root);
    for (const folder of current.folders) {
      const { before, after } = await applyFolder(root, folder);
      journal.folders.push({ folder: folder.folder, publication: folder.publication, from: before, to: after });
      await writeAtomic(join(root, JOURNAL), `${JSON.stringify(journal, null, 2)}\n`);
    }
    return current;
  })));
  const knowledge = db ? remapRevisions(db, await readJournal(root)) : 0;
  return { plan, backup: { vault: vaultCopy, database: databaseCopy }, knowledge };
}
