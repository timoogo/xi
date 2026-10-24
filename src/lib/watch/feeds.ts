import { XMLParser } from "fast-xml-parser";
import { z } from "zod";

/** One entry as published by a source: only what the feed states, never completed or invented. */
export type FeedEntry = {
  url: string; guid: string | null; title: string; summary: string; publishedAt: string | null;
  author: string | null; credits: string[]; links: string[];
};
export type ParsedFeed = { title: string | null; site: string | null; entries: FeedEntry[] };
export class FeedError extends Error { name = "FeedError"; }

const MAX_ENTRIES = 200;

/** Mapping of a configured official JSON API onto entries (dotted paths). */
export const jsonApiSchema = z.object({
  itemsPath: z.string().max(200), url: z.string().min(1).max(200), title: z.string().min(1).max(200),
  summary: z.string().max(200).optional(), publishedAt: z.string().max(200).optional(), id: z.string().max(200).optional(),
}).strict();
export type JsonApiMapping = z.infer<typeof jsonApiSchema>;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", eacute: "é", egrave: "è", ecirc: "ê", agrave: "à", acirc: "â", ccedil: "ç", ocirc: "ô", ucirc: "û", ugrave: "ù", icirc: "î", iuml: "ï", euml: "ë", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", laquo: "«", raquo: "»", hellip: "…", mdash: "—", ndash: "–" };
function decodeEntities(text: string) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, code: string) => {
    if (code[0] === "#") {
      const point = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : "";
    }
    return ENTITIES[code.toLowerCase()] ?? all;
  });
}

/** Feed HTML → plain text and the http(s) links it contains. No HTML is ever kept or rendered. */
export function htmlToText(html: string, base?: string) {
  const links: string[] = [];
  for (const match of html.matchAll(/<a\b[^>]*?\bhref\s*=\s*["']([^"']+)["']/gi)) {
    const url = absolute(decodeEntities(match[1]), base);
    if (url) links.push(url);
  }
  const text = decodeEntities(html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
  return { text, links: [...new Set(links)] };
}

function absolute(href: string, base?: string) {
  try {
    const url = new URL(href.trim(), base);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

const AGENCIES = ["AFP", "Reuters", "Associated Press", "AP", "Belga", "ANSA", "DPA", "EFE", "ATS", "Keystone-ATS", "Bloomberg", "Xinhua"];
const agencyPattern = AGENCIES.map(name => name.replace(/[-]/g, "\\-").replace(/ /g, "\\s+")).join("|");
// Agency names are matched case-sensitively ("AP", "ATS" are also ordinary words); introducers may be capitalized.
const creditInText = new RegExp(`(?:\\(|\\b[Aa]vec\\s+(?:l['’])?|\\b[Ss]ource\\s*:?\\s*(?:l['’])?|\\b[Ss]elon\\s+(?:l['’])?|\\b[Dd]['’]apr[eè]s\\s+(?:l['’])?|[—–-]\\s*)(${agencyPattern})\\b`, "g");
const agencyOnly = new RegExp(`^(?:${agencyPattern})$`, "i");

/** Wire agencies credited by an entry: two copies of one dispatch are not independent confirmations. */
export function detectCredits(...texts: (string | null)[]) {
  const found = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    if (agencyOnly.test(text.trim())) found.add(canonicalAgency(text.trim()));
    for (const match of text.matchAll(creditInText)) found.add(canonicalAgency(match[1]));
  }
  return [...found].sort();
}
const canonicalAgency = (name: string) => {
  const flat = name.replace(/\s+/g, " ").toLowerCase();
  return flat === "associated press" ? "ap" : flat === "keystone-ats" ? "ats" : flat;
};

const parser = new XMLParser({
  ignoreAttributes: false, attributeNamePrefix: "@_", textNodeName: "#text", parseTagValue: false, parseAttributeValue: false,
  trimValues: true, processEntities: true, htmlEntities: false,
  isArray: name => ["item", "entry", "link", "category"].includes(name),
});

const text = (value: unknown): string => {
  if (value === undefined || value === null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return text(value[0]);
  if (typeof value === "object") return text((value as Record<string, unknown>)["#text"]);
  return "";
};
const date = (value: string) => {
  const time = Date.parse(value);
  return value && Number.isFinite(time) ? new Date(time).toISOString() : null;
};
const clip = (value: string, max: number) => (value.length > max ? value.slice(0, max - 1) + "…" : value);

function entry(raw: { link: string | null; guid: string; title: string; html: string; published: string; author: string }, base?: string): FeedEntry | null {
  const url = raw.link ? absolute(raw.link, base) : null;
  if (!url) return null;
  const title = clip(htmlToText(raw.title).text, 500);
  const { text: summary, links } = htmlToText(raw.html, url);
  const author = raw.author ? clip(htmlToText(raw.author).text, 200) : null;
  return {
    url, guid: raw.guid ? clip(raw.guid, 500) : null, title, summary: clip(summary, 2_000), publishedAt: date(raw.published),
    author, credits: detectCredits(title, summary, author), links: links.filter(link => link !== url).slice(0, 50),
  };
}

/** RSS 2.0, RSS 1.0 (RDF) or Atom. Documents with a DOCTYPE or entity declarations are refused. */
export function parseFeed(body: string, base?: string): ParsedFeed {
  if (/<!DOCTYPE|<!ENTITY/i.test(body)) throw new FeedError("Flux refusé : déclarations DTD non autorisées.");
  let document: Record<string, unknown>;
  try { document = parser.parse(body); } catch { throw new FeedError("Flux XML illisible."); }
  const rss = (document.rss as Record<string, unknown> | undefined)?.channel as Record<string, unknown> | undefined;
  const rdf = document["rdf:RDF"] as Record<string, unknown> | undefined;
  const atom = document.feed as Record<string, unknown> | undefined;
  if (rss || rdf) {
    const channel = (rss ?? rdf!.channel ?? {}) as Record<string, unknown>;
    const items = ((rss ? rss.item : rdf!.item) ?? []) as Record<string, unknown>[];
    const site = absolute(text(channel.link), base);
    return {
      title: text(channel.title) || null, site,
      entries: items.slice(0, MAX_ENTRIES).flatMap(item => entry({
        link: text(item.link) || (typeof item["@_rdf:about"] === "string" ? item["@_rdf:about"] : null),
        guid: text(item.guid), title: text(item.title), html: text(item["content:encoded"]) || text(item.description),
        published: text(item.pubDate) || text(item["dc:date"]), author: text(item["dc:creator"]) || text(item.author),
      }, base ?? site ?? undefined) ?? []),
    };
  }
  if (atom) {
    const links = (value: unknown) => (Array.isArray(value) ? value : []) as Record<string, unknown>[];
    const alternate = (value: unknown) => {
      const link = links(value).find(item => !item["@_rel"] || item["@_rel"] === "alternate");
      return typeof link?.["@_href"] === "string" ? link["@_href"] : null;
    };
    const site = absolute(alternate(atom.link) ?? "", base);
    return {
      title: text(atom.title) || null, site,
      entries: ((atom.entry ?? []) as Record<string, unknown>[]).slice(0, MAX_ENTRIES).flatMap(item => entry({
        link: alternate(item.link), guid: text(item.id), title: text(item.title), html: text(item.content) || text(item.summary),
        published: text(item.published) || text(item.updated), author: text((item.author as Record<string, unknown> | undefined)?.name),
      }, base ?? site ?? undefined) ?? []),
    };
  }
  throw new FeedError("Ce document n’est pas un flux RSS ou Atom.");
}

const at = (value: unknown, path: string): unknown => path ? path.split(".").reduce<unknown>((current, key) => (current && typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined), value) : value;

/** Configured official JSON API: entries are read only through the declared mapping. */
export function parseJsonApi(body: string, mapping: JsonApiMapping, base?: string): ParsedFeed {
  let document: unknown;
  try { document = JSON.parse(body); } catch { throw new FeedError("Réponse JSON illisible."); }
  const items = at(document, mapping.itemsPath);
  if (!Array.isArray(items)) throw new FeedError("Liste d’éléments introuvable dans la réponse de l’API.");
  const string = (value: unknown) => (typeof value === "string" || typeof value === "number" ? String(value) : "");
  return {
    title: null, site: null,
    entries: items.slice(0, MAX_ENTRIES).flatMap(item => entry({
      link: string(at(item, mapping.url)) || null, guid: mapping.id ? string(at(item, mapping.id)) : "",
      title: string(at(item, mapping.title)), html: mapping.summary ? string(at(item, mapping.summary)) : "",
      published: mapping.publishedAt ? string(at(item, mapping.publishedAt)) : "", author: "",
    }, base) ?? []),
  };
}

/** Feed links advertised by an HTML page (`<link rel="alternate">`), and the site name. */
export function discoverFeeds(html: string, base: string) {
  const feeds: string[] = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const attribute = (name: string) => new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(tag)?.[1] ?? "";
    if (!/\balternate\b/i.test(attribute("rel")) || !/application\/(rss|atom)\+xml/i.test(attribute("type"))) continue;
    const url = absolute(decodeEntities(attribute("href")), base);
    if (url) feeds.push(url);
  }
  const siteName = /<meta\b[^>]*property\s*=\s*["']og:site_name["'][^>]*content\s*=\s*["']([^"']+)["']/i.exec(html)?.[1]
    ?? /<title[^>]*>([^<]{1,200})<\/title>/i.exec(html)?.[1] ?? null;
  return { feeds: [...new Set(feeds)].slice(0, 5), siteName: siteName ? clip(decodeEntities(siteName).trim(), 200) : null };
}
