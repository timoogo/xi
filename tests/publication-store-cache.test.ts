import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getAccountStore } from "../src/lib/accounts/server";
import type { AccountStore, createAccountStore } from "../src/lib/accounts/store";
import type { createAuth } from "../src/lib/auth";
import { getGraphService } from "../src/lib/graph/server";
import type { GraphService } from "../src/lib/graph/service";
import { getPublicationStore } from "../src/lib/publications/server";
import { PublicationError, type createPublicationStore, type PublicationStore } from "../src/lib/publications/store";
import { getTopicStore } from "../src/lib/topics/server";
import type { TopicStore } from "../src/lib/topics/store";
import { TopicError } from "../src/lib/topics/types";
import { manualPublication } from "../src/lib/xiagents/manual-publication";

/**
 * Regression: a `next dev` process started before the ΞAgent generator kept, across hot reloads,
 * a publication store without `publishGenerated`; the manual publication route then failed with
 * "TypeError: publications.publishGenerated is not a function" (HTTP 503 "Comptes indisponibles").
 */
test("publication store discards pre-HMR globals; manual public publication from an existing ΞAgent works", async t => {
  const directory = await mkdtemp(join(tmpdir(), "xi-publications-hmr-"));
  const before = { ...process.env };
  const cache = globalThis as typeof globalThis & {
    xiPublications?: Promise<PublicationStore>; xiPublicationsFactory?: typeof createPublicationStore; xiPublicationsWatcher?: { close(): unknown };
    xiGraph?: Promise<GraphService>; xiGraphStore?: Promise<PublicationStore>;
    xiAccounts?: Promise<AccountStore>; xiAccountsFactory?: typeof createAccountStore; xiTopics?: Promise<TopicStore>; xiAuth?: ReturnType<typeof createAuth>;
  };
  t.after(async () => {
    await cache.xiPublicationsWatcher?.close();
    cache.xiAuth?.database.close();
    for (const key of ["xiPublications", "xiPublicationsFactory", "xiPublicationsWatcher", "xiGraph", "xiGraphStore", "xiAccounts", "xiAccountsFactory", "xiTopics", "xiAuth"] as const) delete cache[key];
    for (const key of ["NODE_ENV", "XI_VAULT_PATH", "AUTH_DATABASE_PATH", "BETTER_AUTH_URL", "BETTER_AUTH_SECRET"]) {
      if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key];
    }
    await rm(directory, { recursive: true, force: true });
  });
  Object.assign(process.env, { NODE_ENV: "development", XI_VAULT_PATH: directory, AUTH_DATABASE_PATH: join(directory, "auth.sqlite"), BETTER_AUTH_URL: "http://localhost:3000", BETTER_AUTH_SECRET: randomBytes(32).toString("hex") });

  // The precise state of the running dev process: a store (and a graph built on it) from code
  // predating the generator, with its file watcher still running.
  let legacyWatcherClosed = false;
  const legacy = Promise.resolve({ get: async () => null, page: async () => ({ items: [] }) }) as unknown as Promise<PublicationStore>;
  cache.xiPublications = legacy;
  const legacyGraph = Promise.resolve({ view: async () => null }) as unknown as Promise<GraphService>;
  cache.xiGraph = legacyGraph;
  const current = getPublicationStore();
  assert.notEqual(current, legacy);
  assert.equal(getPublicationStore(), current, "one store per process once current");
  const store = await current;
  assert.equal(typeof store.publishGenerated, "function");
  // The graph follows the store it is built on.
  const graph = getGraphService();
  assert.notEqual(graph, legacyGraph);
  assert.equal(getGraphService(), graph);
  assert.equal(typeof (await graph).view, "function");

  // The exact route composition: an existing ΞAgent, public visibility explicitly confirmed.
  const topics = await getTopicStore();
  const accounts = await getAccountStore();
  const run = await topics.propose("alice", "Politique fictive");
  await topics.confirm("alice", run.id, { tag: "politiks", name: "Politique", description: "Test", scope: "Scénarios fictifs", parentId: null, relatedIds: [] }, true);
  const proposed = await accounts.propose("alice", run.topicId);
  const ready = await accounts.resume("alice", proposed.id);
  await accounts.confirm("alice", ready.id, ready.draft!, true);
  const agent = await accounts.getOwned("alice", ready.accountId);
  // Created as before the watch engine: no `watch` key in its Markdown.
  assert.ok(!(await readFile(join(directory, "generators", agent.handle, "index.md"), "utf8")).includes("watch:"));
  const choice = { action: "publish", count: 1, accountRevision: agent.editorial!.revision, confirmed: true, messages: ["Texte **de test** fictif."] };
  const call = (owner: string, data: Record<string, unknown>) => manualPublication(accounts, topics, store, owner, agent.id, { seed: randomUUID(), ...choice, ...data });
  const published = await call("alice", { visibility: "public", publicConfirmed: true });
  assert.deepEqual([published.publication!.visibility, published.publication!.status, published.publication!.authorId], ["public", "published", agent.id]);
  assert.equal((await store.get({ id: "bob" }, published.publication!.id)).visibility, "public");
  // Private publications, confirmation and authorization checks are unchanged.
  const hidden = await call("alice", { visibility: "private", publicConfirmed: false });
  assert.equal(hidden.publication!.visibility, "private");
  await assert.rejects(store.get({ id: "bob" }, hidden.publication!.id), (error: unknown) => error instanceof PublicationError && error.code === "not_found");
  await assert.rejects(call("alice", { visibility: "public", publicConfirmed: false }), /explicitement/);
  await assert.rejects(call("bob", { visibility: "public", publicConfirmed: true }), (error: unknown) => error instanceof TopicError && error.status === 404);
  // Watch drafts stay private drafts.
  const draft = await store.saveWatchDraft("alice", agent.id, {
    id: randomUUID(), summary: "Brouillon.", topicIds: [run.topicId], messages: [{ body: "Un fait sourcé.", sources: [0] }],
    sources: [{ url: "https://exemple.test/a", title: "Article", publisher: "Éditeur", accessedAt: "2026-01-15", facts: ["Un fait sourcé"], reservations: [] }], watch: {},
  });
  assert.deepEqual([draft.status, draft.visibility], ["draft", "private"]);
  await assert.rejects(store.get({ id: "bob" }, draft.id), /introuvable/);

  // A later hot replacement also replaces the store, closes its watcher, and rebuilds the graph.
  cache.xiPublicationsWatcher = { close: () => { legacyWatcherClosed = true; } };
  cache.xiPublicationsFactory = (() => store) as unknown as typeof createPublicationStore;
  const replaced = getPublicationStore();
  assert.notEqual(replaced, current);
  assert.equal(legacyWatcherClosed, true);
  await replaced;
  const rebuilt = getGraphService();
  assert.notEqual(rebuilt, graph);
  await rebuilt;
  // Production keeps the process-wide singleton and its locks.
  Object.assign(process.env, { NODE_ENV: "production" });
  cache.xiPublicationsFactory = (() => store) as unknown as typeof createPublicationStore;
  assert.equal(getPublicationStore(), replaced);
});
