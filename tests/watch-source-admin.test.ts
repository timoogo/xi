import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { createAccountStore } from "../src/lib/accounts/store";
import { DEFAULT_WATCH_POLICY } from "../src/lib/accounts/types";
import { openVault } from "../src/lib/publications/vault";
import { createTopicStore } from "../src/lib/topics/store";
import { migrateWatchCollection, proposeFromUrl } from "../src/lib/watch/collect";
import type { PoliteFetch } from "../src/lib/watch/net";
import { createSource, sourceDetail, updateSource } from "../src/lib/watch/source-admin";
import { createSourceStore, normalizeSourceUrl } from "../src/lib/watch/sources";
import { recordEntries } from "../src/lib/watch/stories";
import { decideTrust } from "../src/lib/watch/trust";

const rss = (title: string, link: string) => `<?xml version="1.0"?><rss version="2.0"><channel><title>${title}</title><link>https://example.org/</link>
  <item><title>Un article</title><link>${link}</link><description>Texte.</description><pubDate>Thu, 15 Jan 2026 09:00:00 GMT</pubDate></item></channel></rss>`;

/** Stub of the polite fetcher: a site page linking its feed, and feeds; every request is recorded. */
function stubFetch(pages: Record<string, { type: string; body: string }>) {
  const requests: string[] = [];
  const fetch = (async (url: string) => {
    requests.push(url);
    const page = pages[url];
    return page ? { status: 200, url, headers: { "content-type": page.type }, body: Buffer.from(page.body) } : { status: 404, url, headers: {}, body: Buffer.from("") };
  }) as unknown as PoliteFetch;
  return { fetch, requests };
}

async function world(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "xi-source-admin-"));
  const db = new Database(join(root, "app.sqlite"));
  db.pragma("journal_mode = WAL"); db.pragma("busy_timeout = 5000");
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  const vault = await openVault(root);
  const topics = createTopicStore({ vault, db });
  const accounts = createAccountStore({ vault, db, topics });
  const sources = createSourceStore({ vault, topics });
  const topic = async (owner: string, tag: string) => {
    const run = await topics.propose(owner, tag);
    await topics.confirm(owner, run.id, { tag, name: tag, description: "Test", scope: `${tag} : actualité fictive.`, parentId: null, relatedIds: [] }, true);
    return run.topicId;
  };
  const agent = async (owner: string, primary: string) => {
    const proposed = await accounts.propose(owner, primary);
    const ready = await accounts.resume(owner, proposed.id);
    await accounts.confirm(owner, ready.id, { ...ready.draft!, modelRef: "modele-local" }, true);
    await accounts.setWatchPolicy(owner, ready.accountId, { revision: null, policy: { ...DEFAULT_WATCH_POLICY, enabled: true } });
    return ready.accountId;
  };
  const { fetch, requests } = stubFetch({
    "https://gazette.example/": { type: "text/html", body: `<html><head><title>La Gazette</title><link rel="alternate" type="application/rss+xml" href="https://gazette.example/rss"></head></html>` },
    "https://gazette.example/rss": { type: "application/rss+xml", body: rss("La Gazette", "https://gazette.example/a1") },
    "https://journal.example/feed": { type: "application/rss+xml", body: rss("Le Journal", "https://journal.example/j1") },
  });
  return { db, topics, accounts, sources, topic, agent, fetch, requests, deps: { db, accounts, topics, sources, fetch } };
}

test("URL normalization: scheme added, tracking and fragment removed, only http(s) without credentials", () => {
  assert.equal(normalizeSourceUrl("  gazette.example/rss  "), "https://gazette.example/rss");
  assert.equal(normalizeSourceUrl("https://Gazette.example/rss?utm_source=x#top"), "https://gazette.example/rss");
  for (const bad of ["ftp://gazette.example/rss", "javascript:alert(1)", "https://user:pw@gazette.example/rss", "http://"]) assert.throws(() => normalizeSourceUrl(bad), /Adresse|http|identifiants/, bad);
});

test("creation, duplicates, permissions, edits, collection switch, detail and revival", async t => {
  const w = await world(t);
  const politiks = await w.topic("alice", "politiks");
  const sport = await w.topic("bob", "sport");
  const agentId = await w.agent("alice", politiks);
  await w.agent("bob", sport);

  // Creation by site address: feed discovered, created pending, attributed to the owner.
  const created = await createSource(w.deps, "alice", { url: "gazette.example", topicIds: [politiks] });
  assert.deepEqual([created.created, created.duplicate, created.source.status, created.source.url, created.source.site, created.source.proposedBy], [true, false, "proposed", "https://gazette.example/rss", "https://gazette.example/", "alice"]);
  const gazette = created.source;

  // Duplicates are recognized before any request: by feed and by site address, tracking ignored.
  w.requests.length = 0;
  for (const url of ["https://gazette.example/rss?utm_medium=x", "http://www.gazette.example/rss", "https://gazette.example/"]) {
    const again = await createSource(w.deps, "alice", { url, topicIds: [politiks] });
    assert.deepEqual([again.duplicate, again.created, again.source.id], [true, false, gazette.id], url);
  }
  assert.deepEqual(w.requests, [], "no request for a known address");
  assert.equal((await w.sources.list("alice")).sources.length, 1);

  // Permissions: topics must be followed by the owner's agents; another owner has a separate catalogue.
  await assert.rejects(createSource(w.deps, "alice", { url: "journal.example/feed", topicIds: [sport] }), /topics suivis/);
  await assert.rejects(createSource(w.deps, "alice", { url: "ftp://journal.example/feed", topicIds: [politiks] }), /http/);
  await assert.rejects(createSource(w.deps, "alice", { url: "https://gazette.example/", topicIds: [] }));
  await assert.rejects(createSource(w.deps, "alice", { url: "https://gazette.example/", topicIds: [politiks], extra: 1 }));
  const bobs = await createSource(w.deps, "bob", { url: "https://gazette.example/rss", topicIds: [sport] });
  assert.ok(bobs.created && bobs.source.id !== gazette.id);
  await assert.rejects(sourceDetail(w.deps, "bob", gazette.id), /introuvable/);
  await assert.rejects(updateSource(w.deps, "bob", gazette.id, { action: "approve", revision: gazette.revision }), /introuvable/);
  await assert.rejects(decideTrust(w.deps, "bob", { sourceId: gazette.id, scope: "global", scopeId: null, decision: "denied", revision: gazette.revision }), /introuvable/);

  // Edits: metadata, foreign topics refused, stale revision refused.
  const edited = await updateSource(w.deps, "alice", gazette.id, { action: "update", revision: gazette.revision, edits: { publisher: "La Gazette du Rhône", ownerGroup: "Groupe Presse", pollMinutes: 120, reliability: "moyenne" } });
  assert.deepEqual([edited.publisher, edited.ownerGroup, edited.pollMinutes, edited.reliability.level, edited.reliability.estimated, edited.status], ["La Gazette du Rhône", "Groupe Presse", 120, "moyenne", false, "proposed"]);
  await assert.rejects(updateSource(w.deps, "alice", gazette.id, { action: "update", revision: edited.revision, edits: { topicIds: [sport] } }), /topics suivis/);
  await assert.rejects(updateSource(w.deps, "alice", gazette.id, { action: "update", revision: gazette.revision, edits: { pollMinutes: 30 } }), /a changé/);

  // Collection switch: a pending source can be disabled and comes back pending; an approved one comes back approved.
  const off = await updateSource(w.deps, "alice", gazette.id, { action: "disable", revision: edited.revision });
  assert.equal(off.status, "disabled");
  assert.ok(!(await w.sources.collectable()).some(source => source.id === gazette.id));
  assert.equal((await sourceDetail(w.deps, "alice", gazette.id)).source.reenableAs, "proposed");
  const on = await updateSource(w.deps, "alice", gazette.id, { action: "enable", revision: off.revision });
  assert.equal(on.status, "proposed");
  const approved = await updateSource(w.deps, "alice", gazette.id, { action: "approve", revision: on.revision });
  const off2 = await updateSource(w.deps, "alice", gazette.id, { action: "disable", revision: approved.revision });
  const on2 = await updateSource(w.deps, "alice", gazette.id, { action: "enable", revision: off2.revision });
  assert.equal(on2.status, "approved");
  await assert.rejects(updateSource(w.deps, "alice", gazette.id, { action: "enable", revision: on2.revision }), /impossible/);
  assert.deepEqual(on2.history.map(entry => entry.action), ["proposed", "updated", "disabled", "updated", "approved", "disabled", "approved"]);

  // Detail: nothing invented before the first collection, then the collected articles (web links only) and trust per agent and topic.
  let detail = await sourceDetail(w.deps, "alice", gazette.id);
  assert.deepEqual([detail.collector.lastFetchAt, detail.collector.lastOutcome, detail.collector.fetches, detail.items], [null, null, [], []]);
  assert.deepEqual(detail.effective, [{ agentId, trust: "approved", topics: [{ topicId: politiks, trust: "approved" }] }]);
  await decideTrust(w.deps, "alice", { sourceId: gazette.id, scope: "topic", scopeId: politiks, decision: "denied" });
  migrateWatchCollection(w.db);
  w.db.prepare("INSERT INTO watch_source_state (source_id, next_fetch_at, last_fetch_at, last_outcome, last_error, consecutive_errors) VALUES (?, ?, ?, 'error', 'HTTP 503', 2)").run(gazette.id, Date.parse("2026-01-15T11:00:00Z"), Date.parse("2026-01-15T10:00:00Z"));
  w.db.prepare("INSERT INTO watch_fetch_log (source_id, at, outcome, http_status, duration_ms, error) VALUES (?, ?, 'error', 503, 12, 'HTTP 503')").run(gazette.id, Date.parse("2026-01-15T10:00:00Z"));
  const entry = (url: string, title: string) => ({ url, guid: null, title, summary: "Texte.", publishedAt: null, author: null, credits: [], links: [] });
  recordEntries(w.db, { owner: "alice", source: { id: gazette.id, publisher: "La Gazette", ownerGroup: null, topicIds: [politiks] }, entries: [entry("https://gazette.example/a1", "Un article"), entry("https://gazette.example/a2", "Un autre article")], now: Date.parse("2026-01-15T10:00:00Z") });
  recordEntries(w.db, { owner: "bob", source: { id: bobs.source.id, publisher: "La Gazette", ownerGroup: null, topicIds: [sport] }, entries: [entry("https://gazette.example/b1", "Article de Bob")], now: Date.parse("2026-01-15T10:00:00Z") });
  detail = await sourceDetail(w.deps, "alice", gazette.id);
  assert.deepEqual(detail.effective, [{ agentId, trust: "approved", topics: [{ topicId: politiks, trust: "denied" }] }], "a topic denial wins for stories of that topic");
  assert.deepEqual([detail.collector.lastOutcome, detail.collector.lastError, detail.collector.consecutiveErrors, detail.collector.fetches.length], ["error", "HTTP 503", 2, 1]);
  assert.deepEqual(detail.items.map(item => [item.title, item.url, item.publishedAt]).sort(), [["Un article", "https://gazette.example/a1", null], ["Un autre article", "https://gazette.example/a2", null]]);
  assert.deepEqual(detail.decisions.map(entry => `${entry.scope}:${entry.decision}`).sort(), ["global:approved", "topic:denied"]);

  // Deletion: a tombstone, distinct from a denial; never re-discovered, revived only by the owner adding it again.
  const deleted = await updateSource(w.deps, "alice", gazette.id, { action: "delete", revision: on2.revision });
  assert.equal(deleted.status, "deleted");
  await assert.rejects(sourceDetail(w.deps, "alice", gazette.id), /introuvable/);
  const rediscovered = await proposeFromUrl({ fetch: w.fetch, sources: w.sources, owner: "alice", url: "https://gazette.example/rss", topicIds: [politiks], by: `agent:${agentId}` });
  assert.deepEqual([rediscovered.created, rediscovered.source.status], [false, "deleted"], "discovery never brings a deleted source back");
  const revived = await createSource(w.deps, "alice", { url: "https://gazette.example/", topicIds: [politiks] });
  assert.deepEqual([revived.revived, revived.duplicate, revived.source.id, revived.source.status], [true, false, gazette.id, "proposed"]);
  assert.equal(revived.source.history.at(-2)?.action, "deleted", "the history is kept");
  // A denied source stays denied when it is added again: reported as known.
  const journal = await createSource(w.deps, "alice", { url: "https://journal.example/feed", topicIds: [politiks] });
  await updateSource(w.deps, "alice", journal.source.id, { action: "reject", revision: journal.source.revision });
  const again = await createSource(w.deps, "alice", { url: "https://journal.example/feed", topicIds: [politiks] });
  assert.deepEqual([again.duplicate, again.source.status], [true, "rejected"]);
});
