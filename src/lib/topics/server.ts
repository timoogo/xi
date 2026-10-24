import { getAppDatabase } from "../auth";
import { openVault, vaultPathFromEnv } from "../publications/vault";
import { createTopicStore, type TopicStore } from "./store";
const globalStore = globalThis as typeof globalThis & { xiTopics?: Promise<TopicStore>; xiTopicsFactory?: typeof createTopicStore };
export function getTopicStore() {
  // Next dev reloads modules but keeps globalThis: a store built by an older implementation may lack
  // the current API (e.g. `create`), so it is rebuilt — and so are the services holding it (they compare it).
  if (process.env.NODE_ENV !== "production" && globalStore.xiTopicsFactory !== createTopicStore) {
    globalStore.xiTopics = undefined;
    globalStore.xiTopicsFactory = createTopicStore;
  }
  globalStore.xiTopics ??= openVault(vaultPathFromEnv()).then(vault => createTopicStore({ vault, db: getAppDatabase() })).catch(error => { globalStore.xiTopics = undefined; throw error; });
  return globalStore.xiTopics;
}
