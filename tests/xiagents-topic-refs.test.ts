import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import Database from "better-sqlite3";
import { createAccountStore } from "../src/lib/accounts/store";
import { openVault } from "../src/lib/publications/vault";
import { createTopicStore } from "../src/lib/topics/store";
import { TopicError } from "../src/lib/topics/types";
import type { PoliteFetch } from "../src/lib/watch/net";
import { createSourceStore } from "../src/lib/watch/sources";
import { createDeployments } from "../src/lib/xiagents/deployments";
import { applySuggestion, draftIssues, draftToSpec, editDraft, newDraft, type AgentDraft } from "../src/lib/xiagents/draft";
import { exportAgentDraft } from "../src/lib/xiagents/export";
import { draftToYaml, parseAgentYaml } from "../src/lib/xiagents/yaml";

/** P1: a topic missing from the catalog is never dropped or replaced implicitly (export, import, deployment). */
async function setup(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "xi-topic-refs-"));
  const vault = await openVault(root);
  const db = new Database(":memory:");
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  const topics = createTopicStore({ vault, db });
  const accounts = createAccountStore({ vault, db, topics });
  const sources = createSourceStore({ vault, topics });
  const fetch = (async () => { throw new Error("hors ligne"); }) as unknown as PoliteFetch;
  const deployments = createDeployments({ vault, db, accounts, topics, sources, fetch, readiness: () => ({ inference: { configured: false, model: null, error: null }, autoPublish: false, workerLastTickAt: null }) });
  const make = async (tag: string, name: string) => (await topics.create("alice", randomUUID(), { tag, name, description: "", scope: `Périmètre ${name}`, parentId: null, relatedIds: [] })).topic;
  const [science, climat, espace] = [await make("science", "Science"), await make("climat", "Climat"), await make("espace", "Espace")];
  const presets = await accounts.listPresets("alice");
  const draft = (topicIds: string[]): AgentDraft => editDraft(newDraft({ presets, timeZone: "Europe/Paris" }), {
    name: "Veille test", handle: `veille-${randomUUID().slice(0, 8)}`, topics: topicIds.map(id => ({ type: "existing", id })),
  });
  /** Simulates a topic that disappeared from the vault (the store itself never deletes one). */
  const vanish = (id: string) => rm(join(root, "topics", `${id}.md`));
  return { topics, accounts, sources, deployments, science, climat, espace, presets, draft, vanish };
}
const refused = (fn: () => unknown, pattern: RegExp) => assert.throws(fn, (error: unknown) => error instanceof TopicError && error.status === 409 && pattern.test(error.message));

test("export: a missing secondary topic is never dropped (no promotion), the export is refused with an explicit error", async t => {
  const env = await setup(t);
  const draft = env.draft([env.science.id, env.climat.id, env.espace.id]);
  const catalog = (await env.topics.list()).filter(topic => topic.id !== env.climat.id);
  refused(() => draftToYaml(draft, catalog), /secondaire 1/);
  // Missing primary: same, and the first secondary never takes its place.
  refused(() => draftToYaml(env.draft([env.climat.id, env.science.id]), catalog), /principal/);
  // Both are blocking problems of the draft itself, located on the topics section.
  const issues = draftIssues(draft, catalog, env.presets);
  assert.ok(issues.some(issue => issue.section === "topics" && /Topic secondaire 1 introuvable/.test(issue.message)));
});

test("export of a deployed agent whose topic vanished: unresolved in place, YAML refused (409)", async t => {
  const env = await setup(t);
  const id = randomUUID();
  await env.deployments.create("alice", id, draftToSpec(env.draft([env.science.id, env.climat.id, env.espace.id])));
  const done = await env.deployments.run("alice", id);
  assert.equal(done.state, "completed");
  const agentId = done.ids.agentId!;
  await env.vanish(env.climat.id);
  const exported = await exportAgentDraft({ owner: "alice", agentId, accounts: env.accounts, topics: env.topics, sources: env.sources });
  assert.deepEqual(exported.topics, [{ type: "existing", id: env.science.id }, { type: "unresolved", tag: null, id: env.climat.id }, { type: "existing", id: env.espace.id }]);
  const remaining = await env.topics.list();
  refused(() => draftToYaml(exported, remaining), /secondaire 1.*étiquette est inconnue/);
  // Primary vanished: the export of the agent is refused as well.
  await env.vanish(env.science.id);
  const again = await exportAgentDraft({ owner: "alice", agentId, accounts: env.accounts, topics: env.topics, sources: env.sources });
  assert.equal(again.topics[0].type, "unresolved");
  const left = await env.topics.list();
  refused(() => draftToYaml(again, left), /principal/);
});

test("import: an unknown bare tag stays an unresolved reference in place; it blocks deployment until corrected", async t => {
  const env = await setup(t);
  const catalog = await env.topics.list();
  const yaml = "xiagent: 1\nidentity: { name: Veille, handle: veille-refs }\ntopics:\n  primary: astronomie.galaxies\n  secondary: [science, geologie]\n";
  const result = parseAgentYaml(yaml, { catalog, presets: env.presets });
  assert.ok(result.ok);
  assert.deepEqual(result.patch.topics, [{ type: "unresolved", tag: "astronomie.galaxies", id: null }, { type: "existing", id: env.science.id }, { type: "unresolved", tag: "geologie", id: null }]);
  assert.ok(result.issues.some(issue => issue.level === "warning" && issue.path === "topics.primary" && /introuvable/.test(issue.message)));
  let draft = applySuggestion(newDraft({ presets: env.presets, timeZone: "Europe/Paris" }), result.patch, "yaml");
  const issues = draftIssues(draft, catalog, env.presets);
  assert.ok(issues.some(issue => /Topic principal non résolu \(astronomie\.galaxies\)/.test(issue.message)));
  assert.ok(issues.some(issue => /Topic secondaire 2 non résolu \(geologie\)/.test(issue.message)));
  assert.throws(() => draftToSpec(draft), /non résolu/);

  // Round trip keeps every reference in its position.
  const reparsed = parseAgentYaml(draftToYaml(draft, catalog), { catalog, presets: env.presets });
  assert.ok(reparsed.ok);
  assert.deepEqual(reparsed.patch.topics, result.patch.topics);

  // Manual corrections: replace the primary by an existing topic, remove the secondary reference.
  draft = editDraft(draft, { topics: [{ type: "existing", id: env.espace.id }, { type: "existing", id: env.science.id }] });
  assert.deepEqual(draftIssues(draft, catalog, env.presets), []);
  const id = randomUUID();
  await env.deployments.create("alice", id, draftToSpec(draft));
  assert.equal((await env.deployments.run("alice", id)).state, "completed");
});

test("import: correcting an unresolved reference by creating it as a new topic deploys it; existing tags stay compatible", async t => {
  const env = await setup(t);
  const catalog = await env.topics.list();
  const result = parseAgentYaml("xiagent: 1\nidentity: { name: Veille, handle: veille-geo }\ntopics:\n  primary: geologie\n  secondary: [climat]\n", { catalog, presets: env.presets });
  assert.ok(result.ok);
  assert.equal(result.patch.topics![1].type, "existing", "a known tag still resolves to the existing topic");
  let draft = applySuggestion(newDraft({ presets: env.presets, timeZone: "Europe/Paris" }), result.patch, "yaml");
  draft = editDraft(draft, { topics: [{ type: "new", key: "new-1", draft: { tag: "geologie", name: "Géologie", description: "", scope: "Roches et séismes", parentId: null, relatedIds: [] } }, draft.topics[1]] });
  assert.deepEqual(draftIssues(draft, catalog, env.presets), []);
  const id = randomUUID();
  await env.deployments.create("alice", id, draftToSpec(draft));
  assert.equal((await env.deployments.run("alice", id)).state, "completed");
  assert.ok((await env.topics.list()).some(topic => topic.tag === "geologie"));
  // kind: topic keeps creating the topic named by a bare tag (it is the creation target).
  const topicOnly = parseAgentYaml("xiagent: 1\nkind: topic\ntopics:\n  primary: volcans\n", { catalog, presets: env.presets });
  assert.ok(topicOnly.ok && topicOnly.patch.topics![0].type === "new");
});
