import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getAccountStore } from "../src/lib/accounts/server";
import { createAccountStore, type AccountStore } from "../src/lib/accounts/store";
import type { createAuth } from "../src/lib/auth";
import type { TopicStore } from "../src/lib/topics/store";
import { TopicError } from "../src/lib/topics/types";

test("account store discards pre-HMR globals without getOwned and reuses the current implementation", async t => {
  const directory = await mkdtemp(join(tmpdir(), "xi-store-hmr-"));
  const before = { ...process.env };
  const cache = globalThis as typeof globalThis & {
    xiAccounts?: Promise<AccountStore>; xiAccountsFactory?: typeof createAccountStore;
    xiTopics?: Promise<TopicStore>; xiAuth?: ReturnType<typeof createAuth>;
  };
  t.after(async () => {
    cache.xiAuth?.database.close();
    delete cache.xiAccounts; delete cache.xiAccountsFactory; delete cache.xiTopics; delete cache.xiAuth;
    for (const key of ["NODE_ENV", "XI_VAULT_PATH", "AUTH_DATABASE_PATH", "BETTER_AUTH_URL", "BETTER_AUTH_SECRET"]) {
      if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key];
    }
    await rm(directory, { recursive: true, force: true });
  });
  Object.assign(process.env, { NODE_ENV: "development", XI_VAULT_PATH: directory, AUTH_DATABASE_PATH: join(directory, "auth.sqlite"), BETTER_AUTH_URL: "http://localhost:3000", BETTER_AUTH_SECRET: randomBytes(32).toString("hex") });
  // This is the precise state of the already-running dev process before the fix:
  // globalThis survives HMR with the old store API, while the page calls getOwned.
  const legacy = Promise.resolve({ list: async () => [] }) as unknown as Promise<AccountStore>;
  cache.xiAccounts = legacy;
  const current = getAccountStore();
  assert.notEqual(current, legacy);
  assert.equal(getAccountStore(), current);
  const store = await current;
  assert.equal(typeof store.getOwned, "function");
  await assert.rejects(store.getOwned("owner", "e46faaaa-697f-46bd-8c68-f7a00120d0a3"), error => error instanceof TopicError && error.status === 404);
  // A later hot replacement must also invalidate the global, not just this one upgrade.
  cache.xiAccountsFactory = (() => store) as typeof createAccountStore;
  const replaced = getAccountStore();
  assert.notEqual(replaced, current);
  assert.equal(getAccountStore(), replaced);
  await replaced;
  // Production keeps the existing process-wide singleton and its locking semantics.
  Object.assign(process.env, { NODE_ENV: "production" });
  cache.xiAccountsFactory = (() => store) as typeof createAccountStore;
  assert.equal(getAccountStore(), replaced);
});
