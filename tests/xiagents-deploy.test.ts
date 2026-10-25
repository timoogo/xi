import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import Database from "better-sqlite3";
import { createAccountStore } from "../src/lib/accounts/store";
import { BUILTIN_PRESETS } from "../src/lib/accounts/types";
import { DEFAULT_BLOUB_CONFIG } from "../src/lib/bloub/config";
import { openVault } from "../src/lib/publications/vault";
import { createTopicStore } from "../src/lib/topics/store";
import type { PoliteFetch } from "../src/lib/watch/net";
import { createSourceStore } from "../src/lib/watch/sources";
import { createDeployments, type DeploymentSpec } from "../src/lib/xiagents/deployments";
import { defaultSchedule } from "../src/lib/xiagents/schedule";
import { proposeAgent } from "../src/lib/xiagents/proposal";
import { INHERIT_LLM } from "../src/lib/llm/types";

const RSS = (title: string) => Buffer.from(`<?xml version="1.0"?><rss version="2.0"><channel><title>${title}</title><link>https://example.org/</link><item><title>Un article</title><link>https://example.org/a</link><pubDate>Mon, 19 Oct 2026 10:00:00 GMT</pubDate><description>Résumé</description></item></channel></rss>`);

async function setup(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "xi-deploy-"));
  const vault = await openVault(root);
  const db = new Database(":memory:");
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  const topics = createTopicStore({ vault, db });
  const accounts = createAccountStore({ vault, db, topics });
  const sources = createSourceStore({ vault, topics });
  let broken = false;
  const fetch = (async (url: string) => {
    if (broken) throw new Error("Réseau coupé (simulé).");
    const host = new URL(url).hostname;
    if (host === "nofeed.example") return { status: 200, url, headers: { "content-type": "text/html" }, body: Buffer.from("<html><head></head><body>Pas de flux</body></html>") };
    return { status: 200, url, headers: { "content-type": "application/rss+xml" }, body: RSS(host) };
  }) as unknown as PoliteFetch;
  const facts = { inference: { configured: false, model: null, error: null }, autoPublish: false, workerLastTickAt: null };
  const deployments = createDeployments({ vault, db, accounts, topics, sources, fetch, readiness: () => facts });
  const existing = (await topics.create("alice", randomUUID(), { tag: "science", name: "Science", description: "", scope: "Recherche scientifique", parentId: null, relatedIds: [] })).topic;
  return { root, db, topics, accounts, sources, deployments, existing, breakNetwork: (value: boolean) => { broken = value; } };
}

function agentSpec(existingId: string, overrides: Partial<NonNullable<DeploymentSpec["agent"]>> = {}): DeploymentSpec {
  const preset = BUILTIN_PRESETS[0];
  return {
    target: "agent",
    newTopics: [{ key: "new-1", draft: { tag: "science.longevite", name: "Longévité", description: "", scope: "Sénescence, reprogrammation épigénétique, essais cliniques", parentId: existingId, relatedIds: [] } }],
    agent: {
      handle: "longevite", name: "Veille longévité", description: "Avancées sur la longévité humaine.",
      primary: { type: "new", key: "new-1" }, secondary: [{ type: "existing", id: existingId }],
      presetId: preset.id, presetVersion: preset.version, settings: preset.settings, llm: INHERIT_LLM,
      profile: { perimeter: "Recherche publiée et essais cliniques ; pas de produits commerciaux.", charter: "Toujours citer l’étude primaire." },
      sources: [
        { url: "https://journal.example/", status: "approved", origin: "ai", type: "revue scientifique", rationale: "Revue de référence" },
        { url: "https://blog.example/", status: "excluded", origin: "user", type: "blog", rationale: "Promotionnel" },
      ],
      schedule: defaultSchedule("Europe/Paris"), bloub: { ...DEFAULT_BLOUB_CONFIG, color: "bleu" }, autoPublish: true,
      ...overrides,
    },
    proposal: { generatedBy: "ai", model: "test-model" },
  };
}

test("deploy: a topic alone is created once, with its parent routing", async t => {
  const { deployments, topics, existing } = await setup(t);
  const id = randomUUID();
  const spec: DeploymentSpec = { target: "topic", newTopics: [{ key: "new-1", draft: { tag: "science.climat", name: "Climat", description: "", scope: "Science du climat", parentId: existing.id, relatedIds: [] } }], agent: null, proposal: { generatedBy: "manual", model: null } };
  const created = await deployments.create("alice", id, spec);
  assert.deepEqual(created.steps.map(step => step.key), ["validate", "check", "topics"]);
  const done = await deployments.run("alice", id);
  assert.equal(done.state, "completed");
  assert.equal((await topics.list()).filter(topic => topic.tag === "science.climat").length, 1);
  assert.equal((await deployments.run("alice", id)).state, "completed", "running again is a no-op");
  assert.equal((await topics.list()).length, 2);
  // A second deployment with the same tag is refused before anything is written.
  await assert.rejects(deployments.create("alice", randomUUID(), spec), /déjà utilisé/);
});

test("deploy: full ΞAgent — topics, identity, charter, Bloub, sources approved/excluded, calendars, activation", async t => {
  const { deployments, accounts, sources, existing, root } = await setup(t);
  const id = randomUUID();
  const created = await deployments.create("alice", id, agentSpec(existing.id));
  assert.equal((await deployments.create("alice", id, agentSpec(existing.id))).id, created.id, "idempotent creation");
  await assert.rejects(deployments.create("alice", id, agentSpec(existing.id, { name: "Autre" })), /autre configuration/);
  const done = await deployments.run("alice", id);
  assert.equal(done.state, "completed", JSON.stringify(done.steps.filter(step => step.error)));
  assert.ok(done.steps.every(step => step.status === "completed" && step.logs.length > 0));
  const agentId = done.ids.agentId!;
  const agent = (await accounts.watchAgents()).find(item => item.id === agentId)!;
  assert.equal(agent.handle, "longevite");
  assert.equal(agent.primaryTopicId, done.ids.topics["new-1"]);
  assert.deepEqual(agent.secondaryTopicIds, [existing.id]);
  assert.equal(agent.watch.policy.enabled, true); assert.equal(agent.watch.policy.paused, false); assert.equal(agent.watch.policy.autoPublish, true);
  assert.equal(agent.watch.policy.visibility, "private", "public always needs its own confirmation");
  assert.equal(agent.schedule!.explicit, true); assert.equal(agent.schedule!.timeZone, "Europe/Paris");
  assert.equal(agent.profile!.charter, "Toujours citer l’étude primaire.");
  assert.equal((await accounts.avatar("alice", agentId)).config.color, "bleu");
  const catalog = (await sources.list("alice", { includeDeleted: true })).sources;
  assert.equal(catalog.find(source => source.url.startsWith("https://journal.example"))!.status, "approved");
  assert.equal(catalog.find(source => source.url.startsWith("https://blog.example"))!.status, "rejected", "excluded = rejected tombstone, never re-proposed");
  assert.match(catalog.find(source => source.status === "approved")!.history[0].note!, /Suggérée par le modèle local/);
  // Readiness reports real facts (no inference, no worker) as warnings, never as success.
  const readiness = done.steps.find(step => step.key === "readiness")!;
  assert.ok(readiness.logs.some(log => log.level === "warn" && /XI_INFERENCE_URL/.test(log.message)));
  assert.ok(readiness.logs.some(log => log.level === "warn" && /worker/.test(log.message)));
  // Running again changes nothing: one agent, one topic, two sources.
  await deployments.run("alice", id);
  assert.equal((await accounts.list("alice")).filter(account => account.owner === "alice").length, 1);
  assert.equal((await sources.list("alice", { includeDeleted: true })).sources.length, 2);
  // History, private files and isolation.
  assert.deepEqual((await deployments.list("alice")).map(item => item.id), [id]);
  assert.deepEqual(await deployments.list("bob"), []);
  await assert.rejects(deployments.get("bob", id), /introuvable/);
  await assert.rejects(deployments.run("bob", id), /introuvable/);
  assert.ok((await readdir(join(root, ".xi-deployments"))).includes(`${id}.md`));
  assert.ok(!(await readFile(join(root, "generators", "longevite", "index.md"), "utf8")).includes("Sénescence"), "the topic scope is referenced, not copied");
});

test("deploy: a failure stops before activation, the retry resumes without duplicates", async t => {
  const { deployments, accounts, sources, topics, existing, breakNetwork } = await setup(t);
  const id = randomUUID();
  await deployments.create("alice", id, agentSpec(existing.id));
  breakNetwork(true);
  const failed = await deployments.run("alice", id);
  assert.equal(failed.state, "failed");
  const step = failed.steps.find(item => item.status === "failed")!;
  assert.equal(step.key, "sources");
  assert.match(step.error!, /Relancez/);
  assert.ok(failed.steps.slice(failed.steps.indexOf(step) + 1).every(item => item.status === "pending"));
  // Partial state is coherent: the agent exists but its watch is not enabled.
  const partial = (await accounts.watchAgents()).find(item => item.id === failed.ids.agentId)!;
  assert.equal(partial.watch.policy.enabled, false);
  breakNetwork(false);
  const resumed = await deployments.run("alice", id);
  assert.equal(resumed.state, "completed");
  assert.equal(resumed.attempts, 2);
  assert.ok(resumed.steps.find(item => item.key === "identity")!.logs.length === 2, "earlier steps are not run again");
  assert.equal((await topics.list()).length, 2);
  assert.equal((await accounts.list("alice")).filter(account => account.owner === "alice").length, 1);
  assert.equal((await sources.list("alice", { includeDeleted: true })).sources.length, 2);
});

test("deploy: unusable source and taken handle are reported, never hidden", async t => {
  const { deployments, existing } = await setup(t);
  const spec = agentSpec(existing.id, { sources: [{ url: "https://nofeed.example/", status: "approved", origin: "user", type: "site", rationale: "" }] });
  const id = randomUUID();
  await deployments.create("alice", id, spec);
  const done = await deployments.run("alice", id);
  assert.equal(done.state, "completed");
  const logs = done.steps.find(step => step.key === "sources")!.logs;
  assert.ok(logs.some(log => log.level === "error" && /nofeed\.example/.test(log.message)));
  await assert.rejects(deployments.create("alice", randomUUID(), agentSpec(existing.id, { handle: "longevite" })), /handle @longevite est déjà réservé|déjà utilisé/);
  await assert.rejects(deployments.create("alice", randomUUID(), { ...spec, agent: { ...spec.agent!, primary: { type: "existing", id: existing.id }, secondary: [{ type: "existing", id: existing.id }] } }), /dupliqués/);
});

test("proposal: model output is validated, existing topics reused, handle reserved, bad sources dropped", async t => {
  const { topics, accounts, existing } = await setup(t);
  await accounts.createAgent("bob", randomUUID(), { draft: { handle: "longevite", name: "Pris", description: "", primaryTopicId: existing.id, secondaryTopicIds: [], presetId: BUILTIN_PRESETS[0].id, presetVersion: 1, settings: BUILTIN_PRESETS[0].settings, active: true, modelRef: null, validationMode: "human" }, profile: { perimeter: "", charter: "" }, bloub: DEFAULT_BLOUB_CONFIG });
  const answers = [
    "pas du JSON",
    JSON.stringify({
      name: "Longévité", handle: "Longévité!", description: "Suivi", primaryTopic: { existing: null, name: "Longévité", tag: "Longévité Humaine", scope: "Sénescence" },
      secondaryTopics: [{ existing: "T1", name: "Science" }, { existing: null, name: "Science bis", tag: "science" }],
      perimeter: "P", charter: "C", depth: "énorme",
      sources: [{ url: "https://www.nature.com/", type: "revue", rationale: "R" }, { url: "javascript:alert(1)" }, { url: "https://www.nature.com/aging" }, { url: "ftp://x.org" }],
    }),
  ];
  const inference = { complete: async () => answers.shift()! };
  const proposal = await proposeAgent({ inference, model: "m", description: "Je veux suivre la science de la longévité", catalog: await topics.list(), handleAvailable: handle => accounts.handleAvailable(handle) });
  assert.equal(proposal.handle, "longevite-2");
  assert.deepEqual(proposal.primary, { type: "new", key: "new-1", draft: { tag: "longevite-humaine", name: "Longévité", description: "", scope: "Sénescence", parentId: null, relatedIds: [] } });
  assert.deepEqual(proposal.secondary, [{ type: "existing", id: existing.id, reason: "Topic existant choisi par le modèle." }], "the duplicate tag is not proposed twice");
  assert.deepEqual(proposal.sources.map(source => source.domain), ["www.nature.com"]);
  assert.equal(proposal.settings.depth, "standard");
  // Unavailable model: the error surfaces, nothing is invented.
  await assert.rejects(proposeAgent({ inference: { complete: async () => { throw new Error("down"); } }, model: "m", description: "Suivre la longévité", catalog: [], handleAvailable: async () => true }), /down/);
});
