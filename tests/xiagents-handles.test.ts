import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import Database from "better-sqlite3";
import { createAccountStore } from "../src/lib/accounts/store";
import { accountDraftSchema, BUILTIN_PRESETS } from "../src/lib/accounts/types";
import { DEFAULT_BLOUB_CONFIG } from "../src/lib/bloub/config";
import { GENERATOR_SLUG } from "../src/lib/graph/types";
import { openVault } from "../src/lib/publications/vault";
import { createTopicStore } from "../src/lib/topics/store";
import { TopicError } from "../src/lib/topics/types";
import type { PoliteFetch } from "../src/lib/watch/net";
import { createSourceStore } from "../src/lib/watch/sources";
import { createDeployments, type DeploymentSpec } from "../src/lib/xiagents/deployments";
import { findFreeHandle, handleCandidates, HandleUnavailableError, MAX_HANDLE_ATTEMPTS } from "../src/lib/xiagents/handles";
import { proposeAgent } from "../src/lib/xiagents/proposal";
import { defaultSchedule } from "../src/lib/xiagents/schedule";
import { INHERIT_LLM } from "../src/lib/llm/types";

const counting = (taken: Set<string> | "all") => {
  const calls: string[] = [];
  const available = async (handle: string) => { calls.push(handle); return taken !== "all" && !taken.has(handle); };
  return { calls, available };
};

test("handles: successive collisions stop at the first free variant", async () => {
  const { calls, available } = counting(new Set(["veille", "veille-2", "veille-3"]));
  assert.equal(await findFreeHandle("veille", available), "veille-4");
  assert.deepEqual(calls, ["veille", "veille-2", "veille-3", "veille-4"]);
  assert.equal(await findFreeHandle("@libre", async () => true), "libre", "a leading @ is accepted");
});

test("handles: an existing numeric suffix is stripped from the stem", async () => {
  assert.deepEqual(handleCandidates("veille-7", 4), ["veille-7", "veille-2", "veille-3", "veille-4"]);
  assert.deepEqual(handleCandidates("veille-2", 3), ["veille-2", "veille-3", "veille-4"], "no duplicate candidate");
  assert.deepEqual(handleCandidates("sci.bio-12", 2), ["sci.bio-12", "sci.bio-2"]);
  const { available } = counting(new Set(["veille-7", "veille-2"]));
  assert.equal(await findFreeHandle("veille-7", available), "veille-3");
});

test("handles: long handles are truncated and every candidate stays valid", () => {
  for (const base of ["a".repeat(180), `${"ab-".repeat(59)}abc`, `${"x".repeat(176)}.y-z`, `${"a".repeat(175)}-${"b".repeat(4)}`]) {
    assert.ok(base.length <= 180);
    const candidates = handleCandidates(base);
    assert.equal(candidates.length, MAX_HANDLE_ATTEMPTS);
    assert.equal(new Set(candidates).size, candidates.length);
    assert.equal(candidates[0], base);
    for (const candidate of candidates) {
      assert.ok(candidate.length <= 180, candidate);
      assert.ok(GENERATOR_SLUG.test(candidate), candidate);
      assert.ok(accountDraftSchema.shape.handle.safeParse(candidate).success, candidate);
    }
  }
});

test("handles: exhaustion throws HandleUnavailableError (409) after exactly MAX calls", async () => {
  const { calls, available } = counting("all");
  const error = await findFreeHandle("pris", available).then(() => null, (e: unknown) => e);
  assert.ok(error instanceof HandleUnavailableError);
  assert.ok(error instanceof TopicError);
  assert.equal(error.status, 409);
  assert.match(error.message, /Aucun handle libre trouvé à partir de @pris après 20 essais/);
  assert.equal(calls.length, MAX_HANDLE_ATTEMPTS);
  const few = counting("all");
  await assert.rejects(findFreeHandle("pris", few.available, 3), HandleUnavailableError);
  assert.equal(few.calls.length, 3);
});

test("handles: an invalid handle is refused (400) without any availability call", async () => {
  for (const base of ["", "Majuscule", "a b", "-x", "x.", "a".repeat(181), "é"]) {
    const { calls, available } = counting(new Set());
    const error = await findFreeHandle(base, available).then(() => null, (e: unknown) => e);
    assert.ok(error instanceof TopicError && !(error instanceof HandleUnavailableError), base);
    assert.equal(error.status, 400);
    assert.match(error.message, /^Handle invalide/);
    assert.equal(calls.length, 0);
  }
});

test("handles: proposeAgent surfaces exhaustion as the controlled error", async () => {
  const answer = JSON.stringify({ name: "Longévité", handle: "longevite", description: "Suivi", primaryTopic: { existing: null, name: "Longévité", tag: "longevite", scope: "Sénescence" } });
  const { calls, available } = counting("all");
  await assert.rejects(
    proposeAgent({ inference: { complete: async () => answer }, model: "m", description: "Suivre la longévité", catalog: [], handleAvailable: available }),
    (error: unknown) => error instanceof HandleUnavailableError && error.status === 409,
  );
  assert.equal(calls.length, MAX_HANDLE_ATTEMPTS);
  const taken = counting(new Set(["longevite", "longevite-2"]));
  const proposal = await proposeAgent({ inference: { complete: async () => answer }, model: "m", description: "Suivre la longévité", catalog: [], handleAvailable: taken.available });
  assert.equal(proposal.handle, "longevite-3");
});

async function setup(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "xi-handles-"));
  const vault = await openVault(root);
  const db = new Database(":memory:");
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  const topics = createTopicStore({ vault, db });
  const accounts = createAccountStore({ vault, db, topics });
  const sources = createSourceStore({ vault, topics });
  const fetch = (async () => { throw new Error("Pas de réseau dans ce test."); }) as unknown as PoliteFetch;
  const facts = { inference: { configured: false, model: null, error: null }, autoPublish: false, workerLastTickAt: null };
  const deployments = createDeployments({ vault, db, accounts, topics, sources, fetch, readiness: () => facts });
  const existing = (await topics.create("alice", randomUUID(), { tag: "science", name: "Science", description: "", scope: "Recherche scientifique", parentId: null, relatedIds: [] })).topic;
  return { accounts, deployments, existing };
}

const draft = (handle: string, topicId: string) => ({ handle, name: "Agent", description: "", primaryTopicId: topicId, secondaryTopicIds: [], presetId: BUILTIN_PRESETS[0].id, presetVersion: 1, settings: BUILTIN_PRESETS[0].settings, active: true, modelRef: null, validationMode: "human" });

test("handles: a handle taken by another owner is not available", async t => {
  const { accounts, existing } = await setup(t);
  const bobId = randomUUID();
  await accounts.createAgent("bob", bobId, { draft: draft("partage", existing.id), profile: { perimeter: "", charter: "" }, bloub: DEFAULT_BLOUB_CONFIG });
  assert.equal(await accounts.handleAvailable("partage"), false);
  // The "@" and spaces stripped at save time are stripped before comparing too.
  assert.equal(await accounts.handleAvailable("@partage"), false);
  assert.equal(await accounts.handleAvailable(" partage "), false);
  assert.equal(await accounts.handleAvailable("partage", bobId), true, "only bob's own agent keeps it");
  assert.equal(await findFreeHandle("partage", handle => accounts.handleAvailable(handle)), "partage-2");
  await assert.rejects(accounts.createAgent("alice", randomUUID(), { draft: draft("partage", existing.id), profile: { perimeter: "", charter: "" }, bloub: DEFAULT_BLOUB_CONFIG }), (error: unknown) => error instanceof TopicError && error.status === 409);
});

function spec(existingId: string, handle: string): DeploymentSpec {
  const preset = BUILTIN_PRESETS[0];
  return {
    target: "agent", newTopics: [],
    agent: {
      handle, name: "Veille", description: "", primary: { type: "existing", id: existingId }, secondary: [],
      presetId: preset.id, presetVersion: preset.version, settings: preset.settings, llm: INHERIT_LLM,
      profile: { perimeter: "", charter: "" }, sources: [],
      schedule: defaultSchedule("Europe/Paris"), bloub: DEFAULT_BLOUB_CONFIG, autoPublish: false,
    },
    proposal: { generatedBy: "manual", model: null },
  };
}

test("handles: two concurrent deployments with the same handle create exactly one agent", async t => {
  const { accounts, deployments, existing } = await setup(t);
  const [a, b] = [randomUUID(), randomUUID()];
  // Both pass the preflight: the handle is still free when they are created.
  await Promise.all([deployments.create("alice", a, spec(existing.id, "jumeau")), deployments.create("bob", b, spec(existing.id, "jumeau"))]);
  const results = await Promise.all([deployments.run("alice", a), deployments.run("bob", b)]);
  assert.deepEqual(results.map(r => r.state).sort(), ["completed", "failed"]);
  const failed = results.find(r => r.state === "failed")!;
  const step = failed.steps.find(s => s.status === "failed")!;
  assert.match(step.error ?? "", /réservé/);
  const agents = (await accounts.watchAgents()).filter(agent => agent.handle === "jumeau");
  assert.equal(agents.length, 1);
  assert.equal(agents[0].owner, results.find(r => r.state === "completed")!.owner);
});
