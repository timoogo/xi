import { getAppDatabase } from "../auth";
import { openVault, vaultPathFromEnv } from "../publications/vault";
import { getAccountStore } from "../accounts/server";
import { getLLMRuntime } from "../llm/server";
import { getTopicStore } from "../topics/server";
import { getWatchServices } from "../watch/server";
import { bindSafely } from "../watch/llm-binding";
import { inferenceConcurrency } from "../watch/orchestrator";
import { modelChoices } from "../konstruktor/context";
import { createSystemAgentStore, type SystemAgentStore } from "./store";
import { createSystemTasks, type SystemTasks } from "./tasks";

const singleton = globalThis as typeof globalThis & { xiSystemAgents?: Promise<SystemAgentStore>; xiSystemAgentsFactory?: typeof createSystemAgentStore };

export function getSystemAgentStore() {
  // Next dev reloads modules but keeps globalThis: never reuse closures of an older implementation.
  if (process.env.NODE_ENV !== "production" && singleton.xiSystemAgentsFactory !== createSystemAgentStore) {
    singleton.xiSystemAgents = undefined;
    singleton.xiSystemAgentsFactory = createSystemAgentStore;
  }
  singleton.xiSystemAgents ??= openVault(vaultPathFromEnv()).then(vault => createSystemAgentStore({ vault, db: getAppDatabase() }))
    .catch(error => { singleton.xiSystemAgents = undefined; throw error; });
  return singleton.xiSystemAgents;
}

const tasksSingleton = globalThis as typeof globalThis & { xiSystemTasks?: Promise<SystemTasks>; xiSystemTasksFactory?: typeof createSystemTasks };
/**
 * Web-side runner of the system agents' tasks: requested tasks start at once in this process. The
 * worker drains the same queue (watch-worker.ts) and resumes what this process could not finish.
 * XI_WATCH_DISABLED=true stops both: requests then wait.
 */
export function getSystemTasks() {
  if (process.env.NODE_ENV !== "production" && tasksSingleton.xiSystemTasksFactory !== createSystemTasks) {
    tasksSingleton.xiSystemTasks = undefined;
    tasksSingleton.xiSystemTasksFactory = createSystemTasks;
  }
  tasksSingleton.xiSystemTasks ??= Promise.all([getSystemAgentStore(), getAccountStore(), getTopicStore(), getWatchServices()]).then(([store, accounts, topics, { sources }]) => createSystemTasks({
    db: getAppDatabase(), store, services: { accounts, topics, sources, models: owner => modelChoices(getLLMRuntime().store, owner) }, llm: owner => bindSafely(user => getLLMRuntime().bind(user, null), owner),
    inferenceConcurrency: inferenceConcurrency(), autorun: process.env.XI_WATCH_DISABLED !== "true",
  })).catch(error => { tasksSingleton.xiSystemTasks = undefined; throw error; });
  return tasksSingleton.xiSystemTasks;
}
