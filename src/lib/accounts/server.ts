import { getAppDatabase } from "../auth";
import { openVault, vaultPathFromEnv } from "../publications/vault";
import { getTopicStore } from "../topics/server";
import { createAccountStore, type AccountStore } from "./store";
const singleton = globalThis as typeof globalThis & { xiAccounts?: Promise<AccountStore>; xiAccountsFactory?: typeof createAccountStore; xiAccountsTopics?: unknown };
export function getAccountStore() {
  // Next dev reloads modules, but globalThis survives. Never reuse closures from
  // an older store implementation (which may not even expose the current API).
  const topics = getTopicStore();
  if (process.env.NODE_ENV !== "production" && (singleton.xiAccountsFactory !== createAccountStore || singleton.xiAccountsTopics !== topics)) {
    singleton.xiAccounts = undefined;
    singleton.xiAccountsFactory = createAccountStore;
    singleton.xiAccountsTopics = topics;
  }
  singleton.xiAccounts ??= Promise.all([openVault(vaultPathFromEnv()), topics]).then(([vault, topics]) => createAccountStore({ vault, topics, db: getAppDatabase() })).catch(error => { singleton.xiAccounts = undefined; throw error; });
  return singleton.xiAccounts;
}
