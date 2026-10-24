import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import type { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type Database from "better-sqlite3";
import { parseRobots, robotsAllows, type RobotsPolicy } from "./robots";

export const USER_AGENT = "XiWatch/1.0 (veille locale Xi; respecte robots.txt)";

export type FetchErrorCode = "blocked-url" | "blocked-address" | "redirect" | "too-large" | "timeout" | "network" | "http" | "robots" | "throttled";
export class FetchError extends Error {
  constructor(readonly code: FetchErrorCode, message: string, readonly status: number | null = null, readonly retryAt: number | null = null) {
    super(message);
    this.name = "FetchError";
  }
}

// Loopback, private, link-local, CGNAT, documentation, multicast, reserved and translation ranges.
// BlockList maps IPv4-mapped IPv6 (::ffff:a.b.c.d) onto the IPv4 rules by itself: a ::ffff:0:0/96
// rule would block every IPv4 address.
const blocked = new BlockList();
for (const [network, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) blocked.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [["::", 128], ["::1", 128], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const) blocked.addSubnet(network, prefix, "ipv6");

export function isPublicAddress(address: string) {
  const family = isIP(address);
  return family !== 0 && !blocked.check(address, family === 4 ? "ipv4" : "ipv6");
}

export type FetchResponse = { status: number; url: string; headers: Record<string, string>; body: Buffer };
export type FetchOptions = { method?: "GET" | "POST"; body?: string; headers?: Record<string, string>; maxBytes?: number; timeoutMs?: number; maxRedirects?: number; beforeRequest?: (url: URL) => Promise<void> };
export type Fetcher = (url: string, options?: FetchOptions) => Promise<FetchResponse>;
type Resolver = (host: string) => Promise<{ address: string; family: number }[]>;

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * GET with SSRF protection: http(s) only, no credentials, default ports, every resolved address
 * public; the connection is pinned to the checked address (no DNS rebinding) and each redirect
 * is checked again, without HTTPS → HTTP downgrade. Size is limited after decompression; one
 * deadline covers all hops. Error statuses return without a body.
 * `allowAddress`, `allowAnyPort` and `resolve` let tests stand local fixture servers in for public
 * hosts; production always uses the defaults.
 */
export function createSafeFetch({ allowAddress = isPublicAddress, allowAnyPort = false, resolve = (host: string) => dnsLookup(host, { all: true, verbatim: true }) }: { allowAddress?: (address: string) => boolean; allowAnyPort?: boolean; resolve?: Resolver } = {}): Fetcher {
  function target(raw: string) {
    let url: URL;
    try { url = new URL(raw); } catch { throw new FetchError("blocked-url", "URL invalide."); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new FetchError("blocked-url", "URL non autorisée.");
    if (!allowAnyPort && url.port && !["80", "443"].includes(url.port)) throw new FetchError("blocked-url", "Port non autorisé.");
    return url;
  }

  async function once(url: URL, headers: Record<string, string>, maxBytes: number, deadline: number, method: "GET" | "POST", body?: string): Promise<FetchResponse> {
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await resolve(hostname).catch(() => { throw new FetchError("network", "Nom de domaine introuvable."); });
    if (!addresses.length) throw new FetchError("network", "Nom de domaine introuvable.");
    if (addresses.some(entry => !allowAddress(entry.address))) throw new FetchError("blocked-address", "Adresse réseau non autorisée.");
    const pinned = addresses[0];
    const lookup = ((_host: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
      if (options?.all) callback(null, [{ address: pinned.address, family: pinned.family }]);
      else callback(null, pinned.address, pinned.family);
    }) as unknown as LookupFunction;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new FetchError("timeout", "Délai dépassé.");
    return new Promise((resolvePromise, rejectPromise) => {
      let settled = false;
      const finish = (error: Error | null, value?: FetchResponse) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) rejectPromise(error instanceof FetchError ? error : new FetchError("network", "Erreur réseau."));
        else resolvePromise(value!);
      };
      const client = url.protocol === "https:" ? https : http;
      const request = client.request(url, { method, lookup, headers: { "User-Agent": USER_AGENT, "Accept-Encoding": "gzip, deflate, br", ...(body === undefined ? {} : { "Content-Length": String(Buffer.byteLength(body)) }), ...headers } }, response => {
        const status = response.statusCode ?? 0;
        const responseHeaders = Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key.toLowerCase(), Array.isArray(value) ? value.join(", ") : String(value ?? "")]));
        if (REDIRECTS.has(status) || status === 304 || status >= 400) {
          response.resume();
          return finish(null, { status, url: url.href, headers: responseHeaders, body: Buffer.alloc(0) });
        }
        if (Number(responseHeaders["content-length"]) > maxBytes) { response.destroy(); return finish(new FetchError("too-large", "Réponse trop volumineuse.")); }
        const encoding = (responseHeaders["content-encoding"] || "identity").toLowerCase();
        const decoder = encoding === "gzip" || encoding === "x-gzip" ? createGunzip() : encoding === "deflate" ? createInflate() : encoding === "br" ? createBrotliDecompress() : encoding === "identity" ? null : undefined;
        if (decoder === undefined) { response.destroy(); return finish(new FetchError("network", "Encodage non pris en charge.")); }
        const stream: Readable = decoder ? response.pipe(decoder) : response;
        const chunks: Buffer[] = [];
        let total = 0;
        stream.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > maxBytes) { response.destroy(); stream.destroy(); finish(new FetchError("too-large", "Réponse trop volumineuse.")); }
          else chunks.push(chunk);
        });
        stream.on("end", () => finish(null, { status, url: url.href, headers: responseHeaders, body: Buffer.concat(chunks) }));
        stream.on("error", () => finish(new FetchError("network", "Réponse illisible.")));
        response.on("error", () => finish(new FetchError("network", "Connexion interrompue.")));
      });
      const timer = setTimeout(() => { request.destroy(); finish(new FetchError("timeout", "Délai dépassé.")); }, remaining);
      request.on("error", error => finish(error));
      request.end(body);
    });
  }

  return async function safeFetch(input, { method = "GET", body, headers = {}, maxBytes = 2_000_000, timeoutMs = 15_000, maxRedirects = 3, beforeRequest } = {}) {
    const deadline = Date.now() + timeoutMs;
    let url = target(input);
    for (let hop = 0; ; hop++) {
      await beforeRequest?.(url);
      const response = await once(url, headers, maxBytes, deadline, method, body);
      const location = response.headers.location;
      if (!REDIRECTS.has(response.status) || !location) return response;
      if (hop >= maxRedirects) throw new FetchError("redirect", "Trop de redirections.");
      const next = target(new URL(location, url).href);
      if (url.protocol === "https:" && next.protocol === "http:") throw new FetchError("redirect", "Redirection de HTTPS vers HTTP refusée.");
      url = next;
    }
  };
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export function migrateWatchHosts(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS watch_host (
    origin TEXT PRIMARY KEY,
    robots TEXT,
    robots_state TEXT,
    robots_fetched_at INTEGER,
    next_allowed_at INTEGER NOT NULL DEFAULT 0,
    blocked_until INTEGER NOT NULL DEFAULT 0
  )`);
}

export function parseRetryAfter(value: string | undefined, now: number) {
  if (!value) return null;
  if (/^\d+$/.test(value.trim())) return now + Number(value.trim()) * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? date : null;
}

type HostRow = { origin: string; robots: string | null; robots_state: "ok" | "none" | "unreachable" | null; robots_fetched_at: number | null; next_allowed_at: number; blocked_until: number };

/**
 * Polite access per origin, shared by every process through SQLite: robots.txt (cached 24 h;
 * unreachable = disallowed and retried after 1 h), at least `minIntervalMs` (or Crawl-delay)
 * between requests, and a pause honouring 429/503 Retry-After (1 h by default, 24 h at most).
 */
export function createPoliteFetch({ db, fetch, now = Date.now, minIntervalMs = 5_000 }: { db: Database.Database; fetch: Fetcher; now?: () => number; minIntervalMs?: number }) {
  migrateWatchHosts(db);
  const row = (origin: string) => db.prepare<[string], HostRow>("SELECT * FROM watch_host WHERE origin = ?").get(origin)
    ?? { origin, robots: null, robots_state: null, robots_fetched_at: null, next_allowed_at: 0, blocked_until: 0 };
  const save = (host: HostRow) => db.prepare(`INSERT INTO watch_host VALUES (@origin, @robots, @robots_state, @robots_fetched_at, @next_allowed_at, @blocked_until)
    ON CONFLICT(origin) DO UPDATE SET robots = excluded.robots, robots_state = excluded.robots_state, robots_fetched_at = excluded.robots_fetched_at,
    next_allowed_at = excluded.next_allowed_at, blocked_until = excluded.blocked_until`).run(host);

  async function robots(origin: string): Promise<RobotsPolicy | null> {
    let host = row(origin);
    const age = host.robots_fetched_at === null ? Infinity : now() - host.robots_fetched_at;
    if (age >= (host.robots_state === "unreachable" ? HOUR : DAY)) {
      let state: HostRow["robots_state"] = "unreachable";
      let text: string | null = null;
      try {
        const response = await fetch(`${origin}/robots.txt`, { maxBytes: 512_000, timeoutMs: 10_000, maxRedirects: 5, headers: { Accept: "text/plain" } });
        if (response.status >= 200 && response.status < 300) { state = "ok"; text = response.body.toString("utf8"); }
        else if (response.status >= 400 && response.status < 500) state = "none";
      } catch (error) {
        if (error instanceof FetchError && (error.code === "blocked-url" || error.code === "blocked-address")) throw error;
      }
      host = { ...row(origin), robots: text, robots_state: state, robots_fetched_at: now() };
      save(host);
    }
    if (host.robots_state === "unreachable") return null;
    return host.robots_state === "ok" ? parseRobots(host.robots ?? "") : { rules: [], crawlDelayMs: null };
  }

  async function allowed(url: URL) {
    const policy = await robots(url.origin);
    if (!policy || !robotsAllows(policy, url.pathname + url.search)) throw new FetchError("robots", "Accès refusé par robots.txt.");
    return policy;
  }

  return async function politeFetch(input: string, options: Omit<FetchOptions, "beforeRequest"> = {}): Promise<FetchResponse> {
    let url: URL;
    try { url = new URL(input); } catch { throw new FetchError("blocked-url", "URL invalide."); }
    const host = row(url.origin);
    const wait = Math.max(host.blocked_until, host.next_allowed_at);
    if (wait > now()) throw new FetchError("throttled", "Fournisseur à ménager : nouvelle tentative plus tard.", null, wait);
    const policy = await allowed(url);
    save({ ...row(url.origin), next_allowed_at: now() + Math.max(minIntervalMs, policy.crawlDelayMs ?? 0) });
    // Redirect targets on other origins must allow us too.
    const response = await fetch(input, { ...options, beforeRequest: async next => { if (next.href !== url.href) await allowed(next); } });
    if (response.status === 429 || response.status === 503) {
      const retryAt = Math.min(parseRetryAfter(response.headers["retry-after"], now()) ?? now() + HOUR, now() + DAY);
      save({ ...row(url.origin), blocked_until: retryAt });
      throw new FetchError("http", `HTTP ${response.status}`, response.status, retryAt);
    }
    return response;
  };
}
export type PoliteFetch = ReturnType<typeof createPoliteFetch>;
