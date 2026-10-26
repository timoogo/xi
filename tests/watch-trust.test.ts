import assert from "node:assert/strict";
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
import { verificationOutcome, verifyClaims, type EvidenceSource, type Extraction } from "../src/lib/watch/evaluate";
import type { ChatRequest } from "../src/lib/watch/inference";
import { createPoliteFetch, createSafeFetch } from "../src/lib/watch/net";
import { createSourceStore } from "../src/lib/watch/sources";
import { recordEntries } from "../src/lib/watch/stories";
import { candidateBlocker } from "../src/lib/watch/diagnostics";
import { decideTrust, planTrustRecheck, resolveTrust, trustMatrix, trustResolver } from "../src/lib/watch/trust";
import { engineHandlers, tick } from "../src/lib/watch/worker";
import { bindTo } from "./helpers/llm";

const HOUR = 3_600_000;

test("resolution: a denial wins over any approval, approvals are inherited, nothing means pending", () => {
  assert.equal(resolveTrust(["pending", "pending", "pending"]), "pending");
  assert.equal(resolveTrust(["approved", "pending", "pending"]), "approved");
  assert.equal(resolveTrust(["pending", "pending", "approved"]), "approved");
  assert.equal(resolveTrust(["approved", "denied", "pending"]), "denied");
  assert.equal(resolveTrust(["approved", "approved", "denied"]), "denied");
});

test("verification under trust: pending analysed but insufficient, denied excluded, institutional statements attributed, single voices unverified", () => {
  const source = (label: string, publisher: string, lineage: number, trust: EvidenceSource["trust"], text: string, official = false): EvidenceSource =>
    ({ label, itemId: label, publisher, lineage, official, trust, url: `https://${label}.example`, title: "Titre", text });
  const claim = (text: string, kind: Extraction["claims"][number]["kind"], evidence: [string, string][], attribution: string | null = null) => ({ text, kind, attribution, evidence: evidence.map(([item, quote]) => ({ item, quote })) });
  const text = "Le conseil municipal a voté mardi la gratuité des transports scolaires.";
  const sources = [
    source("I1", "Le Quotidien", 0, "approved", text), source("I2", "La Gazette", 1, "pending", text),
    source("I3", "Le Journal", 2, "pending", text), source("I4", "Le Tabloïd", 3, "denied", text),
    source("I5", "Préfecture du Rhône", 4, "approved", "La préfecture du Rhône a annoncé mardi la fermeture de trois écoles.", true),
    source("I6", "Ministère du Travail", 5, "pending", "Le ministère du Travail a annoncé mardi un plan pour l'emploi.", true),
  ];
  const quote = "a voté mardi la gratuité des transports scolaires";
  const extraction: Extraction = {
    claims: [
      claim("Gratuité votée (une voix en attente).", "fact", [["I2", quote]]),
      claim("Gratuité votée (deux voix en attente).", "fact", [["I2", quote], ["I3", quote]]),
      claim("Gratuité votée (approuvée et en attente).", "fact", [["I1", quote], ["I2", quote]]),
      claim("Gratuité votée (source approuvée seule).", "fact", [["I1", quote]]),
      claim("Gratuité votée (source refusée).", "fact", [["I4", quote]]),
      claim("Gratuité votée (approuvée et refusée).", "fact", [["I1", quote], ["I4", quote]]),
      claim("La préfecture annonce la fermeture de trois écoles.", "attributed", [["I5", "a annoncé mardi la fermeture de trois écoles"]], "Préfecture du Rhône"),
      claim("Trois écoles ferment.", "fact", [["I5", "a annoncé mardi la fermeture de trois écoles"]]),
      claim("Le ministère annonce un plan pour l'emploi.", "attributed", [["I6", "a annoncé mardi un plan pour l'emploi"]], "Ministère du Travail"),
    ],
    contradictions: [], impact: { score: 0.5, reasons: ["Local."] },
  };
  const { claims } = verifyClaims(extraction, sources);
  assert.deepEqual(claims.map(c => c.status), ["pending-trust", "pending-trust", "corroborated", "single-source", "unsupported", "single-source", "primary", "primary", "pending-trust"]);
  assert.match(claims[0].reason, /en attente/);
  assert.equal(claims[1].independent, 2, "pending voices are analysed and counted, they just cannot establish alone");
  assert.equal(claims[2].independent, 2, "a pending voice corroborates an approved one");
  assert.match(claims[4].reason, /refusée/);
  assert.deepEqual([claims[5].independent, claims[5].rejectedQuotes], [1, 1], "a denied voice is no evidence");
  assert.match(claims[6].reason, /primaire/, "an approved institution is primary for its own announcement, attributed to it");
  assert.deepEqual([claims[7].kind, claims[7].attribution, claims[7].independent], ["attributed", "Préfecture du Rhône", 1], "what it states is attributed to it, never a corroborated bare fact");
  assert.equal(claims[8].status, "pending-trust", "a pending institution is not primary");
  assert.equal(verificationOutcome(claims.slice(0, 2)).level, "insufficient");
  assert.match(verificationOutcome(claims.slice(0, 2)).reason, /Aucune source approuvée/);
  assert.equal(verificationOutcome([claims[3]]).level, "insufficient", "an uncorroborated claim stays unverified");
  assert.equal(verificationOutcome([claims[4]]).level, "unsupported");
  assert.equal(verificationOutcome([claims[2]]).level, "verified");
});

type Stage = "relevance" | "merge" | "novelty" | "extraction";
const label = (prompt: string, publisher: string) => new RegExp(`\\[(I\\d+)\\] ${publisher}( \\(publication officielle de l’institution\\))?\\n`).exec(prompt)?.[1] ?? null;

async function world(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "xi-watch-trust-"));
  const db = new Database(join(root, "app.sqlite"));
  db.pragma("journal_mode = WAL"); db.pragma("busy_timeout = 5000");
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  const vault = await openVault(root);
  const topics = createTopicStore({ vault, db });
  const accounts = createAccountStore({ vault, db, topics });
  const sources = createSourceStore({ vault, topics });
  const topic = async (owner: string, tag: string, name: string) => {
    const run = await topics.propose(owner, name);
    await topics.confirm(owner, run.id, { tag, name, description: "Test", scope: `${name} : actualité fictive.`, parentId: null, relatedIds: [] }, true);
    return run.topicId;
  };
  const agent = async (owner: string, primary: string, secondary: string[] = []) => {
    const proposed = await accounts.propose(owner, primary);
    const ready = await accounts.resume(owner, proposed.id);
    await accounts.confirm(owner, ready.id, { ...ready.draft!, secondaryTopicIds: secondary, modelRef: "modele-local" }, true);
    await accounts.setWatchPolicy(owner, ready.accountId, { revision: null, policy: { ...DEFAULT_WATCH_POLICY, enabled: true } });
    return ready.accountId;
  };
  const source = async (owner: string, host: string, publisher: string, topicIds: string[], approve = false) => {
    const { source } = await sources.propose(owner, { url: `https://${host}/rss`, kind: "feed", site: null, publisher, topicIds, reliability: { level: "inconnue", reasons: [], estimated: true } }, `agent:discovery`);
    return approve ? sources.decide(owner, source.id, { action: "approve", revision: source.revision }) : source;
  };
  return { root, db, vault, topics, accounts, sources, topic, agent, source };
}

test("trust decisions: scopes, inheritance, denial priority, revocation, isolation between owners", async t => {
  const w = await world(t);
  const politiks = await w.topic("alice", "politiks", "Politique"), sciencia = await w.topic("alice", "sciencia", "Sciences");
  const alpha = await w.agent("alice", politiks), beta = await w.agent("alice", sciencia, [politiks]);
  const bobAgent = await w.agent("bob", politiks);
  const feed = await w.source("alice", "gazette.example", "La Gazette", [politiks]);
  let clock = Date.parse("2026-03-10T10:00:00Z");
  const deps = { db: w.db, accounts: w.accounts, topics: w.topics, sources: w.sources, now: () => new Date(clock) };
  const decide = (input: Record<string, unknown>, owner = "alice") => decideTrust(deps, owner, input);
  const resolve = async (agentId: string, topicId: string | null) => (await trustResolver(w.db, w.sources, "alice")).source(feed.id, agentId, topicId);

  // No decision: pending everywhere; the matrix lists the discovered source with its origin.
  assert.deepEqual([await resolve(alpha, politiks), await resolve(beta, politiks)], ["pending", "pending"]);
  const matrix = await trustMatrix(deps, "alice");
  assert.deepEqual(matrix.sources.map(s => [s.publisher, s.domain, s.origin.kind]), [["La Gazette", "gazette.example", "agent"]]);
  assert.deepEqual(matrix.agents.map(a => a.id).sort(), [alpha, beta].sort(), "only the owner's agents");
  assert.deepEqual(matrix.decisions, []);

  // Agent scope: only that agent.
  const agentApproval = await decide({ sourceId: feed.id, scope: "agent", scopeId: alpha, decision: "approved" });
  assert.equal(agentApproval.changed, true);
  assert.deepEqual([await resolve(alpha, politiks), await resolve(beta, politiks)], ["approved", "pending"]);
  // Topic scope: every agent following it, for stories retained on that topic only.
  await decide({ sourceId: feed.id, scope: "topic", scopeId: politiks, decision: "approved" });
  assert.deepEqual([await resolve(beta, politiks), await resolve(beta, sciencia), await resolve(beta, null)], ["approved", "pending", "pending"]);
  // A denial for beta wins over the inherited topic approval; alpha keeps its approval.
  await decide({ sourceId: feed.id, scope: "agent", scopeId: beta, decision: "denied" });
  assert.deepEqual([await resolve(beta, politiks), await resolve(alpha, politiks)], ["denied", "approved"]);
  // Global approval: inherited everywhere, except where a denial applies.
  const global = await decide({ sourceId: feed.id, scope: "global", scopeId: null, decision: "approved", revision: feed.revision });
  assert.equal(global.changed, true);
  assert.deepEqual([await resolve(alpha, sciencia), await resolve(beta, sciencia)], ["approved", "denied"]);
  // A global denial wins over every approval; the stale revision is refused.
  await assert.rejects(decide({ sourceId: feed.id, scope: "global", scopeId: null, decision: "denied", revision: feed.revision }), /changé/);
  let current = await w.sources.get("alice", feed.id);
  await decide({ sourceId: feed.id, scope: "global", scopeId: null, decision: "denied", revision: current.revision });
  assert.deepEqual([await resolve(alpha, politiks), await resolve(beta, politiks)], ["denied", "denied"]);
  // Rehabilitation: back to pending (no global decision), the scoped decisions apply again.
  current = await w.sources.get("alice", feed.id);
  await decide({ sourceId: feed.id, scope: "global", scopeId: null, decision: "pending", revision: current.revision });
  current = await w.sources.get("alice", feed.id);
  assert.equal(current.status, "proposed");
  assert.deepEqual(current.history.map(h => h.action), ["proposed", "approved", "rejected", "updated"], "every decision traced, readable by earlier versions");
  assert.deepEqual(current.history.at(-1)!.changes, { status: "proposed" });
  assert.deepEqual([await resolve(alpha, politiks), await resolve(beta, politiks)], ["approved", "denied"]);
  // Revocation of a scoped decision, and a repeated value changes nothing.
  await decide({ sourceId: feed.id, scope: "agent", scopeId: beta, decision: "pending" });
  assert.equal(await resolve(beta, politiks), "approved", "topic approval inherited again");
  assert.deepEqual(await decide({ sourceId: feed.id, scope: "agent", scopeId: beta, decision: "pending" }).then(r => [r.changed, r.rechecked]), [false, 0]);
  clock += HOUR;
  const decisions = (await trustMatrix(deps, "alice")).decisions;
  assert.deepEqual(decisions.map(d => [d.scope, d.scopeId, d.decision, d.by]).sort(), [["agent", alpha, "approved", "alice"], ["topic", politiks, "approved", "alice"]].sort());
  assert.ok(decisions.every(d => !Number.isNaN(Date.parse(d.at))), "author and date of each decision");

  // Isolation: another owner can neither see nor decide, nor target a foreign agent or an unfollowed topic.
  await assert.rejects(decide({ sourceId: feed.id, scope: "global", scopeId: null, decision: "approved", revision: current.revision }, "bob"), /introuvable/);
  await assert.rejects(decide({ sourceId: feed.id, scope: "agent", scopeId: bobAgent, decision: "approved" }), /ΞAgent introuvable/);
  const foreignTopic = await w.topic("bob", "footix", "Football");
  await assert.rejects(decide({ sourceId: feed.id, scope: "topic", scopeId: foreignTopic, decision: "approved" }), /Topic introuvable/);
  await assert.rejects(decide({ sourceId: feed.id, scope: "global", scopeId: null, decision: "approved" }), /Révision/);
  await assert.rejects(decide({ sourceId: feed.id, scope: "agent", scopeId: null, decision: "approved" }));
  await assert.rejects(decide({ sourceId: feed.id, scope: "agent", scopeId: alpha, decision: "approved", extra: true }));
  assert.deepEqual((await trustMatrix(deps, "bob")).sources, []);
  const bobFeed = await w.source("bob", "gazette.example", "La Gazette", [politiks]);
  assert.equal((await trustResolver(w.db, w.sources, "bob")).source(bobFeed.id, bobAgent, politiks), "pending", "alice's decisions never apply to bob's catalogue");
  assert.equal((await trustResolver(w.db, w.sources, "bob")).source(feed.id, bobAgent, politiks), "denied", "a source outside the owner's catalogue is never usable");
});

test("pipeline: pending sources analysed but held, trust changes re-checked once, denials excluded, rehabilitation, no draft or publication", { timeout: 60_000 }, async t => {
  const w = await world(t);
  const politiks = await w.topic("alice", "politiks", "Politique");
  const agentId = await w.agent("alice", politiks);
  const gazette = await w.source("alice", "gazette.example", "La Gazette", [politiks]);
  const journal = await w.source("alice", "journal.example", "Le Journal", [politiks]);
  let clock = Date.parse("2026-03-10T10:00:00Z");
  const entry = (host: string, title: string, summary: string) => ({ url: `https://${host}/${Math.random().toString(36).slice(2)}`, guid: null, title, summary, publishedAt: new Date(clock - HOUR).toISOString(), author: null, credits: [], links: [] });
  recordEntries(w.db, { owner: "alice", source: { ...gazette, ownerGroup: null }, entries: [entry("gazette.example", "Le conseil municipal de Lyon vote la gratuité des cantines scolaires", "Le conseil municipal de Lyon a voté lundi la gratuité des cantines scolaires.")], now: clock });
  recordEntries(w.db, { owner: "alice", source: { ...journal, ownerGroup: null }, entries: [entry("journal.example", "Gratuité des cantines scolaires : vote du conseil municipal de Lyon", "Les élus lyonnais ont adopté lundi la gratuité des cantines scolaires pour la rentrée.")], now: clock });
  const stories = w.db.prepare("SELECT id, independent_count FROM watch_story").all() as { id: string; independent_count: number }[];
  assert.equal(stories.length, 1, "one event");
  const story = stories[0];
  assert.equal(story.independent_count, 2);

  const calls: Stage[] = [];
  const inference = {
    async complete({ prompt }: ChatRequest) {
      const stage: Stage = prompt.startsWith("Périmètre") ? "relevance" : prompt.startsWith("Actualité A") ? "merge" : prompt.startsWith("Nouvelle actualité") ? "novelty" : "extraction";
      calls.push(stage);
      if (stage === "relevance") return JSON.stringify({ relevant: true, score: 0.9, topic: "T1", justification: "Décision locale.", outOfScope: [] });
      if (stage === "merge") return JSON.stringify({ sameEvent: null, justification: "Distinct." });
      if (stage === "novelty") return JSON.stringify({ kind: "new", related: null, score: 1, newFacts: [], justification: "Nouveau." });
      const evidence = [["La Gazette", "a voté lundi la gratuité des cantines scolaires"], ["Le Journal", "ont adopté lundi la gratuité des cantines scolaires"]]
        .map(([publisher, quote]) => ({ item: label(prompt, publisher), quote })).filter(proof => proof.item);
      return JSON.stringify({ claims: [{ text: "Lyon rend les cantines scolaires gratuites.", kind: "fact", attribution: null, evidence }], contradictions: [], impact: { score: 0.8, reasons: ["Familles concernées."] } });
    },
  };
  const publications = createPublicationStore({ vault: w.vault, db: w.db });
  const handlers = engineHandlers({ db: w.db, accounts: w.accounts, topics: w.topics, publications, sources: w.sources, fetch: createPoliteFetch({ db: w.db, fetch: createSafeFetch() }), llm: bindTo(inference), settings: { autoPublish: true, allowPublic: true }, now: () => new Date(clock) });
  // Evaluation only: no drafting nor publication handler can run here.
  const run = () => tick({ db: w.db, accounts: w.accounts, sources: w.sources, handlers: { "evaluate-story": handlers["evaluate-story"] }, canEvaluate: () => true, now: () => new Date(clock) });
  const deps = { db: w.db, accounts: w.accounts, topics: w.topics, sources: w.sources, now: () => new Date(clock) };
  const candidate = () => w.db.prepare("SELECT status, reason, data FROM watch_candidate WHERE agent_id = ? AND story_id = ?").get(agentId, story.id) as { status: string; reason: string; data: string };
  const claims = () => (w.db.prepare("SELECT status, independent_count AS n FROM watch_claim WHERE agent_id = ? AND story_id = ?").all(agentId, story.id) as { status: string; n: number }[]).map(c => [c.status, c.n]);
  const count = (sql: string) => (w.db.prepare(sql).get() as { n: number }).n;

  // Two independent pending voices: analysed, results kept, never enough alone.
  await run();
  assert.equal(candidate().status, "held");
  assert.match(candidate().reason, /Aucune source approuvée/);
  assert.deepEqual(claims(), [["pending-trust", 2]]);
  assert.deepEqual(calls, ["relevance", "extraction"]);

  // Approval for this agent: one re-check job, replayed from the stored stages without asking the model again.
  const approval = await decideTrust(deps, "alice", { sourceId: gazette.id, scope: "agent", scopeId: agentId, decision: "approved" });
  assert.equal(approval.rechecked, 1);
  assert.equal(planTrustRecheck(w.db, { owner: "alice", sourceId: gazette.id, scope: "global", scopeId: null, now: clock }), 0, "never two queued re-checks for one candidate");
  clock += 60_000;
  await run();
  assert.equal(candidate().status, "accepted");
  assert.deepEqual(claims(), [["corroborated", 2]], "an approved voice corroborated by a pending one");
  assert.equal(calls.length, 2, "no new inference: same usable articles");
  const sources = (JSON.parse(candidate().data) as { sources: { publisher: string; trust: string }[] }).sources.map(s => [s.publisher, s.trust]).sort();
  assert.deepEqual(sources, [["La Gazette", "approved"], ["Le Journal", "pending"]]);

  // Global denial of the other voice: excluded from the evidence, extraction asked again on the remaining article.
  await decideTrust(deps, "alice", { sourceId: journal.id, scope: "global", scopeId: null, decision: "denied", revision: journal.revision });
  clock += 60_000;
  await run();
  assert.equal(candidate().status, "held");
  assert.deepEqual(claims(), [["single-source", 1]], "an uncorroborated claim stays unverified");
  assert.deepEqual(calls.slice(2), ["extraction"]);
  assert.ok(!(JSON.parse(candidate().data) as { sources: { publisher: string }[] }).sources.some(s => s.publisher === "Le Journal"), "a denied source is no evidence");

  // Rehabilitation from the matrix: back to pending, the corroboration returns.
  const denied = await w.sources.get("alice", journal.id);
  await decideTrust(deps, "alice", { sourceId: journal.id, scope: "global", scopeId: null, decision: "pending", revision: denied.revision });
  clock += 60_000;
  await run();
  assert.equal(candidate().status, "accepted");
  assert.deepEqual(claims(), [["corroborated", 2]]);
  // A repeated tick replays nothing; nothing was drafted or published.
  const jobs = count("SELECT count(*) AS n FROM watch_job WHERE kind = 'evaluate-story'");
  await run();
  assert.equal(count("SELECT count(*) AS n FROM watch_job WHERE kind = 'evaluate-story'"), jobs);
  assert.equal(count("SELECT count(*) AS n FROM watch_job WHERE kind IN ('draft-candidate', 'publish-alert')"), 0);
  assert.equal(count("SELECT count(*) AS n FROM publication"), 0);

  // A drafted candidate is never re-opened by a trust change: its draft is checked when it is published.
  w.db.prepare("UPDATE watch_candidate SET status = 'drafted', data = json_set(data, '$.draft', json('{\"id\":\"d1\",\"revision\":\"r1\"}')) WHERE story_id = ?").run(story.id);
  const latest = await w.sources.get("alice", journal.id);
  assert.equal((await decideTrust(deps, "alice", { sourceId: journal.id, scope: "global", scopeId: null, decision: "approved", revision: latest.revision })).rechecked, 0);
  // Re-check payloads are inert on such a candidate even if one were queued.
  const evaluate = handlers["evaluate-story"];
  const result = await evaluate({ id: "j", kind: "evaluate-story", key: "k", payload: { agentId, storyId: story.id, version: 2, recheck: true }, state: "running", runAfter: 0, attempts: 1, maxAttempts: 3, leaseToken: "t", leaseUntil: 0, lastError: null, result: null, createdAt: 0, updatedAt: 0 });
  assert.deepEqual((result as { result: { outcome: string } }).result.outcome, "already-evaluated");
  assert.equal(candidate().status, "drafted");

  // Deleting a source is not a denial and re-opens nothing: no job, candidate, claims and history untouched.
  const snapshot = () => JSON.stringify([w.db.prepare("SELECT * FROM watch_job ORDER BY id").all(), w.db.prepare("SELECT * FROM watch_candidate").all(), w.db.prepare("SELECT * FROM watch_claim").all(), w.db.prepare("SELECT * FROM watch_item").all()]);
  const before = snapshot();
  const current = await w.sources.get("alice", gazette.id);
  await w.sources.decide("alice", gazette.id, { action: "delete", revision: current.revision });
  assert.equal(snapshot(), before);
  await run();
  assert.equal(snapshot(), before, "a tick after the deletion changes nothing");
  assert.equal(candidate().status, "drafted");
  assert.equal(count("SELECT count(*) AS n FROM publication"), 0);
  assert.ok(!(await w.sources.collectable()).some(source => source.id === gazette.id), "never collected again");
  assert.equal((await trustResolver(w.db, w.sources, "alice")).source(gazette.id, agentId, politiks), "denied", "its articles are no evidence any more");
  assert.ok(!(await trustMatrix(deps, "alice")).sources.some(source => source.id === gazette.id));
  await assert.rejects(decideTrust(deps, "alice", { sourceId: gazette.id, scope: "agent", scopeId: agentId, decision: "approved" }), /introuvable/);
});

test("diagnostics: where a candidate stops on the way to a publication", () => {
  const base = { reason: null, lane: null, claims: [], draftJob: null };
  assert.deepEqual(candidateBlocker({ ...base, status: "held", reason: "Corroboration insuffisante.", claims: [{ status: "single-source" }, { status: "single-source" }, { status: "unsupported" }] }, [], null),
    { step: "évaluation", reason: "Corroboration insuffisante. Affirmations : 2 une seule voix, 1 sans citation valide." });
  assert.equal(candidateBlocker({ ...base, status: "accepted", lane: "weekly" }, [], null).reason, "Importance sous le seuil de la fenêtre nocturne : réservée au bilan hebdomadaire du dimanche.");
  assert.match(candidateBlocker({ ...base, status: "accepted", lane: "night", draftJob: { state: "failed", lastError: "Délai dépassé" } }, [], null).reason, /Rédaction échouée : Délai dépassé/);
  assert.deepEqual(candidateBlocker({ ...base, status: "drafted", lane: "night" }, ["Mode autonome désactivé pour ce ΞAgent."], "2026-10-27T03:02:00.000Z"), { step: "publication", reason: "Mode autonome désactivé pour ce ΞAgent." });
  assert.match(candidateBlocker({ ...base, status: "drafted", lane: "night" }, [], "2026-10-27T03:02:00.000Z").reason, /prochaine fenêtre \(2026-10-27T03:02:00.000Z\)/);
  assert.equal(candidateBlocker({ ...base, status: "published" }, [], null).step, "publiée");
});
