import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { InferenceConfigError, isLocalAddress } from "../watch/inference";
import { FetchError, USER_AGENT, type Fetcher, type FetchResponse } from "../watch/net";

/**
 * Destination policy of LLM providers (server side only). Provider URLs are configured by owners,
 * so the server must never become an HTTP proxy towards arbitrary hosts:
 * - every resolved address must be local (loopback, private networks, Tailscale CGNAT, IPv6 ULA)
 *   or an IP listed by the operator in XI_INFERENCE_ALLOW; link-local (cloud metadata) and public
 *   addresses are refused, and the connection is pinned to the checked address (no DNS rebinding);
 * - XI_LLM_ALLOWED_HOSTS (optional, "host" or "host:port", comma-separated) restricts further the
 *   hosts owners may use, e.g. on an installation with several accounts;
 * - fixed endpoints only (callers build the paths), no redirect, bounded responses and deadlines.
 * Unlike the watch fetcher, error statuses keep a small body: Ollama explains errors in JSON.
 */
export type DestinationPolicy = { allow: string[]; hosts: string[] | null };

/** Invalid XI_INFERENCE_ALLOW entries (not IP addresses) are ignored: the policy only gets stricter. */
export function destinationPolicyFromEnv(env: Record<string, string | undefined> = process.env): DestinationPolicy {
  const list = (value: string | undefined) => (value ?? "").split(",").map(item => item.trim()).filter(Boolean);
  const hosts = list(env.XI_LLM_ALLOWED_HOSTS).map(item => item.toLowerCase());
  return { allow: list(env.XI_INFERENCE_ALLOW).filter(item => isIP(item) !== 0), hosts: hosts.length ? hosts : null };
}

const acceptAddress = (policy: DestinationPolicy, address: string) => isLocalAddress(address) || policy.allow.includes(address);

/** `url.host` with its effective port, matched against "host" (any port) or "host:port" entries. */
function hostAllowed(policy: DestinationPolicy, url: URL) {
  if (!policy.hosts) return true;
  const host = url.hostname.toLowerCase();
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return policy.hosts.some(entry => entry === host || entry === `${host}:${port}`);
}

export function validateBaseUrl(raw: string, policy: DestinationPolicy): URL {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new InferenceConfigError("URL du serveur invalide.", "bad-url"); }
  if (!["http:", "https:"].includes(url.protocol)) throw new InferenceConfigError("URL du serveur : http ou https uniquement.", "bad-url");
  if (url.username || url.password || url.search || url.hash) throw new InferenceConfigError("URL du serveur : sans identifiants, paramètres ni fragment.", "bad-url");
  if (!url.hostname) throw new InferenceConfigError("URL du serveur invalide.", "bad-url");
  const literal = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(literal) && !acceptAddress(policy, literal)) throw new InferenceConfigError("Destination refusée : le serveur doit être sur le réseau local ou autorisé par l’opérateur.", "blocked");
  if (!hostAllowed(policy, url)) throw new InferenceConfigError("Destination refusée : hôte absent de la liste autorisée par l’opérateur (XI_LLM_ALLOWED_HOSTS).", "blocked");
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

/** The connection dropped after the response had started (as opposed to an unreachable server). */
export class InterruptedFetchError extends FetchError {
  constructor() { super("network", "Connexion interrompue pendant la réponse."); }
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
/** Error bodies only carry Ollama's short JSON explanation. */
const MAX_ERROR_BYTES = 16_000;

export function createProviderFetch(policy: DestinationPolicy, { resolve = (host: string) => dnsLookup(host, { all: true, verbatim: true }) }: { resolve?: (host: string) => Promise<{ address: string; family: number }[]> } = {}): Fetcher {
  return async function providerFetch(input, { method = "GET", body, headers = {}, maxBytes = 1_000_000, timeoutMs = 15_000 } = {}) {
    let url: URL;
    try { url = new URL(input); } catch { throw new FetchError("blocked-url", "URL invalide."); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new FetchError("blocked-url", "URL non autorisée.");
    if (!hostAllowed(policy, url)) throw new FetchError("blocked-url", "Hôte non autorisé.");
    const deadline = Date.now() + timeoutMs;
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await resolve(hostname).catch(() => { throw new FetchError("network", "Nom de domaine introuvable."); });
    if (!addresses.length) throw new FetchError("network", "Nom de domaine introuvable.");
    if (addresses.some(entry => !acceptAddress(policy, entry.address))) throw new FetchError("blocked-address", "Adresse réseau non autorisée.");
    const pinned = addresses[0];
    const lookup = ((_host: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
      if (options?.all) callback(null, [{ address: pinned.address, family: pinned.family }]);
      else callback(null, pinned.address, pinned.family);
    }) as unknown as LookupFunction;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new FetchError("timeout", "Délai dépassé.");

    return new Promise<FetchResponse>((resolvePromise, rejectPromise) => {
      let settled = false;
      const finish = (error: Error | null, value?: FetchResponse) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) rejectPromise(error instanceof FetchError ? error : new FetchError("network", "Connexion refusée."));
        else resolvePromise(value!);
      };
      const client = url.protocol === "https:" ? https : http;
      const request = client.request(url, { method, lookup, headers: { "User-Agent": USER_AGENT, ...(body === undefined ? {} : { "Content-Length": String(Buffer.byteLength(body)) }), ...headers } }, response => {
        const status = response.statusCode ?? 0;
        const responseHeaders = Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key.toLowerCase(), Array.isArray(value) ? value.join(", ") : String(value ?? "")]));
        if (REDIRECTS.has(status)) { response.resume(); return finish(new FetchError("redirect", "Redirection refusée.")); }
        const limit = status >= 400 ? Math.min(maxBytes, MAX_ERROR_BYTES) : maxBytes;
        if (status < 400 && Number(responseHeaders["content-length"]) > limit) { response.destroy(); return finish(new FetchError("too-large", "Réponse trop volumineuse.")); }
        const chunks: Buffer[] = [];
        let total = 0;
        let ended = false;
        response.on("data", (chunk: Buffer) => {
          if (total >= limit) return;
          total += chunk.length;
          if (total > limit) {
            // An error explanation is simply cut; a successful body too large is refused.
            if (status >= 400) chunks.push(chunk.subarray(0, chunk.length - (total - limit)));
            else { response.destroy(); finish(new FetchError("too-large", "Réponse trop volumineuse.")); }
          } else chunks.push(chunk);
        });
        response.on("end", () => { ended = true; finish(null, { status, url: url.href, headers: responseHeaders, body: Buffer.concat(chunks) }); });
        response.on("error", () => finish(new InterruptedFetchError()));
        response.on("close", () => { if (!ended) finish(new InterruptedFetchError()); });
      });
      const timer = setTimeout(() => { request.destroy(); finish(new FetchError("timeout", "Délai dépassé.")); }, remaining);
      request.on("error", error => finish(error));
      request.end(body);
    });
  };
}
