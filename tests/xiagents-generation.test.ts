import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { createAccountStore } from "../src/lib/accounts/store";
import { DEFAULT_WATCH_POLICY } from "../src/lib/accounts/types";
import { createPublicationStore } from "../src/lib/publications/store";
import { openVault } from "../src/lib/publications/vault";
import { createTopicStore } from "../src/lib/topics/store";
import { TopicError } from "../src/lib/topics/types";
import { reviewDraft } from "../src/lib/watch/drafting";
import { migrateWatchCandidates } from "../src/lib/watch/evaluate";
import { InferenceUnavailableError, type ChatRequest, type Inference } from "../src/lib/watch/inference";
import { listRuns } from "../src/lib/watch/orchestrator";
import { recordEntries } from "../src/lib/watch/stories";
import { manualPublication } from "../src/lib/xiagents/manual-publication";
import { draftableCandidates, generatePublication } from "../src/lib/xiagents/publication-generator";
import { bindTo } from "./helpers/llm";

/**
 * The two generators of a ΞAgent stay separate: fixtures (fictitious, local, no model) and real
 * publications (verified information → the agent's model → checks → private draft → confirmation).
 */

const reform = [
  { publisher: "Le Quotidien", title: "Le Parlement adopte la réforme des retraites", summary: "Le Parlement a définitivement adopté jeudi la réforme des retraites, qui fixe l'âge légal à 64 ans." },
  { publisher: "Le Journal", title: "Réforme des retraites : vote définitif", summary: "Les parlementaires ont voté jeudi la réforme des retraites. Le ministère du Travail a déclaré qu'elle garantira l'équilibre du système d'ici 2030." },
];
const claims = [
  { text: "Le Parlement a définitivement adopté la réforme des retraites jeudi.", quotes: [[0, "Le Parlement a définitivement adopté jeudi la réforme des retraites"], [1, "Les parlementaires ont voté jeudi la réforme des retraites"]] as [number, string][] },
  { text: "Le ministère du Travail affirme que la réforme garantira l'équilibre du système d'ici 2030.", kind: "attributed", status: "primary", attribution: "Ministère du Travail", quotes: [[1, "Le ministère du Travail a déclaré qu'elle garantira l'équilibre du système d'ici 2030"]] as [number, string][] },
];
const POST = { format: "post", summary: "Le Parlement adopte la réforme des retraites.", messages: [{ text: "Le Parlement a définitivement adopté jeudi la réforme des retraites.", claims: ["A1"] }] };
const THREAD = { format: "thread", summary: "Le Parlement adopte la réforme des retraites.", messages: [
  { text: "Le Parlement a définitivement adopté jeudi la réforme des retraites.", claims: ["A1"] },
  { text: "Selon le ministère du Travail, la réforme garantira l'équilibre du système d'ici 2030.", claims: ["A2"] },
] };

/** Records every request; answers the draft or the consistency review like a compliant model. */
function fakeModel(answer: (prompt: string) => unknown = prompt => prompt.includes("Format imposé par le propriétaire : thread") ? THREAD : POST) {
  const requests: ChatRequest[] = [];
  let down = false;
  return {
    requests, setDown: (value: boolean) => { down = value; },
    inference: {
      async complete(request: ChatRequest) {
        if (down) throw new InferenceUnavailableError("Ollama injoignable : Raspberry Pi éteint.", null, "unreachable");
        requests.push(request);
        return JSON.stringify(request.prompt.startsWith("Vérifie chaque message") ? { messages: [] } : answer(request.prompt));
      },
    },
  };
}

async function world(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "xi-generation-"));
  const db = new Database(join(root, "app.sqlite"));
  db.pragma("journal_mode = WAL"); db.pragma("busy_timeout = 5000");
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  const vault = await openVault(root);
  const topics = createTopicStore({ vault, db });
  const accounts = createAccountStore({ vault, db, topics });
  const publications = createPublicationStore({ vault, db });
  const run = await topics.propose("alice", "Politique");
  await topics.confirm("alice", run.id, { tag: "politiks", name: "Politiks", description: "Test", scope: "Vie politique française.", parentId: null, relatedIds: [] }, true);
  const topicId = run.topicId;
  const proposed = await accounts.propose("alice", topicId);
  const ready = await accounts.resume("alice", proposed.id);
  await accounts.confirm("alice", ready.id, { ...ready.draft!, modelRef: "qwen3:1.7b" }, true);
  const agentId = ready.accountId;
  await accounts.setWatchPolicy("alice", agentId, { revision: null, policy: { ...DEFAULT_WATCH_POLICY, enabled: true } });
  migrateWatchCandidates(db);
  const clock = Date.parse("2026-01-15T12:00:00Z");
  /** An accepted candidate with its verified claims, as the evaluation leaves it (fictitious news). */
  function candidate(used = claims, importance = 0.7, label = "") {
    const ids: string[] = [];
    for (const [i, item] of reform.entries()) {
      recordEntries(db, { owner: "alice", source: { id: `src-${i}-${randomUUID()}`, publisher: item.publisher, ownerGroup: null, topicIds: [topicId] }, entries: [{ url: `https://${item.publisher.toLowerCase().replace(/\W+/g, "")}.example/${randomUUID()}`, guid: null, title: label ? `${label} ${i}` : item.title, summary: label ? `${label}. Mission scientifique, relevés glaciaires et campagne océanographique.` : item.summary, publishedAt: "2026-01-15T08:00:00.000Z", author: null, credits: [], links: [] }], now: clock });
      ids.push((db.prepare("SELECT id FROM watch_item ORDER BY rowid DESC LIMIT 1").get() as { id: string }).id);
    }
    const story = (db.prepare("SELECT story_id FROM watch_item WHERE id = ?").get(ids[0]) as { story_id: string }).story_id;
    const version = (db.prepare("SELECT item_count FROM watch_story WHERE id = ?").get(story) as { item_count: number }).item_count;
    db.prepare("INSERT INTO watch_candidate (agent_id, story_id, owner, story_version, status, stage, lane, topic_id, relevance, novelty, novelty_kind, importance, reason, data, model, prompt_version, created_at, updated_at) VALUES (?, ?, 'alice', ?, 'accepted', 'done', 'night', ?, 0.9, 1, 'new', ?, 'Vérifié.', ?, 'qwen3:1.7b', 'veille-3.1', ?, ?)")
      .run(agentId, story, version, topicId, importance, JSON.stringify({ title: reform[0].title }), clock, clock);
    used.forEach((c, i) => db.prepare("INSERT INTO watch_claim VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(randomUUID(), agentId, story, i, c.text, c.kind ?? "fact", c.attribution ?? null, c.status ?? "corroborated", "Vérifié.",
      JSON.stringify({ quotes: c.quotes.map(([item, quote]) => ({ itemId: ids[item], label: `I${item + 1}`, publisher: reform[item].publisher, quote, lineage: item, official: false, url: "https://x.example" })), rejectedQuotes: 0 }), new Set(c.quotes.map(([item]) => item)).size));
    return story;
  }
  const generate = (model: { inference: Inference } | null, input: unknown, owner = "alice") =>
    generatePublication({ db, accounts, topics, publications, llm: bindTo(model?.inference ?? null), now: () => clock }, owner, agentId, input);
  const published = async () => { await publications.ensureIndexed(); return publications.agentPublications(agentId); };
  const status = (story: string) => (db.prepare("SELECT status FROM watch_candidate WHERE agent_id = ? AND story_id = ?").get(agentId, story) as { status: string }).status;
  return { db, accounts, topics, publications, agentId, candidate, generate, published, status };
}

test("fixtures: post and thread without any model, labelled as fictitious test content", async t => {
  const { accounts, topics, publications, agentId, published } = await world(t);
  const revision = (await accounts.getOwned("alice", agentId)).editorial!.revision;
  // No LLM is configured nor reachable: the fixture generator does not need one.
  for (const count of [1, 3]) {
    const seed = randomUUID();
    const { preview } = await manualPublication(accounts, topics, publications, "alice", agentId, { action: "generate", seed, count, accountRevision: revision }) as { preview: { summary: string; messages: string[] } };
    assert.equal(preview.messages.length, count);
    assert.ok(preview.messages.every(message => message.startsWith("**Contenu de test fictif")));
    const { publication } = await manualPublication(accounts, topics, publications, "alice", agentId, { action: "publish", seed, count, accountRevision: revision, confirmed: true }) as { publication: { type: string; visibility: string; summary: string } };
    assert.equal(publication.type, count === 1 ? "post" : "thread");
    assert.equal(publication.visibility, "private");
    assert.match(publication.summary, /Contenu de test fictif/);
  }
  assert.deepEqual((await published()).map(p => p.test), [true, true]);
});

test("real publication: the agent's model drafts a post and a thread, private draft, preview then confirmation", async t => {
  const { db, publications, agentId, candidate, generate, published, status } = await world(t);
  const model = fakeModel();
  const first = candidate(claims, 0.9);
  const second = candidate(claims, 0.5, "Archipel des Kerguelen, observatoire austral");
  assert.deepEqual(draftableCandidates(db, agentId).map(item => item.storyId), [first, second], "most important first");

  // Post, on the most important information by default.
  const post = await generate(model, { format: "post" });
  assert.equal(post.storyId, first);
  assert.equal(post.draft.format, "post");
  assert.equal(post.llm.model, "qwen3:1.7b");
  assert.ok(model.requests.length >= 2 && model.requests.every(request => request.model === "qwen3:1.7b"), "every call uses the agent's model");
  assert.match(model.requests[0].prompt, /Format imposé par le propriétaire : post/);
  assert.match(model.requests[0].prompt, /Affirmations vérifiées, seule matière autorisée/);
  assert.equal(status(first), "drafted");

  // The preview is a private draft with its sources: nothing published yet.
  const draft = await publications.get({ id: "alice" }, post.draft.id);
  assert.equal(draft.status, "draft"); assert.equal(draft.visibility, "private"); assert.equal(draft.type, "post");
  assert.ok(draft.sources.length >= 1);
  assert.deepEqual(await published(), []);
  await assert.rejects(generate(model, { format: "post", storyId: first }), (error: TopicError) => error.status === 409 && /déjà un brouillon/.test(error.message));

  // Thread, on an explicitly chosen information.
  const thread = await generate(model, { format: "thread", storyId: second });
  assert.equal(thread.draft.format, "thread"); assert.equal(thread.draft.messages, 2);
  assert.match(model.requests.find(request => request.prompt.includes("Format imposé par le propriétaire : thread"))!.prompt, /thread de 2 à 2 messages/);
  assert.equal((await publications.get({ id: "alice" }, thread.draft.id)).type, "thread");

  // Confirmation is the draft's own review action: private publication, real (not test) content.
  await reviewDraft({ db, publications, owner: "alice", agentId, draftId: post.draft.id, input: { action: "approve", revision: draft.revision } });
  const live = await published();
  assert.equal(live.length, 1);
  assert.equal(live[0].test, false, "real content is never marked as a fixture");
  const approved = await publications.get({ id: "alice" }, post.draft.id);
  assert.equal(approved.visibility, "private");
  assert.doesNotMatch(approved.summary + approved.messages.map(message => message.body).join(), /Contenu de test fictif/);
  assert.ok(listRuns(db, "alice", { agentId }).some(run => run.kind === "manual-generate" && run.status === "done"));
});

test("real publication: a model failure is reported as is, never replaced by fixtures", async t => {
  const { db, agentId, candidate, generate, published, status } = await world(t);
  const story = candidate();
  const model = fakeModel();
  model.setDown(true);
  await assert.rejects(generate(model, { format: "post" }), (error: TopicError) => error.status === 503 && /Raspberry Pi éteint/.test(error.message) && /qwen3:1\.7b/.test(error.message));
  // Not configured: explicit, no call.
  await assert.rejects(generate(null, { format: "post" }), (error: TopicError) => error.status === 409 && /Configuration du modèle \(not-configured\)/.test(error.message));
  // Invalid output after the bounded retries: explicit too.
  const broken = fakeModel(() => ({ nothing: true }));
  await assert.rejects(generate(broken, { format: "post" }), (error: TopicError) => error.status === 422 && /non conforme/.test(error.message));
  // A thread needs two distinct verified claims: refused before any model call, never padded.
  const single = candidate([claims[0]], 0.7, "Archipel des Kerguelen, observatoire austral");
  const counted = fakeModel();
  await assert.rejects(generate(counted, { format: "thread", storyId: single }), (error: TopicError) => error.status === 422 && /au moins deux affirmations/.test(error.message));
  assert.equal(counted.requests.length, 0);

  // Nothing written: no fixture, no draft, no publication; the information stays available.
  assert.deepEqual(await published(), []);
  assert.equal(status(story), "accepted");
  const failures = listRuns(db, "alice", { agentId }).filter(run => run.kind === "manual-generate");
  assert.equal(failures.length, 4);
  assert.ok(failures.every(run => run.status === "failed" && run.error));
});

test("real publication: owner isolation, inactive agent, nothing to draft", async t => {
  const { accounts, agentId, candidate, generate } = await world(t);
  const model = fakeModel();
  await assert.rejects(generate(model, { format: "post" }), (error: TopicError) => error.status === 409 && /Aucune information vérifiée/.test(error.message));
  candidate();
  await assert.rejects(generate(model, { format: "post" }, "bob"), (error: TopicError) => error.status === 404);
  await assert.rejects(generate(model, { format: "public" }), /invalid|format/i);
  await accounts.pauseAgent("alice", agentId, { resumeAt: null, resumeWith: "now" });
  await assert.rejects(generate(model, { format: "post" }), (error: TopicError) => error.status === 409 && /pause/.test(error.message));
  assert.equal(model.requests.length, 0);
});
