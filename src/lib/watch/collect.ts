import type Database from "better-sqlite3";
import type { WatchAgent } from "../accounts/types";
import { TopicError } from "../topics/types";
import { discoverFeeds, FeedError, parseFeed, parseJsonApi, type JsonApiMapping, type ParsedFeed } from "./feeds";
import type { JobQueue } from "./jobs";
import { FetchError, type PoliteFetch } from "./net";
import { nightWindow } from "./schedule";
import { estimateReliability, isCollectable, type Source, type SourceStore } from "./sources";
import { migrateWatchItems, recordEntries } from "./stories";
import { trustResolver } from "./trust";
import type { Handler } from "./worker";

const DAY = 86_400_000;
const LOG_PER_SOURCE = 100;

export function migrateWatchCollection(db: Database.Database) {
  migrateWatchItems(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS watch_source_state (
      source_id TEXT PRIMARY KEY,
      etag TEXT,
      last_modified TEXT,
      next_fetch_at INTEGER NOT NULL DEFAULT 0,
      last_fetch_at INTEGER,
      last_outcome TEXT,
      last_error TEXT,
      consecutive_errors INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS watch_fetch_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id TEXT NOT NULL,
      at INTEGER NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'not-modified', 'error', 'robots')),
      http_status INTEGER,
      items_new INTEGER NOT NULL DEFAULT 0,
      items_seen INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS watch_fetch_log_source ON watch_fetch_log (source_id, at);
  `);
}

type StateRow = { source_id: string; etag: string | null; last_modified: string | null; next_fetch_at: number; last_fetch_at: number | null; last_outcome: string | null; last_error: string | null; consecutive_errors: number };
export const sourceState = (db: Database.Database, id: string) => db.prepare<[string], StateRow>("SELECT * FROM watch_source_state WHERE source_id = ?").get(id) ?? null;

/** Agents whose watch runs: active, valid policy, enabled, not paused. Paused agents stop collecting too. */
export const runningAgents = (agents: WatchAgent[]) => agents.filter(agent => agent.active && agent.watch.valid && agent.watch.policy.enabled && !agent.watch.policy.paused);
const agentTopics = (agent: WatchAgent) => [agent.primaryTopicId, ...agent.secondaryTopicIds];

/** Collection jobs for due pending or approved sources used by at least one running agent of their owner. */
export function planCollection(db: Database.Database, queue: JobQueue, sources: Source[], agents: WatchAgent[], now: number) {
  migrateWatchCollection(db);
  const topicsByOwner = new Map<string, Set<string>>();
  for (const agent of runningAgents(agents)) {
    const set = topicsByOwner.get(agent.owner) ?? new Set();
    for (const topic of agentTopics(agent)) set.add(topic);
    topicsByOwner.set(agent.owner, set);
  }
  let planned = 0;
  for (const source of sources) {
    if (!isCollectable(source) || !source.topicIds.some(topic => topicsByOwner.get(source.owner)?.has(topic))) continue;
    const due = sourceState(db, source.id)?.next_fetch_at ?? 0;
    if (due > now) continue;
    if (queue.enqueue({ kind: "collect-source", key: `collect-source:${source.id}:${due}`, payload: { sourceId: source.id, owner: source.owner }, runAfter: now, maxAttempts: 3 }).created) planned++;
  }
  return planned;
}

/** One discovery pass per running agent and Paris day. */
export function planDiscovery(queue: JobQueue, agents: WatchAgent[], now: number) {
  let planned = 0;
  const day = nightWindow(new Date(now)).date;
  for (const agent of runningAgents(agents)) {
    if (queue.enqueue({ kind: "discover-sources", key: `discover-sources:${agent.id}:${day}`, payload: { agentId: agent.id }, runAfter: now, maxAttempts: 2 }).created) planned++;
  }
  return planned;
}

/** Body text in its declared charset (HTTP header, then XML declaration), UTF-8 otherwise. */
export function decodeBody(body: Buffer, contentType = "") {
  const declared = /charset\s*=\s*"?([\w-]+)/i.exec(contentType)?.[1] ?? /^\s*<\?xml[^>]*encoding\s*=\s*["']([\w-]+)["']/i.exec(body.subarray(0, 300).toString("latin1"))?.[1] ?? "utf-8";
  try { return new TextDecoder(declared).decode(body); } catch { return new TextDecoder("utf-8").decode(body); }
}

const looksLikeFeed = (text: string) => /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<(rss|feed|rdf:RDF)\b/i.test(text);
const describe = (error: unknown) => (error instanceof FetchError || error instanceof FeedError ? error.message : "Erreur inattendue.").slice(0, 300);

export function collectHandler({ db, sources, fetch, now = Date.now }: { db: Database.Database; sources: SourceStore; fetch: PoliteFetch; now?: () => number }): Handler {
  migrateWatchCollection(db);
  return async job => {
    const { sourceId, owner } = job.payload as { sourceId: string; owner: string };
    const source = await sources.get(owner, sourceId).catch(() => null);
    if (!source || !isCollectable(source)) return { status: "done", result: { outcome: "skipped", reason: "not-collectable" } };
    const state = sourceState(db, source.id);
    const started = now();
    let outcome: "ok" | "not-modified" | "error" | "robots";
    let httpStatus: number | null = null;
    let recorded = { new: 0, seen: 0 };
    let error: string | null = null;
    let next: number | undefined;
    let validators = { etag: state?.etag ?? null, lastModified: state?.last_modified ?? null };
    try {
      const response = await fetch(source.url, {
        headers: { Accept: source.kind === "json" ? "application/json" : "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8", ...(validators.etag ? { "If-None-Match": validators.etag } : {}), ...(validators.lastModified ? { "If-Modified-Since": validators.lastModified } : {}) },
      });
      httpStatus = response.status;
      if (response.status === 304) outcome = "not-modified";
      else if (response.status >= 200 && response.status < 300) {
        const text = decodeBody(response.body, response.headers["content-type"]);
        const parsed = source.kind === "json" ? parseJsonApi(text, source.api!, source.url) : parseFeed(text, source.url);
        recorded = recordEntries(db, { owner, source: { id: source.id, publisher: source.publisher, ownerGroup: source.ownerGroup, topicIds: source.topicIds }, entries: parsed.entries, now: now() });
        validators = { etag: response.headers.etag || null, lastModified: response.headers["last-modified"] || null };
        outcome = "ok";
      } else { outcome = "error"; error = `HTTP ${response.status}`; }
    } catch (caught) {
      if (caught instanceof FetchError && caught.code === "throttled") return { status: "wait", until: new Date(caught.retryAt ?? now() + 60_000), reason: "Fournisseur à ménager." };
      if (!(caught instanceof FetchError || caught instanceof FeedError)) throw caught;
      outcome = caught instanceof FetchError && caught.code === "robots" ? "robots" : "error";
      httpStatus = caught instanceof FetchError ? caught.status : httpStatus;
      error = describe(caught);
      if (caught instanceof FetchError && caught.retryAt) next = caught.retryAt;
    }
    const errors = outcome === "error" ? (state?.consecutive_errors ?? 0) + 1 : 0;
    const poll = source.pollMinutes * 60_000;
    next ??= outcome === "robots" ? now() + DAY : outcome === "error" ? now() + Math.min(poll * 2 ** errors, DAY) : now() + poll;
    const duration = now() - started;
    db.transaction(() => {
      db.prepare(`INSERT INTO watch_source_state VALUES (@source_id, @etag, @last_modified, @next_fetch_at, @last_fetch_at, @last_outcome, @last_error, @consecutive_errors)
        ON CONFLICT(source_id) DO UPDATE SET etag = excluded.etag, last_modified = excluded.last_modified, next_fetch_at = excluded.next_fetch_at,
        last_fetch_at = excluded.last_fetch_at, last_outcome = excluded.last_outcome, last_error = excluded.last_error, consecutive_errors = excluded.consecutive_errors`)
        .run({ source_id: source.id, etag: validators.etag, last_modified: validators.lastModified, next_fetch_at: next, last_fetch_at: started, last_outcome: outcome, last_error: error, consecutive_errors: errors });
      db.prepare("INSERT INTO watch_fetch_log (source_id, at, outcome, http_status, items_new, items_seen, duration_ms, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(source.id, started, outcome, httpStatus, recorded.new, recorded.seen, duration, error);
      db.prepare(`DELETE FROM watch_fetch_log WHERE source_id = ? AND id NOT IN (SELECT id FROM watch_fetch_log WHERE source_id = ? ORDER BY id DESC LIMIT ${LOG_PER_SOURCE})`).run(source.id, source.id);
    })();
    return { status: "done", result: { outcome, new: recorded.new, seen: recorded.seen, durationMs: duration } };
  };
}

/**
 * Proposal from a feed or site URL: a feed is used directly, an HTML page is searched for its
 * advertised feeds. The feed must parse and contain entries. Nothing is approved here.
 */
export async function proposeFromUrl({ fetch, sources, owner, url, topicIds, by, citedBy = 0, note = null, api = null, revive = false }: {
  fetch: PoliteFetch; sources: SourceStore; owner: string; url: string; topicIds: string[]; by: string; citedBy?: number; note?: string | null; api?: JsonApiMapping | null;
  /** The owner adding the address by hand: a deleted source comes back (pending). */
  revive?: boolean;
}) {
  const read = async (target: string) => {
    const response = await fetch(target, { headers: { Accept: api ? "application/json" : "application/rss+xml, application/atom+xml, text/html;q=0.8, */*;q=0.5" } });
    if (response.status < 200 || response.status >= 300) throw new FetchError("http", `HTTP ${response.status}`, response.status);
    return { response, text: decodeBody(response.body, response.headers["content-type"]) };
  };
  let feedUrl: string;
  let parsed: ParsedFeed;
  let site: string | null = null;
  let siteName: string | null = null;
  try {
    const first = await read(url);
    if (api) { feedUrl = first.response.url; parsed = parseJsonApi(first.text, api, feedUrl); }
    else if (looksLikeFeed(first.text)) { feedUrl = first.response.url; parsed = parseFeed(first.text, feedUrl); }
    else {
      const page = discoverFeeds(first.text, first.response.url);
      site = first.response.url; siteName = page.siteName;
      let found: { url: string; parsed: ParsedFeed } | null = null;
      for (const candidate of page.feeds.slice(0, 2)) {
        const feed = await read(candidate).catch(() => null);
        if (!feed || !looksLikeFeed(feed.text)) continue;
        const result = (() => { try { return parseFeed(feed.text, feed.response.url); } catch { return null; } })();
        if (result?.entries.length) { found = { url: feed.response.url, parsed: result }; break; }
      }
      if (!found) throw new TopicError("Aucun flux RSS ou Atom exploitable n’a été trouvé à cette adresse.", 422);
      feedUrl = found.url; parsed = found.parsed;
    }
  } catch (error) {
    if (error instanceof FetchError || error instanceof FeedError) throw new TopicError(`Source inaccessible : ${error.message}`, 422);
    throw error;
  }
  if (!parsed.entries.length) throw new TopicError("Le flux ne contient aucun article exploitable.", 422);
  return sources.propose(owner, {
    url: feedUrl, kind: api ? "json" : "feed", site: site ?? parsed.site, publisher: parsed.title ?? siteName ?? new URL(feedUrl).hostname,
    topicIds, reliability: estimateReliability({ url: feedUrl, citedBy, entries: parsed.entries }), api, note,
  }, by, { revive });
}

/** Host with its port, without "www.": the port is kept so the proposal targets what was linked. */
const host = (url: string) => { try { return new URL(url).host.toLowerCase().replace(/^www\./, ""); } catch { return null; } };
const MAX_PENDING = 20;
const PER_DAY = 3;

/**
 * Agent-driven discovery: domains linked by at least two sources approved for the agent on one of
 * its topics (trust.ts) during the last week, not yet in the owner's catalogue (any status, deleted
 * included), become proposals. At most three a day, none beyond twenty pending proposals.
 */
export function discoverHandler({ db, sources, agents, fetch, now = Date.now }: { db: Database.Database; sources: SourceStore; agents: () => Promise<WatchAgent[]>; fetch: PoliteFetch; now?: () => number }): Handler {
  migrateWatchCollection(db);
  return async job => {
    const { agentId } = job.payload as { agentId: string };
    const agent = runningAgents(await agents()).find(item => item.id === agentId);
    if (!agent) return { status: "done", result: { outcome: "skipped", reason: "not-running" } };
    const topics = new Set(agentTopics(agent));
    const { sources: catalog } = await sources.list(agent.owner, { includeDeleted: true });
    if (catalog.filter(source => source.status === "proposed").length >= MAX_PENDING) return { status: "done", result: { outcome: "skipped", reason: "too-many-pending" } };
    const known = new Set(catalog.flatMap(source => [host(source.url), source.site && host(source.site)]).filter((value): value is string => !!value));
    const trust = await trustResolver(db, sources, agent.owner);
    const approved = catalog.filter(source => source.topicIds.some(topic => topics.has(topic) && trust.source(source.id, agent.id, topic) === "approved"));
    if (!approved.length) return { status: "done", result: { outcome: "skipped", reason: "no-approved-source" } };
    // An item cites for its original source only: a feed that merely relays it is not a second citation.
    const rows = db.prepare<unknown[], { links: string; source_id: string; url: string }>(`SELECT links, source_id, url FROM watch_item
      WHERE owner = ? AND fetched_at >= ? AND source_id IN (${approved.map(() => "?").join(", ")})`).all(agent.owner, now() - 7 * DAY, ...approved.map(source => source.id));
    for (const row of rows) { const own = host(row.url); if (own) known.add(own); }
    const citing = new Map<string, Set<string>>();
    for (const row of rows) for (const link of JSON.parse(row.links) as string[]) {
      const domain = host(link);
      if (!domain || known.has(domain)) continue;
      citing.set(domain, (citing.get(domain) ?? new Set()).add(row.source_id));
    }
    const candidates = [...citing].filter(([, by]) => by.size >= 2).sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0])).slice(0, PER_DAY);
    const citingTopics = (ids: Set<string>) => [...new Set(approved.filter(source => ids.has(source.id)).flatMap(source => source.topicIds).filter(topic => topics.has(topic)))];
    let proposed = 0;
    const skipped: string[] = [];
    for (const [domain, by] of candidates) {
      let done = false;
      for (const scheme of ["https", "http"]) {
        try {
          const { created } = await proposeFromUrl({ fetch, sources, owner: agent.owner, url: `${scheme}://${domain}/`, topicIds: citingTopics(by), by: `agent:${agent.id}`, citedBy: by.size, note: `Domaine cité par ${by.size} sources approuvées cette semaine.` });
          if (created) proposed++;
          done = true;
          break;
        } catch (error) {
          if (!(error instanceof TopicError || error instanceof FetchError)) throw error;
        }
      }
      if (!done) skipped.push(domain);
    }
    return { status: "done", result: { outcome: "ok", examined: candidates.length, proposed, skipped: skipped.length } };
  };
}
