import { getAccountStore } from "../accounts/server";
import { getAppDatabase } from "../auth";
import { openVault, vaultPathFromEnv } from "../publications/vault";
import { getTopicStore } from "../topics/server";
import { getLLMRuntime } from "../llm/server";
import { migrateWatchWorker } from "../watch/worker";
import { autoPublishEnabled, getWatchServices, inferenceStatus } from "../watch/server";
import { createDeployments, type Deployments } from "./deployments";

const singleton = globalThis as typeof globalThis & { xiDeployments?: Promise<Deployments>; xiDeploymentsFactory?: typeof createDeployments; xiDeploymentsDeps?: unknown[] };

/** Last pass of the watch worker (null when it never ran). */
export function workerLastTickAt() {
  const db = getAppDatabase();
  migrateWatchWorker(db);
  return (db.prepare("SELECT last_tick_at FROM watch_worker WHERE id = 'worker'").get() as { last_tick_at: number | null } | undefined)?.last_tick_at ?? null;
}

/** Web-side deployment service (same stores as the rest of the application). */
export function getDeployments() {
  // Next dev reloads modules but keeps globalThis: never reuse closures of an older implementation.
  // The stores it holds are compared too: a rebuilt store (e.g. topics) must not be shadowed by an older one.
  const deps = [getAccountStore(), getTopicStore(), getWatchServices()] as const;
  if (process.env.NODE_ENV !== "production" && (singleton.xiDeploymentsFactory !== createDeployments || deps.some((dep, index) => singleton.xiDeploymentsDeps?.[index] !== dep))) {
    singleton.xiDeployments = undefined;
    singleton.xiDeploymentsFactory = createDeployments;
    singleton.xiDeploymentsDeps = [...deps];
  }
  singleton.xiDeployments ??= Promise.all([openVault(vaultPathFromEnv()), ...deps])
    .then(([vault, accounts, topics, { sources, fetch }]) => createDeployments({
      vault, db: getAppDatabase(), accounts, topics, sources, fetch,
      readiness: () => ({ inference: inferenceStatus(), autoPublish: autoPublishEnabled(), workerLastTickAt: workerLastTickAt() }),
      llm: { owns: (owner, instanceId) => !!getLLMRuntime().store.get(owner, instanceId), resolve: (owner, settings) => getLLMRuntime().resolve(owner, settings) },
    }))
    .catch(error => { singleton.xiDeployments = undefined; throw error; });
  return singleton.xiDeployments;
}
