import { watch, type FSWatcher } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { PublicationStore } from "./store";
import type { Vault } from "./vault";

/**
 * One watcher per server process, never per request. File events are hints: a periodic
 * reconciliation recovers missed events and a watcher failure never silently disables it.
 */
export function watchPublications(vault: Vault, store: PublicationStore) {
  // One watcher per directory, not `recursive: true`: Node's recursive watcher on Linux
  // stops reporting writes to a file once it has been replaced by an atomic rename,
  // which is how this store writes and how Obsidian edits afterwards would be lost.
  const watchers = new Map<string, FSWatcher>();
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const paths = new Set<string>();
  let chain = Promise.resolve();
  const enqueue = (task: () => Promise<unknown>) => {
    if (closed) return;
    chain = chain.then(() => closed ? undefined : task()).then(() => undefined).catch((error) => {
      // Do not log paths, user content or credentials.
      console.error("Publication reconciliation failed", error instanceof Error ? error.name : "unknown");
    });
  };
  const flush = () => {
    debounce = undefined;
    const changed = [...paths];
    paths.clear();
    enqueue(async () => {
      for (const path of changed) await store.invalidatePath(path);
    });
  };
  const watched = (path: string) => /^(posts|generators|relations)(\/|$)/.test(path);
  const unwatch = (dir: string) => {
    for (const [path, watcher] of watchers) {
      if (path === dir || path.startsWith(dir + sep)) { watcher.close(); watchers.delete(path); }
    }
  };
  const watchTree = async (dir: string): Promise<void> => {
    if (closed) return;
    if (!watchers.has(dir)) {
      try {
        const watcher = watch(dir, { persistent: false }, (event, filename) => {
          if (!filename) return enqueue(() => store.reconcileAll());
          const absolute = join(dir, filename.toString());
          const path = relative(vault.root, absolute).split(sep).join("/");
          if (!watched(path) || path.endsWith(".tmp")) return;
          // A new directory gets its own watcher; files written before it existed are
          // covered by the directory's own invalidation, which re-reads its publication.
          if (event === "rename") void stat(absolute).then((info) => info.isDirectory() ? watchTree(absolute) : undefined, () => unwatch(absolute));
          paths.add(path);
          if (!debounce) {
            debounce = setTimeout(flush, 100);
            debounce.unref();
          }
        });
        watcher.on("error", () => unwatch(dir));
        watchers.set(dir, watcher);
      } catch {
        return;
      }
    }
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => {
      const child = join(dir, entry.name);
      return watched(relative(vault.root, child).split(sep).join("/")) ? watchTree(child) : undefined;
    }));
  };
  // The root watcher only matters for posts/, generators/ and relations/ appearing later.
  const connect = () => void watchTree(vault.root).catch(() => {
    console.error("Publication watcher unavailable; periodic reconciliation remains active");
  });
  connect();
  const interval = setInterval(() => {
    connect();
    enqueue(() => store.reconcileAll());
  }, 60_000);
  interval.unref();
  return {
    /** Tests and controlled shutdown can release all resources. */
    close() {
      closed = true;
      unwatch(vault.root);
      clearInterval(interval);
      if (debounce) clearTimeout(debounce);
      paths.clear();
      return chain;
    },
    async invalidate(absolutePath: string) {
      await store.invalidatePath(relative(vault.root, absolutePath));
    },
  };
}
