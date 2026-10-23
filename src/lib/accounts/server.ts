import { getAppDatabase } from "../auth";
import { openVault, vaultPathFromEnv } from "../publications/vault";
import { getTopicStore } from "../topics/server";
import { createAccountStore, type AccountStore } from "./store";
const singleton = globalThis as typeof globalThis & { xiAccounts?: Promise<AccountStore> };
export function getAccountStore() {
  singleton.xiAccounts ??= Promise.all([openVault(vaultPathFromEnv()), getTopicStore()]).then(([vault, topics]) => createAccountStore({ vault, topics, db: getAppDatabase() })).catch(error => { singleton.xiAccounts = undefined; throw error; });
  return singleton.xiAccounts;
}
