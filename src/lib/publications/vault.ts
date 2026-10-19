import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readdir, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, sep } from "node:path";

/** A vault-relative path always uses "/" so it can be written in Obsidian links. */
export type Vault = { root: string; postsDir: string };

export const USER_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const PUBLICATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const FOLDER_NAME = /^(post|thread)_(\d{8})_(\d{3,})$/;
export const NUMBERED_FILE = /^(\d+)_[a-z0-9_]+\.md$/;

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
