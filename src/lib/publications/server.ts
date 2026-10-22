import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getAppDatabase, getAuth } from "../auth";
import { handleFor } from "../handle";
import { createPublicationStore, PublicationError, type PublicationStore } from "./store";
import type { Viewer } from "./types";
import { openVault, vaultPathFromEnv } from "./vault";
import { watchPublications } from "./runtime";

// One store per server process: its per-publication locks must be shared by every request.
const storeGlobal = globalThis as typeof globalThis & { xiPublications?: Promise<PublicationStore> };

export function getPublicationStore() {
  storeGlobal.xiPublications ??= openVault(vaultPathFromEnv())
    .then((vault) => {
      const store = createPublicationStore({ vault, db: getAppDatabase() });
      watchPublications(vault, store);
      return store;
    })
    .catch((error) => {
      storeGlobal.xiPublications = undefined;
      throw error;
    });
  return storeGlobal.xiPublications;
}

/** The viewer is always the Better Auth session, never a client-supplied identifier. */
export async function getViewer(): Promise<Viewer | null> {
  const session = await getAuth().api.getSession({ headers: await headers() });
  return session ? { id: session.user.id } : null;
}

export type Author = { id: string; name: string; image: string | null; handle: string; description?: string; parentId?: string | null };

export function getAuthors(ids: string[]): Map<string, Author> {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map();
  const rows = getAppDatabase()
    .prepare(`SELECT id, name, image FROM "user" WHERE id IN (${unique.map(() => "?").join(", ")})`)
    .all(...unique) as { id: string; name: string; image: string | null }[];
  return new Map(rows.map((row) => [row.id, { ...row, handle: handleFor(row.id) }]));
}

/** Unreadable or missing publications render as 404 pages; storage failures go to the error boundary. */
export async function orNotFound<T>(load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (error) {
    if (error instanceof PublicationError) notFound();
    throw error;
  }
}

export async function getFeedAuthors(viewer: Viewer, ids: string[]): Promise<Map<string, Author>> {
  const authors = getAuthors(ids);
  for (const generator of await (await getPublicationStore()).generators(viewer)) {
    if (ids.includes(generator.id)) authors.set(generator.id, { ...generator, handle: `@${generator.handle}` });
  }
  return authors;
}
