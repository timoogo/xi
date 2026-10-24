import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import Database from "better-sqlite3";
import { createAccountStore } from "../src/lib/accounts/store";
import { DEFAULT_WATCH_POLICY } from "../src/lib/accounts/types";
import { createPublicationStore, PublicationError } from "../src/lib/publications/store";
import { openVault } from "../src/lib/publications/vault";
import { createTopicStore } from "../src/lib/topics/store";
import { manualPublication } from "../src/lib/xiagents/manual-publication";
import { decodeBody, proposeFromUrl, sourceState } from "../src/lib/watch/collect";
import { watchDiagnostics } from "../src/lib/watch/diagnostics";
import { detectCredits, discoverFeeds, FeedError, parseFeed, parseJsonApi } from "../src/lib/watch/feeds";
import { createPoliteFetch, createSafeFetch, FetchError, isPublicAddress } from "../src/lib/watch/net";
import { parseRobots, robotsAllows } from "../src/lib/watch/robots";
import { nightWindow } from "../src/lib/watch/schedule";
import { createSourceStore, estimateReliability } from "../src/lib/watch/sources";
import { canonicalUrl, lineages, signature } from "../src/lib/watch/stories";
import { engineHandlers, tick, windowHandlers } from "../src/lib/watch/worker";

const MIN = 60_000;

/** Local fixture server; `routes` is keyed by "host path" (host without port). */
async function fixtureServer(t: test.TestContext, routes: Record<string, (req: http.IncomingMessage, res: http.ServerResponse) => void>) {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    const path = new URL(req.url ?? "/", "http://x").pathname;
    hits.push(`${host} ${path}`);
    const route = routes[`${host} ${path}`];
    if (route) route(req, res); else { res.statusCode = 404; res.end("absent"); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const port = (server.address() as { port: number }).port;
  return { port, hits, base: (host: string) => `http://${host}:${port}`, count: (key: string) => hits.filter(hit => hit === key).length };
}
/** "*.test" names stand in for public hosts served locally; "internal.test" is a private address. */
const resolve = async (host: string) => {
  if (host === "internal.test") return [{ address: "10.0.0.5", family: 4 }];
  if (host === "mixed.test") return [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.1", family: 4 }];
  if (host.endsWith(".test")) return [{ address: "127.0.0.1", family: 4 }];
  throw new Error("unknown host");
};
const testFetch = () => createSafeFetch({ allowAddress: address => address === "127.0.0.1", allowAnyPort: true, resolve });
const send = (body: string, type = "application/rss+xml; charset=utf-8", headers: Record<string, string> = {}) => (_req: http.IncomingMessage, res: http.ServerResponse) => {
  res.writeHead(200, { "Content-Type": type, ...headers }); res.end(body);
};
const esc = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const rss = (title: string, items: { title: string; link: string; description?: string; pubDate?: string; guid?: string; creator?: string }[]) =>
  `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>${esc(title)}</title><link>https://example.org/</link>${items.map(item =>
    `<item><title>${esc(item.title)}</title><link>${esc(item.link)}</link>${item.guid ? `<guid>${item.guid}</guid>` : ""}<description>${esc(item.description ?? "")}</description><pubDate>${item.pubDate ?? "Thu, 15 Jan 2026 09:00:00 GMT"}</pubDate>${item.creator ? `<dc:creator>${item.creator}</dc:creator>` : ""}</item>`).join("")}</channel></rss>`;

async function setup(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "xi-watch-collect-"));
  const db = new Database(join(root, "app.sqlite"));
  db.pragma("journal_mode = WAL"); db.pragma("busy_timeout = 5000");
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  const vault = await openVault(root);
  const topics = createTopicStore({ vault, db });
  const accounts = createAccountStore({ vault, db, topics });
  const publications = createPublicationStore({ vault, db });
  const sources = createSourceStore({ vault, topics });
  const run = await topics.propose("alice", "Politique fictive");
  await topics.confirm("alice", run.id, { tag: "politiks", name: "Politiks", description: "Test", scope: "Simulation", parentId: null, relatedIds: [] }, true);
  const other = await topics.propose("alice", "Sciences fictives");
  await topics.confirm("alice", other.id, { tag: "sciencia", name: "Sciencia", description: "Test", scope: "Simulation", parentId: null, relatedIds: [] }, true);
  const proposed = await accounts.propose("alice", run.topicId);
  const ready = await accounts.resume("alice", proposed.id);
  await accounts.confirm("alice", ready.id, ready.draft, true);
  return { root, db, vault, topics, accounts, publications, sources, topicId: run.topicId, otherTopicId: other.topicId, agentId: ready.accountId };
}
const reliability = { level: "inconnue" as const, reasons: [], estimated: true };
async function approve(sources: ReturnType<typeof createSourceStore>, owner: string, proposal: { url: string; publisher: string; topicIds: string[] }, edits: Record<string, unknown> = {}) {
  const { source } = await sources.propose(owner, { ...proposal, kind: "feed", site: null, reliability }, owner);
  return sources.decide(owner, source.id, { action: "approve", revision: source.revision, edits });
}

test("robots.txt: groups, longest match, Allow on ties, wildcards and Crawl-delay", () => {
  const policy = parseRobots("User-agent: *\nDisallow: /\n\nUser-agent: OtherBot\nUser-agent: XiWatch\nDisallow: /prive\nAllow: /prive/flux$\nDisallow: /*.php\nCrawl-delay: 12\n");
  assert.equal(policy.crawlDelayMs, 12_000);
  assert.equal(robotsAllows(policy, "/flux.xml"), true);
  assert.equal(robotsAllows(policy, "/prive/article"), false);
  assert.equal(robotsAllows(policy, "/prive/flux"), true);
  assert.equal(robotsAllows(policy, "/prive/flux/2"), false);
  assert.equal(robotsAllows(policy, "/index.php?x=1"), false);
  const star = parseRobots("User-agent: *\nDisallow: /rss\nAllow: /rss\n");
  assert.equal(robotsAllows(star, "/rss.xml"), true, "equal length: Allow wins");
  assert.equal(robotsAllows(parseRobots("User-agent: *\nDisallow: /\n"), "/feed"), false);
  assert.equal(robotsAllows(parseRobots(""), "/feed"), true);
});

test("feeds: RSS, Atom, RDF and JSON API; DTD refused; text only; credits and links", () => {
  const feed = parseFeed(rss("Le Quotidien", [{ title: "Titre &amp; <b>gras</b>", link: "/a/1", description: `<p>Paris (AFP) - Texte avec <a href="https://source.example/rapport">un rapport</a>.<script>alert(1)</script></p>` }]), "https://quotidien.example/rss");
  assert.equal(feed.title, "Le Quotidien");
  const [entry] = feed.entries;
  assert.equal(entry.url, "https://quotidien.example/a/1", "relative links resolve against the feed document");
  assert.equal(entry.title, "Titre & gras");
  assert.equal(entry.summary, "Paris (AFP) - Texte avec un rapport .");
  assert.deepEqual(entry.credits, ["afp"]);
  assert.deepEqual(entry.links, ["https://source.example/rapport"]);
  assert.equal(entry.publishedAt, "2026-01-15T09:00:00.000Z");
  const atom = parseFeed(`<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><link href="https://atom.example/"/><entry><title type="html">Un titre</title><link rel="alternate" href="https://atom.example/e/1"/><id>urn:1</id><updated>2026-01-15T10:00:00Z</updated><summary>Résumé</summary><author><name>Reuters</name></author></entry></feed>`);
  assert.deepEqual(atom.entries.map(e => [e.url, e.guid, e.title, e.publishedAt, e.credits]), [["https://atom.example/e/1", "urn:1", "Un titre", "2026-01-15T10:00:00.000Z", ["reuters"]]]);
  const rdf = parseFeed(`<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>RDF</title></channel><item rdf:about="https://rdf.example/1"><title>R</title><link>https://rdf.example/1</link><dc:date>2026-01-15</dc:date></item></rdf:RDF>`);
  assert.equal(rdf.entries[0].url, "https://rdf.example/1");
  for (const hostile of [`<?xml version="1.0"?><!DOCTYPE r [<!ENTITY a "aaaa">]><rss><channel><item><title>&a;</title></item></channel></rss>`, "<html><body>page</body></html>", "pas du xml <"]) assert.throws(() => parseFeed(hostile), FeedError);
  // Entries without a usable http(s) link are dropped.
  assert.equal(parseFeed(rss("X", [{ title: "t", link: "javascript:alert(1)" }])).entries.length, 0);
  const api = parseJsonApi(JSON.stringify({ data: { results: [{ uri: "https://www.vie-publique.fr/x", label: "Loi", at: "2026-01-14", text: "Résumé" }, { uri: "ftp://bad", label: "Non" }] } }), { itemsPath: "data.results", url: "uri", title: "label", publishedAt: "at", summary: "text" });
  assert.deepEqual(api.entries.map(e => [e.url, e.title, e.publishedAt]), [["https://www.vie-publique.fr/x", "Loi", "2026-01-14T00:00:00.000Z"]]);
  assert.throws(() => parseJsonApi("{}", { itemsPath: "missing", url: "u", title: "t" }), FeedError);
  assert.deepEqual(detectCredits("Avec AFP", "texte de l'apport", "(Reuters)", "AP"), ["afp", "ap", "reuters"]);
  assert.deepEqual(detectCredits("Les ats et les apports", "rapport"), []);
  const page = discoverFeeds(`<html><head><title>Journal &amp; Co</title><link rel="alternate" type="application/rss+xml" href="/rss.xml"><link rel="stylesheet" href="/x.css"></head></html>`, "https://journal.example/");
  assert.deepEqual(page, { feeds: ["https://journal.example/rss.xml"], siteName: "Journal & Co" });
  assert.equal(decodeBody(Buffer.from([0x3c, 0x74, 0x3e, 0xe9]), "text/xml; charset=ISO-8859-1"), "<t>é");
});

test("stories: URL normalization, copies vs independent confirmations", () => {
  assert.deepEqual(canonicalUrl("https://www.Example.org/a/1/?utm_source=rss&b=2&a=1#top"), { url: "https://www.example.org/a/1?a=1&b=2", key: "example.org/a/1?a=1&b=2" });
  assert.equal(canonicalUrl("http://m.example.org/a/1/amp").key, canonicalUrl("https://example.org/a/1").key);
  const dispatch = "Paris (AFP) - Le Parlement a définitivement adopté jeudi la réforme des retraites après un dernier vote au Sénat.";
  const item = (id: string, publisher: string, title: string, summary: string, credits: string[], ownerGroup: string | null = null) => ({ id, publisher, ownerGroup, credits, signature: signature(title, summary), at: Number(id) });
  const result = lineages([
    item("1", "Le Quotidien", "Le Parlement adopte la réforme des retraites", dispatch, ["afp"]),
    item("2", "La Gazette", "Réforme des retraites adoptée", dispatch.replace("Paris (AFP) - ", ""), []), // same text, credit removed
    item("3", "AFP", "Le Parlement adopte la réforme", "Dépêche", []), // the agency itself
    item("4", "Le Journal", "Retraites : le Parlement vote le texte", "Notre rédaction était au Sénat pour le vote final.", []),
    item("5", "Le Journal Soir", "Retraites : vote final", "Compte rendu de notre envoyé spécial.", [], "Groupe Journal"),
    item("6", "Le Journal Matin", "Retraites : le Sénat a tranché", "Analyse du vote.", [], "Groupe Journal"),
  ]);
  assert.equal(result.count, 3, "AFP and its copies · Le Journal · Groupe Journal");
  assert.deepEqual(["1", "2", "3", "4", "5", "6"].map(id => result.byId.get(id)), [0, 0, 0, 1, 2, 2]);
});

test("network: SSRF guard, redirects, size, compression, timeouts and errors", { timeout: 30_000 }, async t => {
  for (const [address, expected] of [["8.8.8.8", true], ["2606:4700::1111", true], ["10.1.2.3", false], ["172.16.5.4", false], ["192.168.1.1", false], ["100.64.0.1", false], ["127.0.0.1", false], ["169.254.169.254", false], ["0.0.0.0", false], ["::1", false], ["::ffff:127.0.0.1", false], ["fe80::1", false], ["fc00::1", false], ["not-an-ip", false]] as const) assert.equal(isPublicAddress(address), expected, address);
  const strict = createSafeFetch({ resolve });
  const code = (promise: Promise<unknown>) => promise.then(() => "ok", (error: FetchError) => error.code);
  for (const [url, expected] of [["http://127.0.0.1/", "blocked-address"], ["http://169.254.169.254/latest/meta-data", "blocked-address"], ["http://[::1]/", "blocked-address"], ["http://[::ffff:7f00:1]/", "blocked-address"], ["http://internal.test/", "blocked-address"], ["http://mixed.test/", "blocked-address"], ["http://news.test:8080/", "blocked-url"], ["file:///etc/passwd", "blocked-url"], ["http://user:pass@news.test/", "blocked-url"], ["gopher://news.test/", "blocked-url"]]) {
    assert.equal(await code(strict(url)), expected, url);
  }
  const big = gzipSync(Buffer.alloc(3_000_000, 0x20));
  const server = await fixtureServer(t, {
    "news.test /ok": send("bonjour", "text/plain"),
    "news.test /redirect": (_req, res) => { res.writeHead(302, { Location: "/ok" }); res.end(); },
    "news.test /loop": (_req, res) => { res.writeHead(302, { Location: "/loop" }); res.end(); },
    "news.test /to-internal": (_req, res) => { res.writeHead(302, { Location: `http://internal.test:${server.port}/ok` }); res.end(); },
    "news.test /to-file": (_req, res) => { res.writeHead(302, { Location: "file:///etc/passwd" }); res.end(); },
    "news.test /large": (_req, res) => { res.writeHead(200, { "Content-Length": "5000000" }); res.end(); },
    "news.test /chunked": (_req, res) => { res.writeHead(200); res.write(Buffer.alloc(800_000)); res.end(Buffer.alloc(800_000)); },
    "news.test /bomb": (_req, res) => { res.writeHead(200, { "Content-Encoding": "gzip" }); res.end(big); },
    "news.test /gzip": (_req, res) => { res.writeHead(200, { "Content-Encoding": "gzip" }); res.end(gzipSync("compressé")); },
    "news.test /slow": (_req, res) => { setTimeout(() => { res.writeHead(200); res.end("tard"); }, 1_500); },
    "news.test /gone": (_req, res) => { res.writeHead(500); res.end("secret interne"); },
    "news.test /etag": (req, res) => { if (req.headers["if-none-match"] === "\"v1\"") { res.writeHead(304); res.end(); } else send("contenu", "text/plain", { ETag: "\"v1\"" })(req, res); },
  });
  const local = testFetch();
  const ok = await local(`${server.base("news.test")}/redirect`);
  assert.deepEqual([ok.status, ok.body.toString(), ok.url], [200, "bonjour", `${server.base("news.test")}/ok`]);
  assert.equal((await local(`${server.base("news.test")}/gzip`)).body.toString(), "compressé");
  assert.equal(await code(local(`${server.base("news.test")}/loop`)), "redirect");
  assert.equal(await code(local(`${server.base("news.test")}/to-internal`)), "blocked-address");
  assert.equal(server.count("internal.test /ok"), 0, "never connected to the private target");
  assert.equal(await code(local(`${server.base("news.test")}/to-file`)), "blocked-url");
  for (const path of ["/large", "/chunked", "/bomb"]) assert.equal(await code(local(`${server.base("news.test")}${path}`, { maxBytes: 1_000_000 })), "too-large", path);
  assert.equal(await code(local(`${server.base("news.test")}/slow`, { timeoutMs: 300 })), "timeout");
  const failed = await local(`${server.base("news.test")}/gone`);
  assert.deepEqual([failed.status, failed.body.length], [500, 0], "error bodies are not kept");
  assert.equal((await local(`${server.base("news.test")}/etag`)).headers.etag, "\"v1\"");
  assert.equal((await local(`${server.base("news.test")}/etag`, { headers: { "If-None-Match": "\"v1\"" } })).status, 304);
  const closed = http.createServer(); await new Promise<void>(r => closed.listen(0, "127.0.0.1", r));
  const closedPort = (closed.address() as { port: number }).port; await new Promise(r => closed.close(r));
  assert.equal(await code(local(`http://news.test:${closedPort}/`)), "network");
});

test("polite access: robots cached, Crawl-delay and minimum interval, 429 Retry-After, 5xx robots", { timeout: 30_000 }, async t => {
  let robotsHits = 0;
  const server = await fixtureServer(t, {
    "polite.test /robots.txt": (req, res) => { robotsHits++; send("User-agent: *\nDisallow: /prive\nCrawl-delay: 30\n", "text/plain")(req, res); },
    "polite.test /flux": send("ok", "text/plain"),
    "polite.test /prive": send("non", "text/plain"),
    "busy.test /robots.txt": (_req, res) => { res.writeHead(404); res.end(); },
    "busy.test /flux": (_req, res) => { res.writeHead(429, { "Retry-After": "120" }); res.end(); },
    "down.test /robots.txt": (_req, res) => { res.writeHead(503); res.end(); },
    "down.test /flux": send("ok", "text/plain"),
  });
  const db = new Database(":memory:"); t.after(() => db.close());
  let clock = 1_000_000_000;
  const polite = createPoliteFetch({ db, fetch: testFetch(), now: () => clock, minIntervalMs: 5_000 });
  const code = (promise: Promise<unknown>) => promise.then(() => "ok", (error: FetchError) => error.code);
  assert.equal(await code(polite(`${server.base("polite.test")}/flux`)), "ok");
  const throttled = await polite(`${server.base("polite.test")}/flux`).then(() => null, error => error) as FetchError;
  assert.deepEqual([throttled.code, throttled.retryAt], ["throttled", clock + 30_000], "Crawl-delay beats the 5 s default");
  clock += 30_000;
  assert.equal(await code(polite(`${server.base("polite.test")}/prive`)), "robots");
  assert.equal(robotsHits, 1, "robots.txt cached");
  assert.equal(server.count("polite.test /prive"), 0);
  clock += 25 * 3_600_000;
  assert.equal(await code(polite(`${server.base("polite.test")}/flux`)), "ok");
  assert.equal(robotsHits, 2, "refreshed after 24 h");
  const busy = await polite(`${server.base("busy.test")}/flux`).then(() => null, error => error) as FetchError;
  assert.deepEqual([busy.code, busy.status, busy.retryAt], ["http", 429, clock + 120_000]);
  clock += 10_000;
  assert.equal(await code(polite(`${server.base("busy.test")}/flux`)), "throttled");
  assert.equal(await code(polite(`${server.base("down.test")}/flux`)), "robots", "unreachable robots.txt means disallowed");
  assert.equal(server.count("down.test /flux"), 0);
  // Shared through SQLite: another process (new instance) sees the same pauses.
  const other = createPoliteFetch({ db, fetch: testFetch(), now: () => clock });
  assert.equal(await code(other(`${server.base("busy.test")}/flux`)), "throttled");
});

test("source catalogue: proposals wait for approval, owner isolation, transitions, history, tombstones", async t => {
  const { sources, topicId, otherTopicId, root } = await setup(t);
  const proposal = { url: "https://feeds.example/rss?utm_source=x", kind: "feed" as const, site: null, publisher: "Le Quotidien", topicIds: [topicId], reliability: estimateReliability({ url: "https://feeds.example/rss", citedBy: 3, entries: [] }) };
  assert.equal(estimateReliability({ url: "https://www.legifrance.gouv.fr/rss", entries: [] }).level, "élevée");
  await assert.rejects(sources.propose("alice", { ...proposal, topicIds: [randomUUID()] }, "alice"), /Topics/);
  await assert.rejects(sources.propose("alice", { ...proposal, url: "javascript:alert(1)" }, "alice"));
  const { source, created } = await sources.propose("alice", proposal, "agent:x");
  assert.equal(created, true);
  assert.deepEqual([source.status, source.proposedBy, source.history.length], ["proposed", "agent:x", 1]);
  assert.equal((await sources.propose("alice", { ...proposal, url: "https://feeds.example/rss" }, "alice")).created, false, "same canonical URL");
  assert.deepEqual(await sources.approved(), [], "a proposal is never used");
  // Another owner can neither see nor decide.
  assert.deepEqual((await sources.list("bob")).sources, []);
  await assert.rejects(sources.get("bob", source.id), /introuvable/);
  await assert.rejects(sources.decide("bob", source.id, { action: "approve", revision: source.revision }), /introuvable/);
  assert.equal((await sources.propose("bob", proposal, "bob")).created, true, "catalogues are per owner");
  await assert.rejects(sources.decide("alice", source.id, { action: "approve", revision: randomUUID() }), /changé/);
  await assert.rejects(sources.decide("alice", source.id, { action: "disable", revision: source.revision }), /impossible/);
  await assert.rejects(sources.decide("alice", source.id, { action: "reject", revision: source.revision, edits: { publisher: "x" } }), /Modifications/);
  const approved = await sources.decide("alice", source.id, { action: "approve", revision: source.revision, note: "Vérifiée", edits: { topicIds: [topicId, otherTopicId], ownerGroup: "Groupe Q", orientation: "Centre (déclarée)", reliability: "moyenne" } });
  assert.deepEqual([approved.status, approved.topicIds, approved.ownerGroup, approved.reliability.level, approved.reliability.estimated], ["approved", [topicId, otherTopicId], "Groupe Q", "moyenne", false]);
  assert.deepEqual((await sources.approved()).map(s => s.id), [source.id]);
  const disabled = await sources.decide("alice", source.id, { action: "disable", revision: approved.revision });
  assert.deepEqual(await sources.approved(), []);
  const deleted = await sources.decide("alice", source.id, { action: "delete", revision: disabled.revision, note: "Doublon" });
  assert.equal(deleted.status, "deleted");
  assert.deepEqual(deleted.history.map(h => h.action), ["proposed", "approved", "disabled", "deleted"]);
  assert.deepEqual(deleted.history[1].changes, { topicIds: [topicId, otherTopicId], ownerGroup: "Groupe Q", orientation: "Centre (déclarée)", reliability: "moyenne" });
  assert.equal((await sources.list("alice")).sources.length, 0);
  assert.equal((await sources.list("alice", { includeDeleted: true })).sources.length, 1, "tombstone kept with its history");
  assert.equal((await sources.propose("alice", proposal, "agent:x")).source.status, "deleted", "never re-proposed");
  // A hand-broken file is ignored and counted, never collected.
  const file = join(root, "watch", "sources", `${source.id}.md`);
  await writeFile(file, (await readFile(file, "utf8")).replace("status: deleted", "status: approved\nextra: 1"));
  assert.deepEqual([(await sources.list("alice", { includeDeleted: true })).invalid, (await sources.approved()).length], [1, 0]);
});

test("collector: approved sources only, conditional requests, duplicates, stories, errors, robots, pause, restart, discovery", { timeout: 60_000 }, async t => {
  const env = await setup(t);
  const { db, accounts, publications, sources, topicId, agentId } = env;
  const feeds: Record<string, string> = {};
  let cStatus = 200;
  const server = await fixtureServer(t, {
    "news-a.test /rss": (req, res) => { if (req.headers["if-none-match"] === "\"a1\"") { res.writeHead(304); res.end(); } else send(feeds.a, undefined, { ETag: "\"a1\"" })(req, res); },
    "news-b.test /rss": (req, res) => send(feeds.b)(req, res),
    "news-c.test /rss": (req, res) => { if (cStatus !== 200) { res.writeHead(cStatus); res.end(); } else send(feeds.c)(req, res); },
    "news-p.test /rss": (req, res) => send(feeds.b)(req, res),
    "news-r.test /robots.txt": send("User-agent: *\nDisallow: /rss\n", "text/plain"),
    "news-r.test /rss": (req, res) => send(feeds.b)(req, res),
    "newsite.test /": send(`<html><head><title>Nouveau site</title><link rel="alternate" type="application/rss+xml" href="/rss.xml"></head></html>`, "text/html"),
    "newsite.test /rss.xml": (req, res) => send(rss("Nouveau Site", [{ title: "Rapport public", link: `${server.base("newsite.test")}/rapport` }]))(req, res),
  });
  const cited = `<a href="${server.base("newsite.test")}/rapport">le rapport</a>`;
  const dispatch = "Paris (AFP) - Le Parlement a définitivement adopté jeudi la réforme des retraites après un dernier vote au Sénat, a constaté l'AFP.";
  feeds.a = rss("Le Quotidien", [
    { title: "Le Parlement adopte la réforme des retraites", link: `${server.base("news-a.test")}/a/1?utm_source=rss`, description: `${dispatch} Voir ${cited}.` },
    { title: "Le budget de la culture augmente en 2027", link: `${server.base("news-a.test")}/a/2`, description: "Le ministère annonce une hausse des crédits." },
  ]);
  feeds.b = rss("La Gazette", [
    { title: "Le Parlement adopte la réforme des retraites", link: `${server.base("news-b.test")}/b/1`, description: dispatch },
    { title: "Repris : le Parlement adopte la réforme", link: `${server.base("news-a.test")}/a/1`, description: "Lien vers Le Quotidien." }, // aggregated copy of a known URL
  ]);
  feeds.c = rss("Le Journal", [{ title: "Réforme des retraites : le Parlement vote définitivement le texte", link: `${server.base("news-c.test")}/c/1`, description: `Les députés et sénateurs ont voté le texte de la réforme des retraites, a constaté notre rédaction au Sénat. Voir ${cited}.` }]);
  const a = await approve(sources, "alice", { url: `${server.base("news-a.test")}/rss`, publisher: "Le Quotidien", topicIds: [topicId] });
  await approve(sources, "alice", { url: `${server.base("news-b.test")}/rss`, publisher: "La Gazette", topicIds: [topicId] });
  const c = await approve(sources, "alice", { url: `${server.base("news-c.test")}/rss`, publisher: "Le Journal", topicIds: [topicId] });
  await sources.propose("alice", { url: `${server.base("news-p.test")}/rss`, kind: "feed", site: null, publisher: "En attente", topicIds: [topicId], reliability }, "agent:x");
  let clock = Date.parse("2026-01-15T12:00:00Z");
  const build = () => {
    const fetch = createPoliteFetch({ db, fetch: testFetch(), now: () => clock, minIntervalMs: 0 });
    return { fetch, handlers: engineHandlers({ db, accounts, topics: env.topics, publications, sources, fetch, inference: null, defaultModel: null, settings: { autoPublish: false, allowPublic: false }, now: () => new Date(clock) }) };
  };
  let engine = build();
  const run = () => tick({ db, accounts, sources, handlers: engine.handlers, now: () => new Date(clock) });
  // Watch disabled: nothing is collected.
  assert.equal((await run()).planned, 0);
  assert.equal(server.hits.length, 0);
  const policy = await accounts.setWatchPolicy("alice", agentId, { revision: null, policy: { ...DEFAULT_WATCH_POLICY, enabled: true } });
  const first = await run();
  assert.equal(first.planned, 5, "window + three collections + discovery");
  assert.equal(server.count("news-p.test /rss"), 0, "a proposal is never collected");
  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  assert.equal(count("SELECT count(*) AS n FROM watch_item"), 4, "the aggregated copy of a known URL is not a new item");
  const sightings = db.prepare("SELECT count(*) AS n FROM watch_item_seen s JOIN watch_item i ON i.id = s.item_id WHERE i.url_key LIKE 'news-a.test%/a/1'").get() as { n: number };
  assert.equal(sightings.n, 2, "provenance of both feeds kept");
  const stories = db.prepare("SELECT title, item_count, publisher_count, independent_count, first_published_at FROM watch_story ORDER BY item_count DESC").all() as { title: string; item_count: number; publisher_count: number; independent_count: number; first_published_at: string }[];
  assert.deepEqual(stories.map(s => [s.item_count, s.publisher_count, s.independent_count]), [[3, 3, 2], [1, 1, 1]], "AFP copies count once");
  assert.equal(stories[0].first_published_at, "2026-01-15T09:00:00.000Z");
  // Discovery: a domain cited by two approved sources becomes a proposal, not a collected source.
  const proposals = (await sources.list("alice")).sources.filter(s => s.proposedBy === `agent:${agentId}`);
  assert.equal(proposals.length, 1);
  assert.deepEqual([proposals[0].status, proposals[0].url, proposals[0].publisher, proposals[0].topicIds], ["proposed", `${server.base("newsite.test")}/rss.xml`, "Nouveau Site", [topicId]]);
  assert.ok(proposals[0].reliability.reasons.some(reason => reason.includes("Citée par 2")), JSON.stringify(proposals[0].reliability));
  assert.equal(server.count("newsite.test /rss.xml"), 1, "fetched once to validate the proposal");
  // Not due yet: nothing is planned again.
  assert.equal((await run()).planned, 0);
  // One hour later: 304 thanks to the stored ETag, duplicates are not re-added, errors back off.
  clock += 61 * MIN;
  cStatus = 500;
  await run();
  assert.equal(count("SELECT count(*) AS n FROM watch_item"), 4);
  const log = db.prepare("SELECT outcome, http_status, items_new, items_seen, error FROM watch_fetch_log WHERE source_id = ? ORDER BY id").all(a.id) as { outcome: string }[];
  assert.deepEqual(log.map(entry => entry.outcome), ["ok", "not-modified"]);
  const cState = sourceState(db, c.id)!;
  assert.deepEqual([cState.last_outcome, cState.consecutive_errors, cState.next_fetch_at - clock], ["error", 1, 120 * MIN], "exponential backoff");
  assert.equal(server.count("newsite.test /rss.xml"), 1, "the discovered source waits for approval");
  // Restart: new stores, fetchers and handlers on the same database and vault.
  engine = build();
  clock += 61 * MIN;
  cStatus = 200;
  await run();
  assert.equal(server.count("news-a.test /rss"), 3);
  assert.equal(server.count("news-c.test /rss"), 2, "backoff survives the restart");
  assert.deepEqual((db.prepare("SELECT outcome FROM watch_fetch_log WHERE source_id = ? ORDER BY id DESC LIMIT 1").get(a.id) as { outcome: string }).outcome, "not-modified", "ETag survives the restart");
  // robots.txt refusal is logged and retried after a day.
  const r = await approve(sources, "alice", { url: `${server.base("news-r.test")}/rss`, publisher: "Robots", topicIds: [topicId] });
  await run();
  assert.equal(server.count("news-r.test /rss"), 0);
  assert.deepEqual([sourceState(db, r.id)!.last_outcome, sourceState(db, r.id)!.next_fetch_at - clock], ["robots", 86_400_000]);
  // Paused agent: no collection is planned.
  await accounts.setWatchPolicy("alice", agentId, { revision: policy.revision, policy: { ...DEFAULT_WATCH_POLICY, enabled: true, paused: true } });
  clock += 3 * 3_600_000;
  const paused = await run();
  assert.equal(paused.planned, 0);
  // Diagnostics: owner only.
  const diagnostics = await watchDiagnostics({ db, accounts, sources, owner: "alice", agentId, autoPublish: false, now: new Date(clock) });
  assert.equal(diagnostics.running, false);
  assert.deepEqual(diagnostics.sources.map(s => s.status).sort(), ["approved", "approved", "approved", "approved", "proposed", "proposed"]);
  assert.ok(diagnostics.fetchLog.some(entry => entry.outcome === "error" && entry.httpStatus === 500));
  assert.deepEqual(diagnostics.stories.map(story => [story.itemCount, story.independentCount]).sort(), [[1, 1], [3, 2]]);
  assert.ok(diagnostics.jobs.some(job => job.kind === "collect-source") && diagnostics.jobs.some(job => job.kind === "discover-sources"));
  await assert.rejects(watchDiagnostics({ db, accounts, sources, owner: "bob", agentId, autoPublish: false }), /introuvable/);
  // Manual proposal goes through the same path and stays a proposal.
  const manual = await proposeFromUrl({ fetch: engine.fetch, sources, owner: "alice", url: `${server.base("newsite.test")}/`, topicIds: [topicId], by: "alice" });
  assert.equal(manual.created, false, "already proposed by the agent");
  await assert.rejects(proposeFromUrl({ fetch: engine.fetch, sources, owner: "alice", url: `${server.base("news-a.test")}/a/2`, topicIds: [topicId], by: "alice" }), /Aucun flux|inaccessible/);
});

test("quotas: fixtures have their own ceiling and never consume the real one", async t => {
  const { db, accounts, publications, topics, sources, agentId } = await setup(t);
  const agent = await accounts.getOwned("alice", agentId);
  const choice = () => ({ seed: randomUUID(), count: 1, accountRevision: agent.editorial!.revision, action: "publish", confirmed: true });
  const policy = await accounts.setWatchPolicy("alice", agentId, { revision: null, policy: { ...DEFAULT_WATCH_POLICY, enabled: true, autoPublish: true, maxPerDay: 1, minIntervalMinutes: 15, testMaxPerDay: 2 } });
  assert.equal(policy.policy.testMaxPerDay, 2);
  const first = choice();
  await manualPublication(accounts, topics, publications, "alice", agentId, first);
  await manualPublication(accounts, topics, publications, "alice", agentId, choice());
  const refused = await manualPublication(accounts, topics, publications, "alice", agentId, choice()).catch(error => error as PublicationError);
  assert.ok(refused instanceof PublicationError && refused.code === "rate_limited");
  assert.ok((await manualPublication(accounts, topics, publications, "alice", agentId, first)).publication, "an idempotent retry is not refused");
  await publications.ensureIndexed();
  assert.deepEqual(publications.agentPublications(agentId).map(p => p.test), [true, true]);
  // Two fixtures minutes ago, real ceiling 1 and interval 15 min: inside the night window the
  // real gate still allows a publication (no-candidates), it is not refused by ceiling or interval.
  const at = nextNight(new Date());
  const handlers = windowHandlers({ db, accounts, sources, publications, settings: { autoPublish: true, allowPublic: false }, now: () => at.getTime() });
  const job = { id: "w", kind: "publication-window", key: "w", payload: { agentId }, state: "running" as const, runAfter: 0, attempts: 1, maxAttempts: 1, leaseToken: "t", leaseUntil: 0, lastError: null, result: null, createdAt: 0, updatedAt: 0 };
  const { result } = await handlers["publication-window"](job) as { result: { outcome: string; reason?: string } };
  assert.equal(result.outcome, "no-candidates", JSON.stringify(result));
});

/** 04:00 Paris on the night following `from`, minutes after the fixtures (rolling 24 h). */
function nextNight(from: Date) {
  const window = nightWindow(from);
  return new Date(Math.max(window.start.getTime() + 60 * MIN, from.getTime()));
}

test("watch policy written before the test ceiling existed stays valid with its default", async t => {
  const { accounts, agentId, root } = await setup(t);
  const saved = await accounts.setWatchPolicy("alice", agentId, { revision: null, policy: { ...DEFAULT_WATCH_POLICY, enabled: true } });
  const handle = (await accounts.getOwned("alice", agentId)).handle;
  const file = join(root, "generators", handle, "index.md");
  await writeFile(file, (await readFile(file, "utf8")).replace(/\n\s*testMaxPerDay: 10/, ""));
  assert.ok(!(await readFile(file, "utf8")).includes("testMaxPerDay"));
  assert.deepEqual(await accounts.watchPolicy("alice", agentId), { ...saved, policy: { ...saved.policy, testMaxPerDay: 10 } });
});
