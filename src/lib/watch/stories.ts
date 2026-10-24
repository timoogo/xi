import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { FeedEntry } from "./feeds";

/**
 * Collected items and stories (one event, several articles). Operational data in SQLite, owner
 * scoped. Deterministic heuristics only: relevance and verification come later, with local models.
 */
export function migrateWatchItems(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS watch_story (
      id TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      title TEXT NOT NULL,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      first_published_at TEXT,
      item_count INTEGER NOT NULL,
      publisher_count INTEGER NOT NULL,
      independent_count INTEGER NOT NULL,
      topic_ids TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS watch_story_recent ON watch_story (owner, last_seen_at);
    CREATE TABLE IF NOT EXISTS watch_item (
      id TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      url_key TEXT NOT NULL,
      url TEXT NOT NULL,
      original_url TEXT NOT NULL,
      guid TEXT,
      source_id TEXT NOT NULL,
      publisher TEXT NOT NULL,
      owner_group TEXT,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      author TEXT,
      published_at TEXT,
      fetched_at INTEGER NOT NULL,
      credits TEXT NOT NULL,
      links TEXT NOT NULL,
      topic_ids TEXT NOT NULL,
      story_id TEXT NOT NULL,
      lineage INTEGER NOT NULL DEFAULT 0,
      UNIQUE (owner, url_key)
    );
    CREATE INDEX IF NOT EXISTS watch_item_recent ON watch_item (owner, fetched_at);
    CREATE INDEX IF NOT EXISTS watch_item_story ON watch_item (story_id);
    CREATE INDEX IF NOT EXISTS watch_item_guid ON watch_item (source_id, guid);
    -- Every source that carried an item: provenance survives exact duplicates.
    CREATE TABLE IF NOT EXISTS watch_item_seen (
      item_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      first_seen_at INTEGER NOT NULL,
      PRIMARY KEY (item_id, source_id)
    );
  `);
}

const TRACKING = /^(utm_.*|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|xtor|at_.*|_ga|igshid|ref|ref_src|cmpid|ito|ocid|s_cid|outputtype|amp)$/i;

/** Normalized URL (no fragment, no tracking or AMP parameters, sorted query) and its comparison key. */
export function canonicalUrl(raw: string) {
  const url = new URL(raw);
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  for (const key of [...url.searchParams.keys()]) if (TRACKING.test(key)) url.searchParams.delete(key);
  url.searchParams.sort();
  url.pathname = url.pathname.replace(/\/{2,}/g, "/").replace(/\/amp\/?$/i, "/").replace(/(.)\/$/, "$1");
  const host = url.hostname.replace(/^(www|m|amp)\./, "");
  return { url: url.href, key: `${host}${url.port ? ":" + url.port : ""}${url.pathname}${url.search}` };
}

const STOPWORDS = new Set(("le la les l un une des du de d au aux et ou en dans sur pour par avec sans sous ce cet cette ces se sa son ses leur leurs il elle ils elles on nous vous je tu y a est sont ete etre avoir fait plus moins pas ne que qui quoi dont ou comme mais donc car si tout tous toute toutes apres avant selon entre contre vers chez lors deja encore aussi tres bien " +
  "the an of to in on for with by at from and or is are was were be has have had it its this that as not but will would after over new says said").split(" "));

export function tokens(text: string) {
  return text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").split(" ").filter(token => token.length >= 2 && !STOPWORDS.has(token));
}
const jaccard = (a: Set<string>, b: Set<string>) => {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const value of a) if (b.has(value)) shared++;
  return shared / (a.size + b.size - shared);
};

const shingles = (words: string[]) => new Set(words.length < 3 ? [words.join(" ")] : words.slice(0, -2).map((_, i) => words.slice(i, i + 3).join(" ")));
type Signature = { title: Set<string>; all: Set<string>; shingles: Set<string>; body: Set<string>; titleKey: string; length: number; bodyLength: number };
export function signature(title: string, summary: string): Signature {
  const titleTokens = tokens(title);
  const bodyTokens = tokens(summary);
  const all = [...titleTokens, ...bodyTokens];
  return { title: new Set(titleTokens), all: new Set(all), shingles: shingles(all), body: shingles(bodyTokens), titleKey: titleTokens.join(" "), length: all.length, bodyLength: bodyTokens.length };
}

/** Same text republished (one dispatch on several sites, often retitled): never an independent confirmation. */
export function sameText(a: Signature, b: Signature) {
  if (a.title.size >= 4 && a.titleKey === b.titleKey) return true;
  if (a.bodyLength >= 8 && b.bodyLength >= 8 && jaccard(a.body, b.body) >= 0.5) return true;
  return a.length >= 12 && b.length >= 12 && jaccard(a.shingles, b.shingles) >= 0.5;
}
/** Same event in other words: shared title vocabulary, weighted with the summary. */
export function eventSimilarity(a: Signature, b: Signature) {
  return 0.6 * jaccard(a.title, b.title) + 0.4 * jaccard(a.all, b.all);
}
export const EVENT_THRESHOLD = 0.35;
const EVENT_WINDOW_MS = 72 * 3_600_000;
const CANDIDATES = 1_000;

type ItemRow = { id: string; story_id: string; publisher: string; owner_group: string | null; title: string; summary: string; credits: string; topic_ids: string; published_at: string | null; fetched_at: number; source_id: string };
const instant = (row: { published_at: string | null; fetched_at: number }) => (row.published_at ? Date.parse(row.published_at) : row.fetched_at);
const voice = (publisher: string) => publisher.trim().toLowerCase();

/**
 * Independent voices of a story: items merge when they are copies of the same text, credit the
 * same agency (or are that agency), or come from the same publisher or ownership group.
 * Returns the lineage of each item (stable order: earliest first) and the number of lineages.
 */
export function lineages(items: { id: string; publisher: string; ownerGroup: string | null; credits: string[]; signature: Signature; at: number }[]) {
  const sorted = [...items].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  const parent = sorted.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb); };
  const voices = sorted.map(item => new Set([...item.credits, voice(item.publisher), ...(item.ownerGroup ? [`group:${voice(item.ownerGroup)}`] : [])]));
  for (let i = 0; i < sorted.length; i++) for (let j = i + 1; j < sorted.length; j++) {
    if ([...voices[i]].some(value => voices[j].has(value)) || sameText(sorted[i].signature, sorted[j].signature)) union(i, j);
  }
  const roots = new Map<number, number>();
  const byId = new Map<string, number>();
  sorted.forEach((item, i) => {
    const root = find(i);
    if (!roots.has(root)) roots.set(root, roots.size);
    byId.set(item.id, roots.get(root)!);
  });
  return { byId, count: roots.size };
}

export type CollectedSource = { id: string; publisher: string; ownerGroup: string | null; topicIds: string[] };

/** Stores new entries, records sightings of known ones, groups them into stories. One transaction. */
export function recordEntries(db: Database.Database, { owner, source, entries, now }: { owner: string; source: CollectedSource; entries: FeedEntry[]; now: number }) {
  migrateWatchItems(db);
  const byKey = db.prepare<[string, string], { id: string; topic_ids: string; story_id: string }>("SELECT id, topic_ids, story_id FROM watch_item WHERE owner = ? AND url_key = ?");
  const byGuid = db.prepare<[string, string], { id: string; topic_ids: string; story_id: string }>("SELECT id, topic_ids, story_id FROM watch_item WHERE source_id = ? AND guid = ?");
  const seen = db.prepare("INSERT OR IGNORE INTO watch_item_seen VALUES (?, ?, ?)");
  const setTopics = db.prepare("UPDATE watch_item SET topic_ids = ? WHERE id = ?");
  const insert = db.prepare(`INSERT INTO watch_item (id, owner, url_key, url, original_url, guid, source_id, publisher, owner_group, title, summary, author, published_at, fetched_at, credits, links, topic_ids, story_id)
    VALUES (@id, @owner, @url_key, @url, @original_url, @guid, @source_id, @publisher, @owner_group, @title, @summary, @author, @published_at, @fetched_at, @credits, @links, @topic_ids, @story_id)`);
  const candidates = db.prepare<[string, number], ItemRow>(`SELECT id, story_id, publisher, owner_group, title, summary, credits, topic_ids, published_at, fetched_at, source_id
    FROM watch_item WHERE owner = ? AND fetched_at >= ? ORDER BY fetched_at DESC LIMIT ${CANDIDATES}`);
  return db.transaction(() => {
    const touched = new Set<string>();
    const result = { new: 0, seen: 0 };
    const recent = candidates.all(owner, now - 2 * EVENT_WINDOW_MS).map(row => ({ row, signature: signature(row.title, row.summary) }));
    for (const entry of entries) {
      let canonical: ReturnType<typeof canonicalUrl>;
      try { canonical = canonicalUrl(entry.url); } catch { continue; }
      const known = byKey.get(owner, canonical.key) ?? (entry.guid ? byGuid.get(source.id, entry.guid) : undefined);
      if (known) {
        seen.run(known.id, source.id, now);
        const topics = [...new Set([...JSON.parse(known.topic_ids) as string[], ...source.topicIds])].sort();
        setTopics.run(JSON.stringify(topics), known.id);
        touched.add(known.story_id);
        result.seen++;
        continue;
      }
      const at = entry.publishedAt ? Date.parse(entry.publishedAt) : now;
      const own = signature(entry.title, entry.summary);
      let best: { story: string; score: number } | null = null;
      for (const candidate of recent) {
        if (Math.abs(instant(candidate.row) - at) > EVENT_WINDOW_MS) continue;
        const score = sameText(own, candidate.signature) ? 1 : eventSimilarity(own, candidate.signature);
        if (score >= EVENT_THRESHOLD && (!best || score > best.score)) best = { story: candidate.row.story_id, score };
      }
      const story = best?.story ?? randomUUID();
      if (!best) db.prepare("INSERT INTO watch_story (id, owner, title, first_seen_at, last_seen_at, item_count, publisher_count, independent_count, topic_ids, updated_at) VALUES (?, ?, ?, ?, ?, 0, 0, 0, '[]', ?)")
        .run(story, owner, entry.title, now, now, now);
      const row: ItemRow = { id: randomUUID(), story_id: story, publisher: source.publisher, owner_group: source.ownerGroup, title: entry.title, summary: entry.summary, credits: JSON.stringify(entry.credits), topic_ids: JSON.stringify([...source.topicIds].sort()), published_at: entry.publishedAt, fetched_at: now, source_id: source.id };
      insert.run({ ...row, owner, url_key: canonical.key, url: canonical.url, original_url: entry.url, guid: entry.guid, author: entry.author, links: JSON.stringify(entry.links) });
      seen.run(row.id, source.id, now);
      recent.unshift({ row, signature: own });
      touched.add(story);
      result.new++;
    }
    for (const story of touched) refreshStory(db, story, now);
    return result;
  })();
}

/** Same event recognized later (local model): `from`'s items join `into`, which is recomputed. */
export function mergeStories(db: Database.Database, into: string, from: string, now: number) {
  db.transaction(() => {
    db.prepare("UPDATE watch_item SET story_id = ? WHERE story_id = ?").run(into, from);
    db.prepare("DELETE FROM watch_story WHERE id = ?").run(from);
    refreshStory(db, into, now);
  })();
}

function refreshStory(db: Database.Database, story: string, now: number) {
  const rows = db.prepare<[string], ItemRow>("SELECT id, story_id, publisher, owner_group, title, summary, credits, topic_ids, published_at, fetched_at, source_id FROM watch_item WHERE story_id = ?").all(story);
  const { byId, count } = lineages(rows.map(row => ({ id: row.id, publisher: row.publisher, ownerGroup: row.owner_group, credits: JSON.parse(row.credits), signature: signature(row.title, row.summary), at: instant(row) })));
  const setLineage = db.prepare("UPDATE watch_item SET lineage = ? WHERE id = ?");
  for (const row of rows) setLineage.run(byId.get(row.id), row.id);
  const earliest = [...rows].sort((a, b) => instant(a) - instant(b))[0];
  const published = rows.map(row => row.published_at).filter((value): value is string => !!value).sort()[0] ?? null;
  db.prepare(`UPDATE watch_story SET title = ?, first_seen_at = ?, last_seen_at = ?, first_published_at = ?, item_count = ?, publisher_count = ?, independent_count = ?, topic_ids = ?, updated_at = ? WHERE id = ?`).run(
    earliest.title, Math.min(...rows.map(row => row.fetched_at)), Math.max(...rows.map(row => row.fetched_at)), published, rows.length,
    new Set(rows.map(row => voice(row.publisher))).size, count, JSON.stringify([...new Set(rows.flatMap(row => JSON.parse(row.topic_ids) as string[]))].sort()), now, story);
}

/** Retention: items and empty stories older than `maxAgeMs` are deleted. */
export function purgeItems(db: Database.Database, now: number, maxAgeMs = 30 * 86_400_000) {
  migrateWatchItems(db);
  return db.transaction(() => {
    const before = now - maxAgeMs;
    db.prepare("DELETE FROM watch_item_seen WHERE item_id IN (SELECT id FROM watch_item WHERE fetched_at < ?)").run(before);
    const items = db.prepare("DELETE FROM watch_item WHERE fetched_at < ?").run(before).changes;
    db.prepare("DELETE FROM watch_story WHERE NOT EXISTS (SELECT 1 FROM watch_item i WHERE i.story_id = watch_story.id)").run();
    return items;
  })();
}
