import { mkdir, readFile } from "node:fs/promises";
import { Document, parseDocument } from "yaml";
import { parseGenerator } from "../graph/format";
import { assertWithin, inside, listDir, USER_ID, writeAtomic, type Vault } from "./vault";
import { splitFrontmatter } from "./markdown";
import type { Viewer } from "./types";

export const PREFERENCES = ["priority", "normal", "less", "hidden"] as const;
export type Preference = typeof PREFERENCES[number];
export type SocialSettings = { following: string[]; preferences: Record<string, Preference> };
export type GeneratorAccount = { id: string; name: string; image: string | null; handle: string; parentId: string | null; description: string; ownerId: string; visibility: string };

export async function readGenerators(vault: Vault, viewer: Viewer): Promise<GeneratorAccount[]> {
  const dir = inside(vault.root, "generators");
  if (!await assertWithin(vault.root, dir).then(real => real === dir, () => false)) return [];
  const accounts: GeneratorAccount[] = [];
  const slugs = new Set<string>();
  for (const entry of (await listDir(dir)).sort((a,b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const file = inside(dir, entry.name, "index.md");
    if (!await assertWithin(vault.root, file).then(real => real === file, () => false)) continue;
    const parsed = await readFile(file, "utf8").then(parseGenerator, () => null);
    if (!parsed || slugs.has(parsed.generator.slug) || accounts.some(a => a.id === parsed.generator.id)) continue;
    const g = parsed.generator;
    slugs.add(g.slug);
    const image = parsed.doc.get("avatar");
    accounts.push({ id: g.id, name: g.title, handle: g.slug, image: typeof image === "string" && /^https?:\/\//.test(image) ? image : null, parentId: null, description: parsed.description, ownerId: g.ownerId, visibility: g.visibility });
  }
  for (const account of accounts) account.parentId = accounts.filter(a => account.handle.startsWith(a.handle + ".")).sort((a,b) => b.handle.length-a.handle.length)[0]?.id ?? null;
  const visible = new Set<string>();
  for (const a of [...accounts].sort((a,b) => a.handle.length-b.handle.length)) {
    if ((a.visibility === "public" || a.ownerId === viewer.id) && (!a.parentId || visible.has(a.parentId))) visible.add(a.id);
  }
  return accounts.filter(a => visible.has(a.id));
}

export async function readSocial(vault: Vault, viewer: Viewer): Promise<SocialSettings> {
  if (!USER_ID.test(viewer.id)) throw new Error("Utilisateur invalide");
  const path = inside(vault.postsDir, "_users", viewer.id, "feed.md");
  const real = await assertWithin(vault.postsDir, path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  if (real !== null && real !== path) throw new Error("Préférences hors du dossier utilisateur");
  const text = await readFile(path, "utf8").catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return ""; throw e; });
  const doc = parseDocument(splitFrontmatter(text).yaml ?? "{}");
  if (doc.errors.length) throw new Error("Préférences illisibles");
  const raw = doc.toJS() ?? {};
  const following = Array.isArray(raw.following) ? raw.following.filter((id: unknown): id is string => typeof id === "string" && USER_ID.test(id)) : [];
  const preferences: Record<string, Preference> = {};
  for (const [id, pref] of Object.entries(raw.preferences ?? {})) if (USER_ID.test(id) && PREFERENCES.includes(pref as Preference)) preferences[id] = pref as Preference;
  return { following: [...new Set<string>(following)], preferences };
}

export async function writeSocial(vault: Vault, viewer: Viewer, settings: SocialSettings) {
  const dir = inside(vault.postsDir, "_users", viewer.id);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await assertWithin(vault.postsDir, dir);
  await writeAtomic(inside(dir, "feed.md"), `---\n${new Document(settings).toString()}---\n`);
}

export function effectiveSocial(settings: SocialSettings, generators: GeneratorAccount[]) {
  const following = new Set(settings.following);
  const preferences = { ...settings.preferences };
  for (const g of [...generators].sort((a,b) => a.handle.length - b.handle.length)) {
    if (g.parentId && following.has(g.parentId)) following.add(g.id);
    if (g.parentId && preferences[g.id] === undefined && preferences[g.parentId]) preferences[g.id] = preferences[g.parentId];
  }
  return { following, preferences };
}
