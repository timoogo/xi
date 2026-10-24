import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getAppDatabase, getAuth } from "../auth";
import { handleFor } from "../handle";
import { createPublicationStore, PublicationError, type PublicationStore } from "./store";
import type { Viewer } from "./types";
import { openVault, vaultPathFromEnv } from "./vault";
import { watchPublications } from "./runtime";

// One store per server process: its per-publication locks must be shared by every request.
const storeGlobal = globalThis as typeof globalThis & {
  xiPublications?: Promise<PublicationStore>; xiPublicationsFactory?: typeof createPublicationStore; xiPublicationsWatcher?: { close(): unknown };
};

export function getPublicationStore() {
  // Next dev reloads modules but keeps globalThis: a store built by older code lacks newer methods
  // (e.g. publishGenerated). Replace it, and stop the watcher it owned.
  if (process.env.NODE_ENV !== "production" && storeGlobal.xiPublicationsFactory !== createPublicationStore) {
    void storeGlobal.xiPublicationsWatcher?.close();
    storeGlobal.xiPublications = undefined;
    storeGlobal.xiPublicationsWatcher = undefined;
    storeGlobal.xiPublicationsFactory = createPublicationStore;
  }
  storeGlobal.xiPublications ??= openVault(vaultPathFromEnv())
    .then((vault) => {
      const store = createPublicationStore({ vault, db: getAppDatabase() });
      storeGlobal.xiPublicationsWatcher = watchPublications(vault, store);
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

export type Author = { bloubSeed?: string | null; ai: boolean; id: string; name: string; image: string | null; handle: string; description?: string; parentId?: string | null };

export function getAuthors(ids: string[]): Map<string, Author> {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map();
  const rows = getAppDatabase()
    .prepare(`SELECT u.id, u.name, u.image, CASE WHEN a.mode = 'bloub' THEN a.seed END AS bloubSeed FROM "user" u LEFT JOIN user_avatar a ON a.user_id = u.id WHERE u.id IN (${unique.map(() => "?").join(", ")})`)
    .all(...unique) as { id: string; name: string; image: string | null; bloubSeed: string | null }[];
  return new Map(rows.map((row) => [row.id, { ...row, ai: false, handle: handleFor(row.id) }]));
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
    if (ids.includes(generator.id)) authors.set(generator.id, { ...generator, image: null, ai: true, handle: `@${generator.handle}` });
  }
  return authors;
}
