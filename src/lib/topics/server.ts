import { getAppDatabase } from "../auth";
import { openVault, vaultPathFromEnv } from "../publications/vault";
import { createTopicStore, type TopicStore } from "./store";
const globalStore = globalThis as typeof globalThis & { xiTopics?: Promise<TopicStore> };
export function getTopicStore() {
  globalStore.xiTopics ??= openVault(vaultPathFromEnv()).then(vault => createTopicStore({ vault, db: getAppDatabase() })).catch(error => { globalStore.xiTopics = undefined; throw error; });
  return globalStore.xiTopics;
}
