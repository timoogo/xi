import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { createAccountStore } from "../src/lib/accounts/store";
import { openVault } from "../src/lib/publications/vault";
import { createTopicStore, type TopicStore } from "../src/lib/topics/store";
import type { PoliteFetch } from "../src/lib/watch/net";
import { createSourceStore } from "../src/lib/watch/sources";
import { createDeployments } from "../src/lib/xiagents/deployments";
import { applySuggestion, draftToSpec, newDraft } from "../src/lib/xiagents/draft";
import { parseAgentYaml } from "../src/lib/xiagents/yaml";

/**
 * Regression of the "Astronoxi" failure: under `next dev`, the topic store kept in globalThis had been
 * built before `create` existed, so the "topics" step threw a TypeError reported as "Opération
 * interrompue". The step must now say what failed, and the deployment must resume without duplicates.
 */
const YAML = `xiagent: 1
identity: { name: Astronoxi, handle: astronoxi, description: Veille astronomie }
topics:
  primary:
    tag: astronomie
    name: Astronomie
    scope: Découvertes astronomiques, observation de l'Univers, astrophysique, exoplanètes et exploration spatiale.
`;

test("deployment: an internal error at the topics step is diagnosed; resuming completes without duplicates", async t => {
  const root = await mkdtemp(join(tmpdir(), "xi-resume-"));
  const vault = await openVault(root);
  const db = new Database(":memory:");
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  const topics = createTopicStore({ vault, db });
  const accounts = createAccountStore({ vault, db, topics });
  const sources = createSourceStore({ vault, topics });
  const fetch = (async () => { throw new Error("hors ligne"); }) as unknown as PoliteFetch;
  const readiness = () => ({ inference: { configured: false, model: null, error: null }, autoPublish: false, workerLastTickAt: null });
  // The store as built by the implementation preceding `create` (same files, older API).
  const { create: _create, ...older } = topics;
  void _create;
  const stale = createDeployments({ vault, db, accounts, topics: older as unknown as TopicStore, sources, fetch, readiness });

  const presets = await accounts.listPresets("alice");
  const imported = parseAgentYaml(YAML, { catalog: await topics.list(), presets });
  assert.ok(imported.ok);
  const spec = draftToSpec(applySuggestion(newDraft({ presets, timeZone: "Europe/Paris" }), imported.patch, "yaml"));
  assert.deepEqual(spec.newTopics.map(topic => [topic.draft.tag, topic.draft.parentId]), [["astronomie", null]]);

  const id = randomUUID();
  await stale.create("alice", id, spec);
  const errors = t.mock.method(console, "error", () => {});
  const failed = await stale.run("alice", id);
  assert.equal(failed.state, "failed");
  assert.deepEqual(failed.steps.slice(0, 3).map(step => [step.key, step.status]), [["validate", "completed"], ["check", "completed"], ["topics", "failed"]]);
  const step = failed.steps[2];
  assert.match(step.error!, /^Erreur interne \(TypeError\) pendant « Création des topics nécessaires » : les étapes terminées sont conservées\. Relancez le déploiement/);
  assert.doesNotMatch(step.error!, /is not a function|\/tmp|alice/, "no internal message, path or owner shown");
  assert.equal(errors.mock.callCount(), 1);
  const [label, details] = errors.mock.calls[0].arguments as [string, Record<string, unknown>];
  assert.equal(label, "ΞAgent deployment step failed");
  assert.deepEqual({ ...details, message: undefined }, { deployment: id, step: "topics", error: "TypeError", code: null, message: undefined });
  assert.match(String(details.message), /create is not a function/, "the server log keeps the actual cause");
  assert.deepEqual((await readdir(join(root, "topics"))).filter(name => name.endsWith(".md")), [], "nothing written by the failed step");

  // After the fix (current store), "Reprendre le déploiement" resumes from the failed step.
  const fixed = createDeployments({ vault, db, accounts, topics, sources, fetch, readiness });
  const done = await fixed.run("alice", id);
  assert.equal(done.state, "completed", JSON.stringify(done.steps.filter(item => item.error).map(item => [item.key, item.error])));
  assert.equal(done.attempts, 2);
  assert.match(done.steps[2].logs.at(-2)!.message, /Reprise \(tentative 2\)/);
  const catalog = await topics.list();
  assert.deepEqual(catalog.map(topic => [topic.tag, topic.id, topic.parentId]), [["astronomie", done.ids.topics["new-1"], null]]);
  const owned = (await accounts.list("alice")).filter(account => account.handle === "astronoxi");
  assert.deepEqual(owned.map(account => account.id), [done.ids.agentId]);
  // Running again changes nothing.
  assert.equal((await fixed.run("alice", id)).attempts, 2);
  assert.equal((await topics.list()).length, 1);
});

test("dev singletons: a topic store built by an older implementation is replaced, with the services holding it", async t => {
  const root = await mkdtemp(join(tmpdir(), "xi-singletons-"));
  const scope = globalThis as typeof globalThis & Record<string, unknown>;
  const saved = { vault: process.env.XI_VAULT_PATH, keys: ["xiAuth", "xiTopics", "xiTopicsFactory", "xiAccounts", "xiAccountsFactory", "xiAccountsTopics", "xiWatch", "xiWatchFactory", "xiWatchTopics"].map(key => [key, scope[key]] as const) };
  const db = new Database(":memory:");
  t.after(async () => {
    for (const [key, value] of saved.keys) scope[key] = value;
    if (saved.vault === undefined) delete process.env.XI_VAULT_PATH; else process.env.XI_VAULT_PATH = saved.vault;
    db.close(); await rm(root, { recursive: true, force: true });
  });
  process.env.XI_VAULT_PATH = root;
  scope.xiAuth = { database: db };
  const { getTopicStore } = await import("../src/lib/topics/server");
  const { getAccountStore } = await import("../src/lib/accounts/server");
  const { getWatchServices } = await import("../src/lib/watch/server");
  // State left by a server started before `create` existed.
  const older = { list: async () => [] };
  scope.xiTopics = Promise.resolve(older);
  scope.xiTopicsFactory = () => older;
  const current = await getTopicStore();
  assert.notEqual(current, older);
  assert.equal(typeof current.create, "function");
  assert.equal(await getTopicStore(), current, "kept while the implementation is unchanged");
  // Dependent services built with another topic store are rebuilt too.
  const accounts = await getAccountStore();
  const watch = await getWatchServices();
  scope.xiTopicsFactory = undefined;
  const rebuilt = await getTopicStore();
  assert.notEqual(rebuilt, current);
  assert.notEqual(await getAccountStore(), accounts);
  assert.notEqual(await getWatchServices(), watch);
});
