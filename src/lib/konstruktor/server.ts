import { getAccountStore } from "../accounts/server";
import { getAppDatabase } from "../auth";
import { getSystemTasks } from "../system-agents/server";
import { getLLMRuntime } from "../llm/server";
import { getTopicStore } from "../topics/server";
import { getWatchServices } from "../watch/server";
import { getDeployments } from "../xiagents/services";
import { modelChoices } from "./context";
import { createKonstruktor, type Konstruktor } from "./service";

const singleton = globalThis as typeof globalThis & { xiKonstruktor?: Promise<Konstruktor>; xiKonstruktorFactory?: typeof createKonstruktor };
export function getKonstruktor() {
  if (process.env.NODE_ENV !== "production" && singleton.xiKonstruktorFactory !== createKonstruktor) {
    singleton.xiKonstruktor = undefined;
    singleton.xiKonstruktorFactory = createKonstruktor;
  }
  singleton.xiKonstruktor ??= Promise.all([getSystemTasks(), getAccountStore(), getTopicStore(), getWatchServices(), getDeployments()])
    .then(([tasks, accounts, topics, { sources }, deployments]) => createKonstruktor({ db: getAppDatabase(), tasks, accounts, topics, sources, deployments, models: owner => modelChoices(getLLMRuntime().store, owner) }))
    .catch(error => { singleton.xiKonstruktor = undefined; throw error; });
  return singleton.xiKonstruktor;
}
