import { getAppDatabase } from "../auth";
import { openVault, vaultPathFromEnv } from "../publications/vault";
import { getPublicationStore } from "../publications/server";
import { createDiscoveryRecords, type DiscoveryRecords } from "./discovery";
import { createTopicRelationStore, type TopicRelationStore } from "./relations";
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

const globalRelations = globalThis as typeof globalThis & { xiTopicRelations?: Promise<TopicRelationStore>; xiTopicRelationsFactory?: typeof createTopicRelationStore; xiTopicRelationsTopics?: unknown };
export function getTopicRelationStore() {
  const topics = getTopicStore();
  // Same dev-reload rule as the topic store: never keep closures over an older implementation or topic store.
  if (process.env.NODE_ENV !== "production" && (globalRelations.xiTopicRelationsFactory !== createTopicRelationStore || globalRelations.xiTopicRelationsTopics !== topics)) {
    globalRelations.xiTopicRelations = undefined;
    globalRelations.xiTopicRelationsFactory = createTopicRelationStore;
    globalRelations.xiTopicRelationsTopics = topics;
  }
  globalRelations.xiTopicRelations ??= Promise.all([openVault(vaultPathFromEnv()), topics, getPublicationStore()]).then(([vault, topics, publications]) => createTopicRelationStore({ vault, db: getAppDatabase(), topics, readable: publications.readableIds })).catch(error => { globalRelations.xiTopicRelations = undefined; throw error; });
  return globalRelations.xiTopicRelations;
}

const globalDiscovery = globalThis as typeof globalThis & { xiDiscovery?: Promise<DiscoveryRecords>; xiDiscoveryFactory?: typeof createDiscoveryRecords };
/** Read side of topic discovery for pages; the analysis itself only runs in the watch worker. */
export function getDiscoveryRecords() {
  if (process.env.NODE_ENV !== "production" && globalDiscovery.xiDiscoveryFactory !== createDiscoveryRecords) {
    globalDiscovery.xiDiscovery = undefined;
    globalDiscovery.xiDiscoveryFactory = createDiscoveryRecords;
  }
  globalDiscovery.xiDiscovery ??= Promise.all([openVault(vaultPathFromEnv()), getTopicStore(), getPublicationStore()])
    .then(([vault, topics, publications]) => createDiscoveryRecords({ vault, topics, publications }))
    .catch(error => { globalDiscovery.xiDiscovery = undefined; throw error; });
  return globalDiscovery.xiDiscovery;
}
