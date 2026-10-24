import { getAppDatabase } from "../auth";
import { openVault, vaultPathFromEnv } from "../publications/vault";
import { getTopicStore } from "../topics/server";
import type { InferenceStatus } from "./diagnostics";
import { createLocalInference, inferenceConfigFromEnv } from "./inference";
import { createPoliteFetch, createSafeFetch, type PoliteFetch } from "./net";
import { createSourceStore, type SourceStore } from "./sources";

type WatchServices = { sources: SourceStore; fetch: PoliteFetch };
const singleton = globalThis as typeof globalThis & { xiWatch?: Promise<WatchServices>; xiWatchFactory?: typeof createSourceStore; xiWatchTopics?: unknown };

/** Web-side services; the worker builds its own with the same factories. */
export function getWatchServices() {
  // Next dev reloads modules but keeps globalThis: never reuse closures of an older implementation.
  const topics = getTopicStore();
  if (process.env.NODE_ENV !== "production" && (singleton.xiWatchFactory !== createSourceStore || singleton.xiWatchTopics !== topics)) {
    singleton.xiWatch = undefined;
    singleton.xiWatchFactory = createSourceStore;
    singleton.xiWatchTopics = topics;
  }
  singleton.xiWatch ??= Promise.all([openVault(vaultPathFromEnv()), topics])
    .then(([vault, topics]) => ({ sources: createSourceStore({ vault, topics }), fetch: createPoliteFetch({ db: getAppDatabase(), fetch: createSafeFetch() }) }))
    .catch(error => { singleton.xiWatch = undefined; throw error; });
  return singleton.xiWatch;
}

/** Automatic publication stays off until the engine's tests are complete. */
export const autoPublishEnabled = () => process.env.XI_WATCH_AUTOPUBLISH === "true";
/** Public automatic publication needs this second operator flag, on top of the agent's confirmation. */
export const publicPublishingEnabled = () => autoPublishEnabled() && process.env.XI_WATCH_AUTOPUBLISH_PUBLIC === "true";

/** What the web page can say about the worker's local inference (same environment file). */
export function inferenceStatus(): InferenceStatus {
  try {
    const config = inferenceConfigFromEnv();
    if (!config) return { configured: false, model: null, error: null };
    createLocalInference(config);
    return { configured: true, model: config.defaultModel, error: null };
  } catch (error) {
    return { configured: false, model: null, error: error instanceof Error ? error.message : "Configuration refusée." };
  }
}
