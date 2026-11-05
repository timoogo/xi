import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { WatchAgent } from "../accounts/types";
import { enqueueSystemTask, systemTaskKey } from "../system-agents/queue";
import type { SystemAgentStore } from "../system-agents/store";
import { TopicError } from "../topics/types";
import { createJobQueue } from "../watch/jobs";

/**
 * Arbitration of priority publications by the system ΞAgent @arbitre (kind `priority-arbiter`).
 *
 * An editorial ΞAgent about to publish a major event outside its publish calendar mentions @arbitre:
 * a structured, internal mention (never a feed post) carrying the news, its established claims, its
 * sources, its importance factors and the agent's justification. The request is durable and unique
 * per (agent, news, version); @arbitre answers one question only, on a system task (decide.ts).
 *
 * The decision never publishes anything: a favorable one only lets the editorial alert make its
 * attempt, where every publication check runs again (publisher.ts). Any other outcome (refusal,
 * arbiter disabled or unavailable, deadline passed, news obsolete) returns the news to the normal
 * circuit with its reason; the request and its decision stay as an audit trail.
 */
export const ARBITER_KIND = "priority-arbiter";
/** Past this delay without a decision, the news goes back to the normal circuit: never held by the arbiter. */
export const ARBITRATION_TIMEOUT = 15 * 60_000;
/**
 * A decision wakes the waiting alert at once (atomically with its wait: no lost wake-up). This slow
 * fallback only notices what wakes nobody: the arbiter's task failing, or the arbiter disabled.
 */
const FALLBACK = 5 * 60_000;

export const mentionSchema = z.object({
  to: z.literal("@arbitre"),
  from: z.object({ agentId: z.string(), handle: z.string().max(80) }).strict(),
  story: z.object({ id: z.string(), version: z.number().int(), title: z.string().max(300), firstPublishedAt: z.string().nullable() }).strict(),
  claims: z.array(z.object({ text: z.string().max(600), status: z.enum(["corroborated", "primary"]), independent: z.number().int().min(0) }).strict()).min(1).max(12),
  sources: z.array(z.object({ publisher: z.string().max(200).nullable(), title: z.string().max(300), url: z.string().max(2_000).nullable(), claims: z.array(z.string().max(600)).max(12) }).strict()).min(1).max(20),
  context: z.object({ topic: z.string().max(200).nullable(), summary: z.string().max(1_000) }).strict(),
  factors: z.object({
    importance: z.number().min(0).max(1), alertThreshold: z.number().min(0).max(1), independent: z.number().int().min(0), primary: z.boolean(), novelty: z.string().max(40).nullable(),
    details: z.array(z.object({ label: z.string().max(120), weight: z.number(), value: z.number() }).strict()).max(8),
  }).strict(),
  justification: z.string().max(1_000),
}).strict();
export type Mention = z.infer<typeof mentionSchema>;

/** What @arbitre decides, as stored: the model's answer plus its provenance. */
export type ArbiterDecision = { priority: boolean; justification: string; criteria: string[]; model: string; promptVersion: string; decidedAt: string };
export type ArbitrationStatus = "pending" | "favorable" | "refused" | "unavailable" | "disabled" | "expired" | "obsolete";
/** What then happened to the news, on the editorial side. */
export type ArbitrationOutcome = { result: "published" | "normal" | "abandoned" | "skipped"; reason: string; at: string };
export type Arbitration = {
  id: string; owner: string; agentId: string; storyId: string; storyVersion: number; draftId: string | null; title: string;
  mention: Mention; status: ArbitrationStatus; reason: string | null; decision: ArbiterDecision | null; outcome: ArbitrationOutcome | null;
  deadline: number; createdAt: number; updatedAt: number;
};

export function migrateArbitrations(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS arbiter_request (
      id TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      story_id TEXT NOT NULL,
      story_version INTEGER NOT NULL,
      draft_id TEXT,
      title TEXT NOT NULL,
      mention TEXT NOT NULL,
      follower TEXT,
      status TEXT NOT NULL CHECK (status IN ('pending', 'favorable', 'refused', 'unavailable', 'disabled', 'expired', 'obsolete')),
      reason TEXT,
      decision TEXT,
      outcome TEXT,
      deadline INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (agent_id, story_id, story_version)
    );
    CREATE INDEX IF NOT EXISTS arbiter_request_owner ON arbiter_request (owner, created_at);
  `);
}

/** One request per (agent, news, version): the same mention again is the same request. */
export function arbitrationId(agentId: string, storyId: string, version: number) {
  const h = createHash("sha256").update(JSON.stringify(["arbitration", agentId, storyId, version])).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

type Row = { id: string; owner: string; agent_id: string; story_id: string; story_version: number; draft_id: string | null; title: string; mention: string; follower: string | null; status: ArbitrationStatus; reason: string | null; decision: string | null; outcome: string | null; deadline: number; created_at: number; updated_at: number };
const toArbitration = (row: Row): Arbitration => ({
  id: row.id, owner: row.owner, agentId: row.agent_id, storyId: row.story_id, storyVersion: row.story_version, draftId: row.draft_id, title: row.title,
  mention: JSON.parse(row.mention) as Mention, status: row.status, reason: row.reason, decision: row.decision ? JSON.parse(row.decision) as ArbiterDecision : null,
  outcome: row.outcome ? JSON.parse(row.outcome) as ArbitrationOutcome : null, deadline: row.deadline, createdAt: row.created_at, updatedAt: row.updated_at,
});

/** Durable requests and decisions. Every transition out of `pending` happens once (first writer wins). */
export function createArbitrationStore(db: Database.Database, now: () => number = Date.now) {
  migrateArbitrations(db);
  const queue = createJobQueue(db, now);
  const get = (id: string) => { const row = db.prepare<[string], Row>("SELECT * FROM arbiter_request WHERE id = ?").get(id); return row ? toArbitration(row) : null; };
  /** The requester's own request only. */
  const own = (owner: string, id: string) => { const found = get(id); return found && found.owner === owner ? found : null; };
  const list = (owner: string, limit = 50) => db.prepare<[string, number], Row>("SELECT * FROM arbiter_request WHERE owner = ? ORDER BY created_at DESC, rowid DESC LIMIT ?").all(owner, Math.min(limit, 200)).map(toArbitration);
  /** The editorial job waiting for this request resumes at once. */
  const wake = (id: string) => {
    const follower = db.prepare<[string], { follower: string | null }>("SELECT follower FROM arbiter_request WHERE id = ?").get(id)?.follower;
    if (follower) db.prepare("UPDATE watch_job SET run_after = ?, updated_at = ? WHERE key = ? AND state = 'pending'").run(now(), now(), follower);
  };
  /** Leaves `pending` with a reason (no decision): unavailable, disabled, expired or obsolete. */
  function close(id: string, status: Exclude<ArbitrationStatus, "pending" | "favorable" | "refused">, reason: string) {
    const changed = db.prepare("UPDATE arbiter_request SET status = ?, reason = ?, updated_at = ? WHERE id = ? AND status = 'pending'").run(status, reason.slice(0, 1_000), now(), id).changes === 1;
    if (changed) wake(id);
    return changed;
  }
  /** @arbitre's decision, recorded once. */
  function decide(id: string, decision: ArbiterDecision) {
    const changed = db.prepare("UPDATE arbiter_request SET status = ?, reason = NULL, decision = ?, updated_at = ? WHERE id = ? AND status = 'pending'")
      .run(decision.priority ? "favorable" : "refused", JSON.stringify(decision), now(), id).changes === 1;
    if (changed) wake(id);
    return changed;
  }
  /** What the editorial side did with the request, recorded once. */
  const settle = (id: string, outcome: Omit<ArbitrationOutcome, "at">) =>
    db.prepare("UPDATE arbiter_request SET outcome = ?, updated_at = ? WHERE id = ? AND outcome IS NULL").run(JSON.stringify({ ...outcome, reason: outcome.reason.slice(0, 1_000), at: new Date(now()).toISOString() }), now(), id).changes === 1;
  /** Whether this exact version of the news has a favorable decision (checked again under the publication lock). */
  const favorable = (agentId: string, storyId: string, version: number) => get(arbitrationId(agentId, storyId, version))?.status === "favorable";
  /** The arbiter's task for a request: its state and last message (null once purged). */
  const task = (request: Arbitration) => queue.get(systemTaskKey(ARBITER_KIND, request.owner, request.id));
  return { get, own, list, close, decide, settle, favorable, task, queue };
}
export type ArbitrationStore = ReturnType<typeof createArbitrationStore>;

/** Where an off-hours alert stands: publish now (favorable), wait for the decision, or the normal circuit. */
export type Verdict = { kind: "favorable"; request: Arbitration } | { kind: "wait"; until: number; reason: string; ready: () => boolean } | { kind: "normal"; request: Arbitration; reason: string };

const STATUS_REASONS: Record<Exclude<ArbitrationStatus, "pending" | "favorable">, string> = {
  refused: "Publication prioritaire refusée par @arbitre", unavailable: "@arbitre indisponible", disabled: "@arbitre désactivé",
  expired: "Délai d’arbitrage dépassé", obsolete: "Actualité devenue obsolète avant la décision",
};

/**
 * The editorial pipeline's side: mention @arbitre for a news version, then read where it stands.
 * `systemAgents`: the registry's store (an arbiter disabled or unreadable is never waited for).
 */
export function createArbitration({ db, systemAgents, now = Date.now }: { db: Database.Database; systemAgents: SystemAgentStore; now?: () => number }) {
  const store = createArbitrationStore(db, now);

  /** Records the mention and queues @arbitre's task; idempotent per (agent, news, version). */
  async function solicit({ agent, mention, draftId, follower }: { agent: WatchAgent; mention: Mention; draftId: string; follower: string }) {
    const data = mentionSchema.parse(mention);
    const id = arbitrationId(agent.id, data.story.id, data.story.version);
    const existing = store.get(id);
    if (existing) return existing;
    let arbiter: Awaited<ReturnType<SystemAgentStore["get"]>> | null = null;
    let problem: string | null = null;
    try { arbiter = await systemAgents.get(ARBITER_KIND); } catch (error) { problem = error instanceof TopicError ? error.message : "Registre des agents systèmes illisible."; }
    const status: ArbitrationStatus = !arbiter ? "unavailable" : arbiter.enabled ? "pending" : "disabled";
    const reason = !arbiter ? problem : arbiter.enabled ? null : "Agent système désactivé par l’administrateur de l’instance.";
    db.transaction(() => {
      const inserted = db.prepare("INSERT OR IGNORE INTO arbiter_request (id, owner, agent_id, story_id, story_version, draft_id, title, mention, follower, status, reason, decision, outcome, deadline, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)")
        .run(id, agent.owner, agent.id, data.story.id, data.story.version, draftId, data.story.title, JSON.stringify(data), follower, status, reason, now() + ARBITRATION_TIMEOUT, now(), now()).changes === 1;
      // Another process may have mentioned it first: its task is the only one (same key anyway).
      if (inserted && status === "pending") enqueueSystemTask(store.queue, { agentId: arbiter!.id, kind: ARBITER_KIND, task: "decide", owner: agent.owner, requestId: id, input: { requestId: id }, trigger: "major-event" });
    })();
    return store.get(id)!;
  }

  /** Where the request stands for the waiting alert; closes it when the arbiter cannot answer in time. */
  async function verdict(request: Arbitration): Promise<Verdict> {
    let current = request;
    if (current.status === "pending") {
      const job = store.task(current);
      const enabled = await systemAgents.get(ARBITER_KIND).then(agent => agent.enabled, () => false);
      if (!enabled) store.close(current.id, "disabled", "Agent système désactivé ou illisible pendant l’arbitrage.");
      else if (!job || job.state === "failed") store.close(current.id, "unavailable", job?.lastError ?? "Tâche d’arbitrage introuvable.");
      else if (now() >= current.deadline) store.close(current.id, "expired", `Aucune décision en ${Math.round(ARBITRATION_TIMEOUT / 60_000)} min${job.lastError ? ` (${job.lastError})` : ""}.`);
      current = store.get(current.id)!;
      const id = current.id;
      if (current.status === "pending") return { kind: "wait", until: Math.min(current.deadline, now() + FALLBACK), reason: "En attente de la décision de @arbitre.", ready: () => store.get(id)?.status !== "pending" };
    }
    if (current.status === "favorable") return { kind: "favorable", request: current };
    const label = STATUS_REASONS[current.status as keyof typeof STATUS_REASONS];
    const detail = current.status === "refused" ? current.decision?.justification : current.reason;
    return { kind: "normal", request: current, reason: `${label}${detail ? ` : ${detail}` : "."}` };
  }

  return { ...store, solicit, verdict };
}
export type ArbitrationService = ReturnType<typeof createArbitration>;
