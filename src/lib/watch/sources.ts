import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { assertWithin, inside, listDir, writeAtomic, type Vault } from "../publications/vault";
import { locked } from "../topics/lock";
import type { TopicStore } from "../topics/store";
import { TopicError } from "../topics/types";
import { jsonApiSchema, type FeedEntry } from "./feeds";
import { canonicalUrl } from "./stories";

/**
 * Semi-autonomous source catalogue: `<vault>/watch/sources/<uuid>.md`, private (0700), one file
 * per source, owned by one user and shared by that user's agents through topic attribution.
 * The status is the owner's global trust decision (trust.ts): `proposed` = pending, `approved`,
 * `rejected` = denied. Pending and approved sources are collected and analysed; only approved ones
 * can establish a claim. Each decision is appended to `history`; deletion keeps a tombstone, so
 * rejected or deleted sources are never proposed again.
 */
const iso = z.iso.datetime();
const httpUrl = z.string().max(2_000).refine(value => {
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
}, "URL http(s) attendue.");
export const RELIABILITY = ["élevée", "moyenne", "faible", "inconnue"] as const;
export const SOURCE_STATUSES = ["proposed", "approved", "rejected", "disabled", "deleted"] as const;
const historySchema = z.object({
  at: iso, by: z.string().min(1).max(200), action: z.enum(["proposed", "approved", "rejected", "disabled", "deleted", "updated"]),
  note: z.string().max(1_000).nullable(), changes: z.record(z.string(), z.unknown()).nullable(),
}).strict();
export const sourceSchema = z.object({
  id: z.uuid(), owner: z.string().min(1).max(200), status: z.enum(SOURCE_STATUSES),
  kind: z.enum(["feed", "json"]), url: httpUrl, site: httpUrl.nullable(),
  publisher: z.string().trim().min(1).max(200), ownerGroup: z.string().trim().min(1).max(200).nullable(),
  orientation: z.string().trim().min(1).max(200).nullable(), topicIds: z.array(z.uuid()).min(1).max(30),
  reliability: z.object({ level: z.enum(RELIABILITY), reasons: z.array(z.string().max(300)).max(10), estimated: z.boolean() }).strict(),
  api: jsonApiSchema.nullable(), pollMinutes: z.number().int().min(15).max(1_440),
  proposedBy: z.string().min(1).max(200), revision: z.uuid(), createdAt: iso, updatedAt: iso,
  history: z.array(historySchema).max(1_000),
}).strict();
export type Source = z.infer<typeof sourceSchema>;

const editsSchema = z.object({
  publisher: z.string().trim().min(1).max(200), ownerGroup: z.string().trim().min(1).max(200).nullable(),
  orientation: z.string().trim().min(1).max(200).nullable(), topicIds: z.array(z.uuid()).min(1).max(30),
  pollMinutes: z.number().int().min(15).max(1_440), reliability: z.enum(RELIABILITY),
}).partial().strict();
export const decisionSchema = z.object({
  action: z.enum(["approve", "reject", "reset", "disable", "enable", "delete", "update"]), revision: z.uuid(),
  note: z.string().trim().max(1_000).optional(), edits: editsSchema.optional(),
}).strict();
const FROM: Record<z.infer<typeof decisionSchema>["action"], readonly Source["status"][]> = {
  approve: ["proposed", "rejected", "disabled"], reject: ["proposed", "approved", "disabled"], reset: ["approved", "rejected", "disabled"], disable: ["approved", "proposed"], enable: ["disabled"],
  delete: ["proposed", "approved", "rejected", "disabled"], update: ["proposed", "approved", "disabled"],
};
const TO = { approve: "approved", reject: "rejected", reset: "proposed", disable: "disabled", delete: "deleted" } as const;
// `reset` (back to pending) is recorded as an update of the status: files stay readable by earlier versions.
// `enable` restores the status the source had before it was disabled (statusBeforeDisable).
const HISTORY_ACTION = { approve: "approved", reject: "rejected", reset: "updated", disable: "disabled", delete: "deleted", update: "updated" } as const;

export type Proposal = {
  url: string; kind: Source["kind"]; site: string | null; publisher: string; topicIds: string[];
  reliability: Source["reliability"]; api?: Source["api"]; pollMinutes?: number; note?: string | null;
};

const OFFICIAL = ["gouv.fr", "gouv", "gov", "gov.uk", "europa.eu", "int", "assemblee-nationale.fr", "senat.fr", "conseil-constitutionnel.fr", "conseil-etat.fr", "courdecassation.fr", "elysee.fr", "insee.fr", "banque-france.fr", "un.org", "who.int", "oecd.org", "imf.org", "worldbank.org"];

/** Institutional domain: a primary source for its own acts and statements, not proof of everything it states. */
export function isOfficialUrl(url: string) {
  const host = new URL(url).hostname.toLowerCase();
  return OFFICIAL.some(suffix => host === suffix || host.endsWith("." + suffix));
}

/** Automatic, explainable estimate shown as such; the owner decides. Never inferred from a political label. */
export function estimateReliability({ url, citedBy = 0, entries }: { url: string; citedBy?: number; entries: FeedEntry[] }): Source["reliability"] {
  const reasons: string[] = [];
  const official = isOfficialUrl(url);
  if (official) reasons.push("Domaine institutionnel officiel.");
  if (citedBy) reasons.push(`Citée par ${citedBy} source(s) déjà approuvée(s).`);
  reasons.push(url.startsWith("https:") ? "Flux servi en HTTPS." : "Flux non chiffré (HTTP).");
  const dated = entries.filter(entry => entry.publishedAt).length;
  reasons.push(`${dated}/${entries.length} article(s) daté(s).`);
  const level = official ? "élevée" : citedBy >= 3 && dated === entries.length ? "moyenne" : "inconnue";
  return { level, reasons, estimated: true };
}

export const isCollectable = (source: Pick<Source, "status">) => source.status === "approved" || source.status === "proposed";

/** The status a disabled source had before its collection was turned off (re-enabling restores it). */
export function statusBeforeDisable(source: Pick<Source, "history">): "approved" | "proposed" {
  let status: string = "proposed";
  let before: string = "approved";
  for (const entry of source.history) {
    if (entry.action === "disabled") before = status;
    status = entry.action === "updated" ? String(entry.changes?.status ?? status) : entry.action;
  }
  return before === "proposed" ? "proposed" : "approved";
}

/**
 * Owner input: trimmed, `https://` added when no scheme is given, http(s) only, no credentials,
 * no fragment, tracking parameters removed (canonicalUrl).
 */
export function normalizeSourceUrl(input: string) {
  const text = input.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
  let url: URL;
  try { url = new URL(withScheme); } catch { throw new TopicError("Adresse invalide."); }
  if (!["http:", "https:"].includes(url.protocol)) throw new TopicError("Seules les adresses http(s) sont acceptées.");
  if (url.username || url.password) throw new TopicError("Une adresse ne doit pas contenir d’identifiants.");
  return httpUrl.parse(canonicalUrl(url.href).url);
}
const encode = (data: unknown) => `---\n${stringify(data)}---\n`;
const decode = (text: string) => { const match = /^---\n([\s\S]*?)\n---\n/.exec(text); if (!match) throw new Error("invalid"); return parse(match[1]); };

export function createSourceStore({ vault, topics, now = () => new Date() }: { vault: Vault; topics: TopicStore; now?: () => Date }) {
  const root = inside(vault.root, "watch");
  const directory = inside(root, "sources");

  async function prepare() {
    for (const dir of [root, directory]) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      if (await assertWithin(vault.root, dir) !== dir) throw new TopicError("Lien symbolique interdit.");
    }
  }
  /** Invalid files are never collected; they are counted for the diagnostics. */
  async function all() {
    await prepare();
    const sources: Source[] = [];
    let invalid = 0;
    for (const entry of await listDir(directory)) {
      if (!entry.isFile() || !/^[0-9a-f-]{36}\.md$/.test(entry.name)) continue;
      const path = inside(directory, entry.name);
      try {
        if (await assertWithin(vault.root, path) !== path) throw new Error("symlink");
        const source = sourceSchema.parse(decode(await readFile(path, "utf8")));
        if (`${source.id}.md` !== entry.name) throw new Error("id");
        sources.push(source);
      } catch { invalid++; }
    }
    return { sources: sources.sort((a, b) => a.createdAt.localeCompare(b.createdAt)), invalid };
  }
  const write = (source: Source) => writeAtomic(inside(directory, `${source.id}.md`), encode(source));
  const exclusive = async <T>(task: () => Promise<T>) => { await prepare(); return locked(root, task); };
  async function validTopics(ids: string[]) {
    const catalog = await topics.list();
    if (new Set(ids).size !== ids.length || ids.some(id => !catalog.some(topic => topic.id === id))) throw new TopicError("Topics absents ou dupliqués.");
  }

  async function list(owner: string, { includeDeleted = false } = {}) {
    const { sources, invalid } = await all();
    return { sources: sources.filter(source => source.owner === owner && (includeDeleted || source.status !== "deleted")), invalid };
  }
  async function get(owner: string, id: string) {
    if (!z.uuid().safeParse(id).success) throw new TopicError("Source introuvable.", 404);
    const source = (await all()).sources.find(item => item.id === id && item.owner === owner && item.status !== "deleted");
    if (!source) throw new TopicError("Source introuvable.", 404);
    return source;
  }
  async function approved() {
    return (await all()).sources.filter(source => source.status === "approved");
  }
  /** Pending and approved sources of every owner: the collector's only input. Denied, disabled and deleted ones are never fetched. */
  async function collectable() {
    return (await all()).sources.filter(source => isCollectable(source));
  }

  /** The owner's source (tombstones included) whose feed or site is this address. */
  async function find(owner: string, url: string) {
    const key = canonicalUrl(url).key;
    return (await all()).sources.find(source => source.owner === owner && [source.url, source.site].some(address => address && canonicalUrl(address).key === key)) ?? null;
  }

  /**
   * Idempotent per owner and feed URL, whatever the existing status: a rejection is not undone by
   * re-proposing, and a deleted source stays deleted (never re-discovered) unless `revive` (the
   * owner adding it again by hand): it is then pending again, with the same id and its history.
   */
  async function propose(owner: string, input: Proposal, by: string, { revive = false } = {}) {
    const url = httpUrl.parse(input.url);
    await validTopics(input.topicIds);
    return exclusive(async () => {
      const key = canonicalUrl(url).key;
      const existing = (await all()).sources.find(source => source.owner === owner && canonicalUrl(source.url).key === key);
      if (existing?.status === "deleted" && revive) {
        const at = now().toISOString();
        const source = sourceSchema.parse({
          ...existing, status: "proposed", topicIds: input.topicIds, revision: randomUUID(), updatedAt: at,
          history: [...existing.history, { at, by, action: "proposed", note: input.note ?? "Ajoutée à nouveau après suppression.", changes: null }],
        });
        await write(source);
        return { source, created: false, revived: true };
      }
      if (existing) return { source: existing, created: false };
      const at = now().toISOString();
      const source = sourceSchema.parse({
        id: randomUUID(), owner, status: "proposed", kind: input.kind, url, site: input.site, publisher: input.publisher.trim().slice(0, 200) || new URL(url).hostname,
        ownerGroup: null, orientation: null, topicIds: input.topicIds, reliability: input.reliability, api: input.api ?? null, pollMinutes: input.pollMinutes ?? 60,
        proposedBy: by, revision: randomUUID(), createdAt: at, updatedAt: at,
        history: [{ at, by, action: "proposed", note: input.note ?? null, changes: null }],
      });
      await write(source);
      return { source, created: true };
    });
  }

  /** Owner decisions. A stale revision is refused (409); impossible transitions too. */
  async function decide(owner: string, id: string, input: unknown) {
    const decision = decisionSchema.parse(input);
    if (decision.edits?.topicIds) await validTopics(decision.edits.topicIds);
    if (decision.action === "update" && !decision.edits) throw new TopicError("Aucune modification fournie.");
    if (decision.edits && !["approve", "update"].includes(decision.action)) throw new TopicError("Modifications possibles uniquement à l’approbation ou en mise à jour.");
    return exclusive(async () => {
      const source = await get(owner, id);
      if (source.revision !== decision.revision) throw new TopicError("La source a changé depuis votre lecture. Rechargez.", 409);
      if (!FROM[decision.action].includes(source.status)) throw new TopicError("Action impossible dans l’état actuel de la source.", 409);
      const at = now().toISOString();
      const { reliability, ...edits } = decision.edits ?? {};
      const status = decision.action === "update" ? source.status : decision.action === "enable" ? statusBeforeDisable(source) : TO[decision.action];
      const action = decision.action === "enable" ? (status === "approved" ? "approved" : "updated") : HISTORY_ACTION[decision.action];
      const changes: Record<string, unknown> = { ...edits, ...(reliability ? { reliability } : {}), ...(action === "updated" && status === "proposed" && decision.action !== "update" ? { status: "proposed" } : {}) };
      const next: Source = sourceSchema.parse({
        ...source, ...edits,
        ...(reliability ? { reliability: { ...source.reliability, level: reliability, estimated: false } } : {}),
        status, revision: randomUUID(), updatedAt: at,
        history: [...source.history, { at, by: owner, action, note: decision.note || null, changes: Object.keys(changes).length ? changes : null }],
      });
      await write(next);
      return next;
    });
  }

  return { list, get, find, approved, collectable, propose, decide };
}
export type SourceStore = ReturnType<typeof createSourceStore>;
