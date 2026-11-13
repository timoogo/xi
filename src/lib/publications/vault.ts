import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readdir, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, sep } from "node:path";

/** A vault-relative path always uses "/" so it can be written in Obsidian links. */
export type Vault = { root: string; postsDir: string };

export const USER_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const PUBLICATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const FOLDER_NAME = /^(post|thread)_(\d{8})_(\d{3,})$/;
export const NUMBERED_FILE = /^(\d+)_[a-z0-9_-]+\.md$/;

export class VaultError extends Error {}

// The absolute location is server configuration only: it never leaves this module's callers.
export function vaultPathFromEnv() {
  const value = process.env.XI_VAULT_PATH;
  if (!value || !isAbsolute(value)) throw new VaultError("XI_VAULT_PATH must be an absolute path to the Obsidian vault.");
  return value;
}

/** Opens an existing vault: the vault itself is never created, only its posts/ folder. */
export async function openVault(path: string): Promise<Vault> {
  let root: string;
  try {
    root = await realpath(path);
    if (!(await stat(root)).isDirectory()) throw new Error();
  } catch {
    throw new VaultError("The configured Obsidian vault does not exist.");
  }
  const postsDir = join(root, "posts");
  await mkdir(postsDir, { recursive: false }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  return { root, postsDir };
}

/** Joins validated segments only: no separators, no dot segments, no NUL. */
export function inside(base: string, ...segments: string[]) {
  for (const segment of segments) {
    if (!segment || segment === "." || segment === ".." || /[/\\\0]/.test(segment)) throw new VaultError("Invalid path segment.");
  }
  return join(base, ...segments);
}

/** Resolves symlinks and refuses anything that escapes `base` (itself a resolved path). */
export async function assertWithin(base: string, path: string) {
  const real = await realpath(path);
  if (real !== base && !real.startsWith(base + sep)) throw new VaultError("Path escapes the vault.");
  return real;
}

/** Publications never leave posts/, even through a symlink pointing elsewhere in the vault. */
export function assertInVault(vault: Vault, path: string) {
  return assertWithin(vault.postsDir, path);
}

export function toVaultRelative(vault: Vault, path: string) {
  return path.slice(vault.root.length + 1).split(sep).join("/");
}

export function fromVaultRelative(vault: Vault, relative: string) {
  return inside(vault.root, ...relative.split("/"));
}

/** Write to a hidden temporary sibling, fsync, then rename: readers see the old or the new file, never half of one. */
export async function writeAtomic(path: string, content: string) {
  const temporary = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function exists(path: string) {
  return stat(path).then(() => true, () => false);
}

/**
 * Records (topics, watch sources) keep their identity in the frontmatter `id`; the file name is only for people:
 * `<stem>.md`, `<stem>--<8 first characters of the id>.md` when another file holds the stem. Any such name is read,
 * so a record never depends on its path; dot files (journals, locks, temporaries) are never records.
 */
export const RECORD_FILE = /^[a-z0-9][a-z0-9._-]*\.md$/;
const RECORD_STEM = /^[a-z0-9][a-z0-9._-]{0,119}$/;

/** The frontmatter `id` of a record file, or null for a file that is not a record (e.g. relation-exclusions.md). */
export function recordId(text: string) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  return frontmatter ? /^id:[ \t]*["']?([^\s"']+)["']?[ \t]*$/m.exec(frontmatter)?.[1] ?? null : null;
}

/** id → file name of the records of a directory. Two files claiming one id is refused: a record has one file. */
export async function recordFiles(dir: string) {
  const files = new Map<string, string>();
  for (const entry of await listDir(dir)) {
    if (!entry.isFile() || !RECORD_FILE.test(entry.name)) continue;
    const id = recordId(await readFile(join(dir, entry.name), "utf8"));
    if (!id) continue;
    if (files.has(id)) throw new VaultError(`Deux fichiers pour l’enregistrement ${id} : ${files.get(id)} et ${entry.name}.`);
    files.set(id, entry.name);
  }
  return files;
}

/**
 * Name of a record's file: its current name while it still matches the stem (no churn), else `<stem>.md`, else the
 * suffixed forms. Deterministic for a given directory content. An unusable stem falls back to the id.
 */
export function recordFileName(stem: string, id: string, taken: (name: string) => boolean, current?: string) {
  const base = RECORD_STEM.test(stem) ? stem : id;
  const own = [`${base}.md`, `${base}--${id.slice(0, 8)}.md`, `${base}--${id}.md`];
  if (current && own.includes(current)) return current;
  return own.find(name => !taken(name)) ?? own[2];
}

/**
 * Writes a record under its readable name. A renamed record is moved first, in one rename, then rewritten: at no
 * point do two files hold it. Callers hold the directory's writer lock.
 */
export async function writeRecord(dir: string, id: string, stem: string, content: string) {
  const files = await recordFiles(dir);
  const names = new Set((await listDir(dir)).map(entry => entry.name));
  const current = files.get(id);
  const target = recordFileName(stem, id, name => name !== current && names.has(name), current);
  if (current && current !== target) await rename(join(dir, current), join(dir, target));
  await writeAtomic(join(dir, target), content);
  return target;
}

export async function listDir(path: string) {
  return readdir(path, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
}

/**
 * Reads every Markdown file of a publication once. The revision is hashed from exactly the bytes
 * returned, so a client can never hold content older than the revision it will save against.
 */
export async function readMarkdownTree(dir: string) {
  const files = new Map<string, string>();
  async function walk(current: string, prefix: string) {
    const entries = (await listDir(current)).filter((entry) => !entry.name.startsWith(".")).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path, `${prefix}${entry.name}/`);
      else if (entry.isFile() && entry.name.endsWith(".md")) files.set(`${prefix}${entry.name}`, await readFile(path, "utf8"));
    }
  }
  await walk(dir, "");
  const hash = createHash("sha256");
  for (const [name, content] of files) hash.update(`${name}\0${content}\0`);
  return { files, revision: hash.digest("hex") };
}
