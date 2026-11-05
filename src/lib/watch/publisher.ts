import { editorialDecision } from "./events";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { AccountStore } from "../accounts/store";
import type { WatchAgent } from "../accounts/types";
import type { PublicationStore } from "../publications/store";
import { migrateWatchCollection, runningAgents } from "./collect";
import { splitSourcesSection } from "../publications/markdown";
import { migrateWatchCandidates, normalizeQuote } from "./evaluate";
import { checkFormat } from "./format";
import { agentFormat } from "./format-store";
import type { JobQueue } from "./jobs";
import { publicationGate, type GateReason } from "./schedule";
import { agentSchedule, localSunday, nextPublishOpening, publishOpen, publishWindow } from "../xiagents/schedule";
import type { SourceStore } from "./sources";
import { tokens } from "./stories";
import { establishedUnderTrust, trustResolver } from "./trust";
import type { Handler } from "./worker";
import { closeItem, MAX_AGE, readyItems, syncEditorialQueue, type QueueItem } from "./queue";
import { DIFFUSION_KIND } from "./orchestrator";
import { arbitrationId as arbitrationIdOf, type ArbitrationService, type Mention } from "../arbiter/arbitration";

/**
 * Autonomous publication: drafted candidates are published by the night window or as immediate
 * alerts, after checks made at the exact moment of publication. Every attempt that reaches a
 * candidate leaves a traceable decision. Off unless the operator flags and the agent's own
 * autonomous mode allow it; public additionally needs its own flag and confirmation.
 *
 * Outside the publish calendar, an alert is a priority publication: it goes out only after a
 * favorable decision of @arbitre on this exact news version (arbiter/arbitration.ts), which is
 * asked only once every check below passes and is checked again under the publication lock. Any
 * other answer, or none in time, sends the news back to the normal circuit (the next window).
 */
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export { MAX_AGE } from "./queue";
/** Weekly review: verified material below the night threshold, only above this importance. */
export const WEEKLY_FLOOR = 0.25;
const SUSTAINED_ERRORS = 3;

/**
 * `diffusion`: `queue` (central diffuser over the common editorial queue, no per-agent slot) or
 * `legacy` (per-agent window jobs at a fixed slot), the rollback path. Exactly one of them publishes:
 * the other one's jobs, if any remain, finish without publishing. The worker reads
 * XI_EDITORIAL_DIFFUSION (default `queue`); left out here, `legacy`.
 */
export type PublishSettings = { autoPublish: boolean; allowPublic: boolean; diffusion?: "queue" | "legacy" };
/** Between two publications of one owner's feed by the diffuser: a natural pace, never a quota. */
export const DIFFUSION_SPACING = 10 * 60_000;
/** Reasonable flexibility: a content ready before its window closed may still go out this long after. */
export const DIFFUSION_GRACE = 30 * 60_000;
/** The operator's flags (worker and web read the same environment). */
export const publishSettingsFromEnv = (env: Record<string, string | undefined> = process.env): Required<PublishSettings> => ({
  autoPublish: env.XI_WATCH_AUTOPUBLISH === "true", allowPublic: env.XI_WATCH_AUTOPUBLISH === "true" && env.XI_WATCH_AUTOPUBLISH_PUBLIC === "true",
  diffusion: env.XI_EDITORIAL_DIFFUSION === "legacy" ? "legacy" : "queue",
});
/** Contents tried per owner and diffusion round, when the best ones fail their checks. */
const DIFFUSION_TRIES = 5;
export type Outcome = "published" | "deferred" | "abandoned" | "skipped" | "selected";

export function migrateWatchDecisions(db: Database.Database) {
  // Publication reads collection state and candidates: their tables exist even before any collection.
  migrateWatchCollection(db);
  migrateWatchCandidates(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS watch_decision (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      owner TEXT NOT NULL,
      story_id TEXT,
      draft_id TEXT,
      lane TEXT,
      outcome TEXT NOT NULL CHECK (outcome IN ('published', 'deferred', 'abandoned', 'skipped', 'selected')),
      reason TEXT NOT NULL,
      visibility TEXT,
      at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS watch_decision_agent ON watch_decision (agent_id, at);
    CREATE INDEX IF NOT EXISTS watch_decision_owner ON watch_decision (owner, at);
  `);
}

/** The publish calendar of an agent, as the gate expects it. */
const windowOf = (agent: WatchAgent, at: number, grace = false) => {
  const next = nextPublishOpening(agent, at);
  return { open: publishOpen(agent, at) || (grace && publishOpen(agent, at - DIFFUSION_GRACE)), next: next === null ? null : new Date(next), sunday: localSunday(agent, at) };
};
const outsideWindow = (agent: WatchAgent | undefined) => agent && agentSchedule(agent).explicit ? "Hors du calendrier de publication." : GATE_REASONS["outside-window"];
const GATE_REASONS: Record<GateReason, string> = {
  "auto-disabled": "Publication automatique désactivée.", inactive: "ΞAgent désactivé.", "invalid-policy": "Configuration de veille illisible.",
  disabled: "Veille désactivée.", paused: "Veille en pause.", "outside-window": "Hors de la fenêtre 3 h–6 h.", "not-weekly-window": "Hors de la fenêtre du dimanche.",
  "recent-publication": "Publication récente : pas de bilan.", interval: "Intervalle minimal entre publications non écoulé.", "daily-cap": "Plafond de publications sur 24 h atteint.",
};

/** Why an agent may not publish automatically at all (null: it may, subject to the gate). */
function agentBlockOf(agent: WatchAgent | undefined, settings: PublishSettings): string | null {
  if (!settings.autoPublish) return "Publication automatique désactivée par l’opérateur (XI_WATCH_AUTOPUBLISH).";
  if (!agent) return "ΞAgent introuvable.";
  if (!agent.active) return GATE_REASONS.inactive;
  if (!agent.watch.valid) return GATE_REASONS["invalid-policy"];
  if (!agent.watch.policy.enabled) return GATE_REASONS.disabled;
  if (agent.watch.policy.paused) return GATE_REASONS.paused;
  if (!agent.watch.policy.autoPublish) return "Mode autonome désactivé pour ce ΞAgent.";
  return null;
}

export type DiffusionWaitCode = "legacy" | "operator" | "agent" | "expired" | "threshold" | "spacing" | GateReason;
export type DiffusionWait = { code: DiffusionWaitCode; reason: string; retryAt: number | null };
/**
 * Why a ready content of the editorial queue is not published now, or null when the diffuser may
 * try it (its publication checks still apply then). The diffuser's own eligibility rule, also read
 * by the supervision: what it shows is what the diffuser applies.
 * `publishedAt`: the agent's real publications; `lastOwnerPublication`: the owner's last one.
 */
export function diffusionWait(item: QueueItem, agent: WatchAgent | undefined, { settings, now, publishedAt, lastOwnerPublication }: { settings: PublishSettings; now: number; publishedAt: readonly Date[]; lastOwnerPublication: number | null }): DiffusionWait | null {
  if (settings.diffusion !== "queue") return { code: "legacy", reason: "Diffusion par créneaux individuels (XI_EDITORIAL_DIFFUSION=legacy).", retryAt: null };
  if (now > item.expiresAt) return { code: "expired", reason: "Actualité obsolète : retirée au prochain passage du diffuseur.", retryAt: null };
  const blocked = agentBlockOf(agent, settings);
  if (blocked || !agent) return { code: settings.autoPublish ? "agent" : "operator", reason: blocked ?? "ΞAgent introuvable.", retryAt: null };
  const policy = agent.watch.policy;
  // Only contents worth publishing: never one picked because a window is open.
  if (!item.weekly && item.importance < policy.nightThreshold) return { code: "threshold", reason: `Importance ${Math.round(item.importance * 100)} % sous le seuil de publication du ΞAgent (${Math.round(policy.nightThreshold * 100)} %) : aucune publication.`, retryAt: null };
  const gate = publicationGate({ lane: "night", now: new Date(now), autoPublish: true, active: agent.active, policyValid: agent.watch.valid, policy, publishedAt, window: windowOf(agent, now, item.lane !== "immediate") });
  if (!gate.allowed) return { code: gate.reason, reason: gate.reason === "outside-window" ? outsideWindow(agent) : GATE_REASONS[gate.reason], retryAt: gate.retryAt?.getTime() ?? null };
  // Alerts are not paced (see `diffuse`).
  if (item.lane !== "immediate" && lastOwnerPublication !== null && now - lastOwnerPublication < DIFFUSION_SPACING) {
    return { code: "spacing", reason: `Espacement du fil : ${DIFFUSION_SPACING / 60_000} min entre deux publications.`, retryAt: lastOwnerPublication + DIFFUSION_SPACING };
  }
  return null;
}

type CandidateRow = { story_id: string; story_version: number; status: string; lane: string | null; topic_id: string | null; importance: number | null; novelty_kind: string | null; reason: string | null; data: string };
type Attempt = { outcome: Outcome; reason: string; retryAt?: number | null };
/** Every check passed (`prepare`): nothing published, the mention @arbitre would receive. */
type Prepared = { outcome: "ready"; reason: string; mention: Mention; draftId: string };

export function createPublisher({ db, accounts, sources, publications, settings, arbitration, now = Date.now }: {
  db: Database.Database; accounts: AccountStore; sources: SourceStore; publications: PublicationStore; settings: PublishSettings;
  /** @arbitre, for alerts outside the publish calendar; without it they always take the normal circuit. */
  arbitration?: ArbitrationService; now?: () => number;
}) {
  migrateWatchDecisions(db);
  const decide = (agent: WatchAgent, entry: { story?: string; draft?: string; lane?: string; outcome: Outcome; reason: string; visibility?: string; id?: string }) => {
    const result = db.prepare("INSERT OR IGNORE INTO watch_decision VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(entry.id ?? `${entry.outcome}:${randomUUID()}`, agent.id, agent.owner, entry.story ?? null, entry.draft ?? null, entry.lane ?? null, entry.outcome, entry.reason, entry.visibility ?? null, now());
    if (result.changes) editorialDecision(entry.outcome, agent.id, entry.story);
    return result;
  };
  const setCandidate = (agentId: string, storyId: string, fields: Record<string, unknown>) => {
    const values = { ...fields, updated_at: now() };
    db.prepare(`UPDATE watch_candidate SET ${Object.keys(values).map(key => `${key} = @${key}`).join(", ")} WHERE agent_id = @agent AND story_id = @story`).run({ ...values, agent: agentId, story: storyId });
  };
  const immediatesSince = (agentId: string, since: number) => (db.prepare("SELECT count(*) AS n FROM watch_decision WHERE agent_id = ? AND outcome = 'published' AND lane = 'immediate' AND at > ?").get(agentId, since) as { n: number }).n;
  /** Agent-level conditions, re-read every time: pauses and switches apply to anything already planned. */
  function agentBlock(agent: WatchAgent | undefined): string | null {
    return agentBlockOf(agent, settings);
  }

  /** The structured mention of @arbitre: the news as it stands, its established claims and sources, why the agent asks. */
  function mention(agent: WatchAgent, row: CandidateRow, data: { title?: string; importance?: { factors?: { label: string; weight: number; value: number }[] } }, story: { first_published_at: string | null }, draft: Awaited<ReturnType<PublicationStore["get"]>>, claims: { status: string }[]): Mention {
    const established = db.prepare<[string, string], { text: string; status: "corroborated" | "primary"; independent_count: number }>("SELECT text, status, independent_count FROM watch_claim WHERE agent_id = ? AND story_id = ? AND status IN ('corroborated', 'primary') ORDER BY position LIMIT 12").all(agent.id, row.story_id);
    let topic: string | null = null;
    try { topic = row.topic_id ? db.prepare<[string], { name: string | null }>("SELECT json_extract(data, '$.name') AS name FROM topic_index WHERE id = ?").get(row.topic_id)?.name ?? null : null; } catch { topic = null; }
    const cut = (text: string, max: number) => text.length > max ? `${text.slice(0, max - 1)}…` : text;
    return {
      to: "@arbitre",
      from: { agentId: agent.id, handle: `@${agent.handle}` },
      story: { id: row.story_id, version: row.story_version, title: cut(data.title ?? draft.summary, 300), firstPublishedAt: story.first_published_at },
      claims: established.map(claim => ({ text: cut(claim.text, 600), status: claim.status, independent: claim.independent_count })),
      sources: draft.sources.slice(0, 20).map(note => ({ publisher: note.publisher ? cut(note.publisher, 200) : null, title: cut(note.title, 300), url: note.url && note.url.length <= 2_000 ? note.url : null, claims: (note.claims ?? []).slice(0, 12).map(claim => cut(claim, 600)) })),
      context: { topic: topic ? cut(topic, 200) : null, summary: cut(draft.summary, 1_000) },
      factors: {
        importance: row.importance ?? 0, alertThreshold: agent.watch.policy.alertThreshold, primary: claims.some(claim => claim.status === "primary"),
        independent: Math.max(0, ...established.map(claim => claim.independent_count)), novelty: row.novelty_kind,
        details: (data.importance?.factors ?? []).slice(0, 8).map(factor => ({ label: cut(factor.label, 120), weight: factor.weight, value: factor.value })),
      },
      justification: cut(row.reason ?? `Importance ${row.importance ?? "?"} ≥ seuil d’alerte ${agent.watch.policy.alertThreshold}, affirmations établies.`, 1_000),
    };
  }

  /** The decision of a publication whose recording was interrupted: stored once (fixed id). */
  function recovered(agent: WatchAgent, storyId: string, draftId: string, lane: string, visibility: string): Attempt {
    decide(agent, { id: `published:${draftId}`, story: storyId, draft: draftId, lane, outcome: "published", reason: "Publication automatique (reprise après interruption).", visibility });
    setCandidate(agent.id, storyId, { status: "published", reason: "Publiée automatiquement." });
    return { outcome: "published", reason: "Déjà publiée." };
  }

  /** One drafted candidate, checked and published now, or a traced reason why not; `prepare`: checks only. */
  async function attempt(agentId: string, storyId: string, lane: "night" | "immediate", options?: { queue?: boolean }): Promise<Attempt>;
  async function attempt(agentId: string, storyId: string, lane: "immediate", options: { prepare: true }): Promise<Attempt | Prepared>;
  /** `queue`: chosen by the central diffuser (its window flexibility applies, except to a pending alert: off-hours, alerts need @arbitre). */
  async function attempt(agentId: string, storyId: string, lane: "night" | "immediate", { prepare = false, queue = false }: { prepare?: boolean; queue?: boolean } = {}): Promise<Attempt | Prepared> {
    const agent = (await accounts.watchAgents()).find(item => item.id === agentId);
    const blocked = agentBlock(agent);
    if (blocked || !agent) return { outcome: "skipped", reason: blocked ?? "ΞAgent introuvable." };
    const policy = agent.watch.policy;
    const row = db.prepare<[string, string], CandidateRow>("SELECT story_id, story_version, status, lane, topic_id, importance, novelty_kind, reason, data FROM watch_candidate WHERE agent_id = ? AND story_id = ?").get(agentId, storyId);
    if (!row || row.status !== "drafted") return { outcome: "skipped", reason: "Aucun brouillon validé pour cette actualité." };
    const data = JSON.parse(row.data) as { draft?: { id: string; revision?: string }; weeklySelected?: boolean; title?: string; importance?: { factors?: { label: string; weight: number; value: number }[] } };
    const draftId = data.draft?.id;
    const trace = (outcome: Outcome, reason: string, extra: Partial<Attempt> = {}) => { decide(agent, { story: storyId, draft: draftId, lane, outcome, reason, visibility: policy.visibility }); return { outcome, reason, ...extra }; };
    const abandon = async (reason: string, candidate: Record<string, unknown> = { status: "rejected", lane: null, reason }) => {
      if (draftId) await publications.retireWatchDraft(agent.owner, agentId, draftId, reason);
      setCandidate(agentId, storyId, candidate);
      return trace("abandoned", reason);
    };
    if (!draftId || !data.draft?.revision) return abandon("Brouillon sans révision validée.");
    const draft = await publications.get({ id: agent.owner }, draftId).catch(() => null);
    if (!draft) return abandon("Brouillon introuvable.");
    // Interrupted after writing: recorded now, without re-running checks that would see the publication itself.
    if (draft.status === "published") return recovered(agent, storyId, draftId, lane, draft.visibility);
    // The agent's current limits, on the draft as it is now: never truncated, held for a new drafting.
    const limits = agentFormat(db, agent);
    const shape = limits.ok ? checkFormat(draft.messages.map(message => splitSourcesSection(message.body).prose), limits.format) : [`Limites de publication incohérentes : ${limits.problems.join(" ")}`];
    if (shape.length) {
      const reason = `Brouillon hors des limites de publication actuelles : ${shape.slice(0, 2).join(" ")}`;
      return abandon(reason, { status: "held", reason });
    }
    if (policy.visibility === "public") {
      if (!agent.watch.publicConfirmedAt) return trace("deferred", "Visibilité publique non confirmée.");
      if (!settings.allowPublic) return trace("deferred", "Publication publique non autorisée par l’opérateur (XI_WATCH_AUTOPUBLISH_PUBLIC).");
    }

    // The news itself: still there, not obsolete, unchanged since the draft.
    const story = db.prepare<[string, string], { item_count: number; first_published_at: string | null; first_seen_at: number }>("SELECT item_count, first_published_at, first_seen_at FROM watch_story WHERE id = ? AND owner = ?").get(storyId, agent.owner);
    if (!story) return abandon("Actualité expirée ou fusionnée depuis la rédaction.");
    const origin = story.first_published_at ? Date.parse(story.first_published_at) : story.first_seen_at;
    const maxAge = data.weeklySelected ? MAX_AGE.weekly : MAX_AGE[lane];
    if (now() - origin > maxAge) return abandon(`Actualité obsolète (plus de ${Math.round(maxAge / HOUR)} h) : non publiée.`);
    if (story.item_count !== row.story_version) return abandon("Nouvelles informations depuis la rédaction : actualité réévaluée.", { status: "accepted", reason: "Réévaluation après de nouvelles informations." });

    // The draft's sources under the current trust of the agent and the retained topic: each quote still
    // in its article, each article carried by a source not denied there.
    const trust = await trustResolver(db, sources, agent.owner);
    for (const note of draft.sources) {
      const item = note.url ? db.prepare<[string, string], { id: string; title: string; summary: string }>("SELECT id, title, summary FROM watch_item WHERE owner = ? AND url = ?").get(agent.owner, note.url) : undefined;
      if (!item) return abandon(`Article source expiré : ${note.publisher ?? note.title}.`);
      const text = normalizeQuote(`${item.title}\n${item.summary}`);
      if ((note.claims ?? []).some(quote => !text.includes(normalizeQuote(quote)))) return abandon(`Citation introuvable dans ${note.publisher ?? note.title} : brouillon non publié.`);
      const carriers = db.prepare<[string], { source_id: string }>("SELECT source_id FROM watch_item_seen WHERE item_id = ?").all(item.id).map(entry => entry.source_id).filter(id => trust.source(id, agentId, row.topic_id) !== "denied");
      // An explicit denial: the draft cites a source that is no evidence any more; the candidate waits for new material.
      if (!carriers.length) { const reason = `Source refusée ou retirée pour ${note.publisher ?? note.title} : brouillon non publié.`; return abandon(reason, { status: "held", lane: null, reason }); }
      const healthy = carriers.some(id => ((db.prepare<[string], { consecutive_errors: number }>("SELECT consecutive_errors FROM watch_source_state WHERE source_id = ?").get(id))?.consecutive_errors ?? 0) < SUSTAINED_ERRORS);
      // Retried at the next window; it does not hold the other candidates of this one.
      if (!healthy) return trace("deferred", `Source indisponible depuis plusieurs collectes : ${note.publisher ?? note.title}.`);
    }
    const claims = db.prepare<[string, string], { status: string; evidence: string }>("SELECT status, evidence FROM watch_claim WHERE agent_id = ? AND story_id = ?").all(agentId, storyId);
    if (!claims.some(claim => claim.status === "corroborated" || claim.status === "primary")) return abandon("Plus aucune affirmation établie.");
    // Trust lowered since the evaluation (approval withdrawn, pending sources only): retried at the next window, never published meanwhile.
    if (!establishedUnderTrust(db, trust, { agentId, topicId: row.topic_id, claims })) return trace("deferred", "Source plus approuvée : aucune affirmation n’est plus établie par une source approuvée dans ce périmètre.");

    // No equivalent recent publication; no second alert on one event without a real development.
    if (db.prepare("SELECT 1 FROM watch_decision WHERE agent_id = ? AND story_id = ? AND outcome = 'published' AND at > ?").get(agentId, storyId, now() - 7 * DAY)) return abandon("Actualité déjà publiée cette semaine.");
    await publications.ensureIndexed();
    const own = new Set(tokens(`${draft.summary} ${draft.messages.map(message => message.body.split("## Sources")[0]).join(" ")}`));
    const equivalent = publications.agentPublications(agentId).filter(p => !p.test && p.id !== draftId && now() - p.publishedAt.getTime() < 3 * DAY).find(p => {
      const theirs = new Set(tokens(p.excerpt));
      let shared = 0;
      for (const token of theirs) if (own.has(token)) shared++;
      return theirs.size >= 5 && shared / Math.min(own.size, theirs.size) >= 0.6;
    });
    if (equivalent) return abandon("Publication équivalente récente : non republiée.");
    if (lane === "immediate") {
      if (policy.maxImmediatePerDay === 0 || immediatesSince(agentId, now() - DAY) >= policy.maxImmediatePerDay) return trace("deferred", "Plafond d’alertes immédiates atteint : fenêtre nocturne.");
    }
    if (prepare) return { outcome: "ready", reason: "Contrôles de publication réussis.", draftId, mention: mention(agent, row, data, story, draft, claims) };

    // Under the cross-process lock: configuration and ceilings re-read at the exact moment.
    let retryAt: number | null = null;
    const offHours = lane === "immediate" && !publishOpen(agent, now());
    const result = await publications.publishWatchDraft(agent.owner, agentId, draftId, {
      visibility: policy.visibility, revision: data.draft.revision,
      details: { lane, story: storyId, importance: row.importance, decided_by: "watch-auto", ...(queue ? { diffusion: "queue" } : {}), ...(offHours && arbitration ? { arbitration: arbitrationIdOf(agentId, storyId, row.story_version) } : {}) },
      guard: async () => {
        const fresh = (await accounts.watchAgents()).find(item => item.id === agentId);
        const block = agentBlock(fresh);
        if (block || !fresh) return block ?? "ΞAgent introuvable.";
        if (fresh.watch.policy.visibility !== policy.visibility) return "Visibilité modifiée pendant la publication : reportée.";
        const gate = publicationGate({ lane: lane === "immediate" ? "immediate" : "night", now: new Date(now()), autoPublish: true, active: fresh.active, policyValid: fresh.watch.valid, policy: fresh.watch.policy, publishedAt: publications.agentPublications(agentId).filter(p => !p.test).map(p => p.publishedAt), window: windowOf(fresh, now(), queue && row.lane !== "immediate") });
        if (!gate.allowed) { retryAt = gate.retryAt?.getTime() ?? null; return gate.reason === "outside-window" ? outsideWindow(fresh) : GATE_REASONS[gate.reason]; }
        // Outside the publish calendar, only an allowed major event may go out.
        if (lane === "immediate" && !publishOpen(fresh, now()) && !agentSchedule(fresh).majorEvents.enabled) return "Hors du calendrier de publication et exception pour événement majeur désactivée.";
        if (lane === "immediate" && immediatesSince(agentId, now() - DAY) >= fresh.watch.policy.maxImmediatePerDay) return "Plafond d’alertes immédiates atteint : fenêtre nocturne.";
        // A priority publication needs @arbitre's favorable decision on this very version.
        if (lane === "immediate" && !publishOpen(fresh, now()) && !arbitration?.favorable(agentId, storyId, row.story_version)) return "Hors du calendrier de publication sans décision favorable de @arbitre : circuit normal.";
        return null;
      },
      record: () => db.transaction(() => {
        decide(agent, { id: `published:${draftId}`, story: storyId, draft: draftId, lane, outcome: "published", reason: `Publication ${policy.visibility === "public" ? "publique" : "privée"} automatique (${lane === "immediate" ? "alerte majeure" : queue ? `queue éditoriale${data.weeklySelected ? ", bilan hebdomadaire" : ""}` : data.weeklySelected ? "bilan hebdomadaire" : "fenêtre nocturne"}).${offHours ? ` Hors calendrier de publication : publication prioritaire accordée par @arbitre (importance ${row.importance ?? "?"} ≥ seuil d’alerte ${policy.alertThreshold}, affirmations établies par plusieurs voix ou une source primaire).` : ""}`, visibility: policy.visibility });
        setCandidate(agentId, storyId, { status: "published", reason: "Publiée automatiquement." });
      })(),
    });
    if (result.outcome === "published") return { outcome: "published", reason: "Publiée." };
    if (result.outcome === "already") return recovered(agent, storyId, draftId, lane, result.snapshot.visibility);
    const reason = "reason" in result ? result.reason : "";
    if (result.outcome === "blocked") return trace("deferred", reason, { retryAt });
    if (result.outcome === "modified") { setCandidate(agentId, storyId, { status: "held", reason }); return trace("skipped", reason); }
    setCandidate(agentId, storyId, { status: "rejected", lane: null, reason });
    return trace(result.outcome === "unavailable" ? "skipped" : "abandoned", reason);
  }

  /** Night window: drafted candidates by importance, as long as ceilings allow; the job waits for the interval inside the window. */
  const night: Handler = async job => {
    // Replaced by the central diffuser: a window job left from before never publishes beside it.
    if (settings.diffusion === "queue") return { status: "done", result: { outcome: "skipped", reason: "Créneau individuel remplacé par la queue éditoriale." } };
    const { agentId } = job.payload as { agentId: string };
    const agent = (await accounts.watchAgents()).find(item => item.id === agentId);
    const blocked = agentBlock(agent);
    if (blocked) return { status: "done", result: { outcome: "skipped", reason: blocked } };
    if (!publishOpen(agent!, now())) return { status: "done", result: { outcome: "skipped", reason: outsideWindow(agent) } };
    const rows = db.prepare<[string], { story_id: string }>("SELECT story_id FROM watch_candidate WHERE agent_id = ? AND status = 'drafted' AND lane IN ('night', 'immediate') ORDER BY importance DESC, updated_at").all(agentId);
    if (!rows.length) return { status: "done", result: { outcome: "no-candidates" } };
    let published = 0;
    for (const row of rows) {
      const result = await attempt(agentId, row.story_id, "night");
      if (result.outcome === "published") published++;
      if (result.outcome === "deferred" && result.retryAt) {
        if (result.retryAt < (publishWindow(agent!, now())?.end ?? 0)) return { status: "wait", until: new Date(result.retryAt), reason: result.reason };
        break;
      }
    }
    return { status: "done", result: { outcome: published ? "published" : "nothing-published", published } };
  };

  /** Back to the normal circuit: the next publish window, the news and its draft kept. */
  const toNormalCircuit = (agent: WatchAgent, storyId: string, reason: string) => {
    setCandidate(agent.id, storyId, { lane: "night", reason: `Alerte différée : ${reason}` });
    decide(agent, { story: storyId, lane: "immediate", outcome: "deferred", reason, visibility: agent.watch.policy.visibility });
    return { status: "done" as const, result: { outcome: "deferred", reason } };
  };

  /**
   * Immediate alert. Inside the publish calendar it is an ordinary publication; outside it, a priority
   * one: checked, then submitted to @arbitre, then published only after a favorable decision (and every
   * check again). The job waits for the decision (woken by it) until the arbitration deadline.
   */
  const alert: Handler = async job => {
    const { agentId, storyId, storyVersion } = job.payload as { agentId: string; storyId: string; storyVersion?: number };
    const agent = (await accounts.watchAgents()).find(item => item.id === agentId);
    // Without the major-event exception, an alert only goes out inside the publish calendar.
    if (agent && !publishOpen(agent, now()) && !agentSchedule(agent).majorEvents.enabled) {
      return toNormalCircuit(agent, storyId, "Hors du calendrier de publication et exception pour événement majeur désactivée : différée au calendrier.");
    }
    // Inside the calendar, the central diffuser publishes it (first among its owner's contents).
    if (settings.diffusion === "queue" && agent && publishOpen(agent, now())) {
      // A diffusion waiting for its pace runs now: alerts are not paced (see `diffuse`).
      db.prepare("UPDATE watch_job SET run_after = ?, updated_at = ? WHERE kind = ? AND state = 'pending' AND run_after > ?").run(now(), now(), DIFFUSION_KIND, now());
      return { status: "done", result: { outcome: "queued", reason: "Dans le calendrier de publication : diffusée par la queue éditoriale." } };
    }
    let arbitrated: string | null = null;
    if (agent && !publishOpen(agent, now()) && !agentBlock(agent)) {
      const row = db.prepare<[string, string], { status: string; lane: string | null; story_version: number }>("SELECT status, lane, story_version FROM watch_candidate WHERE agent_id = ? AND story_id = ?").get(agentId, storyId);
      // This alert's version only (older jobs carry none): a newer version has its own alert and request.
      const version = storyVersion ?? row?.story_version;
      if (!row || row.status !== "drafted" || row.lane !== "immediate" || version !== row.story_version) {
        if (arbitration && version !== undefined) arbitration.close(arbitrationIdOf(agentId, storyId, version), "obsolete", "Candidat modifié, publié ou réévalué depuis la demande.");
        return { status: "done", result: { outcome: "skipped", reason: "Alerte périmée : le candidat a changé depuis." } };
      }
      let request = arbitration?.get(arbitrationIdOf(agentId, storyId, row.story_version)) ?? null;
      if (!request) {
        const prepared = await attempt(agentId, storyId, "immediate", { prepare: true });
        if (prepared.outcome !== "ready") {
          if (prepared.outcome === "deferred") setCandidate(agentId, storyId, { lane: "night", reason: `Alerte différée : ${prepared.reason}` });
          return { status: "done", result: { outcome: prepared.outcome, reason: prepared.reason } };
        }
        if (!arbitration) return toNormalCircuit(agent, storyId, "@arbitre indisponible dans ce processus : circuit normal.");
        try {
          request = await arbitration.solicit({ agent, mention: prepared.mention, draftId: prepared.draftId, follower: job.key });
        } catch (error) {
          // A mention @arbitre cannot read (no source note, out of bounds) is never a reason to hold the news.
          if (!(error instanceof z.ZodError)) throw error;
          return toNormalCircuit(agent, storyId, "Demande d’arbitrage incomplète (sources ou affirmations manquantes) : circuit normal.");
        }
      }
      const verdict = await arbitration!.verdict(request);
      if (verdict.kind === "wait") return { status: "wait", until: new Date(verdict.until), reason: verdict.reason, ready: verdict.ready };
      if (verdict.kind === "normal") {
        const reason = `${verdict.reason} Circuit normal.`;
        arbitration!.settle(verdict.request.id, { result: "normal", reason });
        return toNormalCircuit(agent, storyId, reason);
      }
      arbitrated = verdict.request.id;
    }
    const result = await attempt(agentId, storyId, "immediate");
    if (result.outcome === "deferred") setCandidate(agentId, storyId, { lane: "night", reason: `Alerte différée : ${result.reason}` });
    if (arbitrated) arbitration!.settle(arbitrated, { result: result.outcome === "published" ? "published" : result.outcome === "deferred" ? "normal" : result.outcome === "abandoned" ? "abandoned" : "skipped", reason: result.reason });
    return { status: "done", result: { outcome: result.outcome, reason: result.reason } };
  };

  /** An obsolete content leaves the queue: its draft retired, its candidate closed, the reason traced. */
  async function expire(item: QueueItem, agent: WatchAgent | undefined) {
    const reason = `Actualité obsolète (plus de ${Math.round((item.expiresAt - item.originAt) / HOUR)} h) : retirée de la queue éditoriale.`;
    if (!closeItem(db, item.draftId, "expired", reason, now())) return;
    await publications.retireWatchDraft(item.owner, item.agentId, item.draftId, reason).catch(() => undefined);
    db.prepare("UPDATE watch_candidate SET status = 'rejected', lane = NULL, reason = ?, updated_at = ? WHERE agent_id = ? AND story_id = ? AND status = 'drafted' AND json_extract(data, '$.draft.id') = ?").run(reason, now(), item.agentId, item.storyId, item.draftId);
    if (agent) decide(agent, { story: item.storyId, draft: item.draftId, lane: item.lane, outcome: "abandoned", reason, visibility: agent.watch.policy.visibility });
  }

  /**
   * Central diffuser over the common editorial queue (one at a time across processes: drainLimits).
   * Each round, per owner: obsolete contents leave; among the ready ones whose agent may publish now
   * (its publish window, with DIFFUSION_GRACE; its own ceilings and interval as safety limits), the
   * best by importance, relevance and freshness is tried, an agent that just published passing after
   * the others; one publication per owner, then DIFFUSION_SPACING before the next. Nothing worth
   * publishing, nothing published: there is no slot to fill.
   *
   * Alerts (immediate lane) form a separate circuit: never paced by DIFFUSION_SPACING and tried
   * first, but only inside the real window (no grace: off-hours, they go through @arbitre in
   * `alert`, whose favorable decision publishes directly, never through this pace). Both circuits
   * end in `publishWatchDraft`, whose guard publishes a draft once.
   */
  const diffuse: Handler = async () => {
    if (settings.diffusion !== "queue") return { status: "done", result: { outcome: "skipped", reason: "Diffusion par créneaux individuels (XI_EDITORIAL_DIFFUSION=legacy)." } };
    syncEditorialQueue(db, now());
    const agents = new Map((await accounts.watchAgents()).map(agent => [agent.id, agent]));
    for (const item of readyItems(db)) if (now() > item.expiresAt) await expire(item, agents.get(item.agentId));
    const ready = readyItems(db);
    if (!ready.length) return { status: "done", result: { outcome: "no-ready" } };
    if (!settings.autoPublish) return { status: "done", result: { outcome: "skipped", reason: "Publication automatique désactivée par l’opérateur (XI_WATCH_AUTOPUBLISH) : les contenus attendent dans la queue." } };
    await publications.ensureIndexed();
    // Interrupted publications (written, not recorded) are recorded first, whatever the limits: they
    // already went out, and the pace below must count them.
    for (const item of ready) {
      if (publications.agentPublications(item.agentId).some(p => p.id === item.draftId)) await attempt(item.agentId, item.storyId, "night", { queue: true });
    }
    syncEditorialQueue(db, now());
    const published: string[] = [];
    // Why the others wait, by known reason (the job's result; the supervision shows them per content).
    const waiting: Partial<Record<DiffusionWaitCode, number>> = {};
    let resume: number | null = null;
    for (const owner of new Set(readyItems(db).map(item => item.owner))) {
      const last = db.prepare<[string], { agent_id: string; at: number }>("SELECT agent_id, at FROM watch_decision WHERE owner = ? AND outcome = 'published' ORDER BY at DESC LIMIT 1").get(owner);
      const paced = !!last && now() - last.at < DIFFUSION_SPACING;
      if (paced) resume = Math.min(resume ?? Infinity, last.at + DIFFUSION_SPACING);
      const eligible = readyItems(db).filter(item => item.owner === owner).flatMap(item => {
        const agent = agents.get(item.agentId);
        const times = agent ? publications.agentPublications(agent.id).filter(p => !p.test).map(p => p.publishedAt) : [];
        const wait = diffusionWait(item, agent, { settings, now: now(), publishedAt: times, lastOwnerPublication: last?.at ?? null });
        if (wait || !agent) { if (wait) waiting[wait.code] = (waiting[wait.code] ?? 0) + 1; return []; }
        const recent = times.filter(time => now() - time.getTime() < DAY).length;
        const freshness = 1 - Math.min(1, Math.max(0, (now() - item.originAt) / (item.expiresAt - item.originAt)));
        const score = 0.45 * item.importance + 0.2 * item.relevance + 0.25 * freshness + (item.lane === "immediate" ? 0.1 : 0) - 0.1 * recent;
        return [{ item, score, again: last?.agent_id === agent.id }];
      });
      // Alerts first, then diversity (the agent that published last waits for the others), then value.
      const alert = (entry: { item: QueueItem }) => Number(entry.item.lane === "immediate");
      eligible.sort((a, b) => alert(b) - alert(a) || Number(a.again) - Number(b.again) || b.score - a.score || a.item.readyAt - b.item.readyAt);
      for (const { item } of eligible.slice(0, DIFFUSION_TRIES)) {
        const result = await attempt(item.agentId, item.storyId, "night", { queue: true });
        syncEditorialQueue(db, now());
        if (result.outcome === "published") { published.push(item.draftId); resume = Math.min(resume ?? Infinity, now() + DIFFUSION_SPACING); break; }
      }
    }
    // More may follow at a natural pace, within this pass if it lasts, else at the next one.
    if (resume !== null && readyItems(db).length) return { status: "wait", until: new Date(resume), reason: `Queue éditoriale : prochaine diffusion au plus tôt à ${new Date(resume).toISOString()} (en attente : ${Object.entries(waiting).map(([code, n]) => `${code} ${n}`).join(", ") || "aucune"}).` };
    return { status: "done", result: { outcome: published.length ? "published" : "nothing-published", published: published.length, waiting } };
  };

  /**
   * Weekly review (Sunday window, nothing really published for seven days): the most important
   * verified items below the night threshold are selected, each as its own post on its own topic,
   * to be drafted and then published by the next windows. No material, no review.
   */
  const weekly: Handler = async job => {
    const { agentId } = job.payload as { agentId: string };
    const agent = (await accounts.watchAgents()).find(item => item.id === agentId);
    if (!agent || !runningAgents([agent]).length) return { status: "done", result: { outcome: "skipped", reason: "not-running" } };
    if (agent.watch.policy.weeklyReview === false) return { status: "done", result: { outcome: "skipped", reason: "Bilan hebdomadaire désactivé pour ce ΞAgent." } };
    if (!localSunday(agent, now()) || !publishOpen(agent, now())) return { status: "done", result: { outcome: "skipped", reason: GATE_REASONS["not-weekly-window"] } };
    await publications.ensureIndexed();
    if (publications.agentPublications(agentId).some(p => !p.test && now() - p.publishedAt.getTime() < 7 * DAY)) return { status: "done", result: { outcome: "skipped", reason: GATE_REASONS["recent-publication"] } };
    const rows = db.prepare<[string, number, number, number], { story_id: string; importance: number }>(`SELECT story_id, importance FROM watch_candidate WHERE agent_id = ? AND status = 'accepted' AND lane = 'weekly'
      AND updated_at >= ? AND importance >= ? ORDER BY importance DESC LIMIT ?`).all(agentId, now() - 7 * DAY, WEEKLY_FLOOR, agent.watch.policy.maxPerDay);
    if (!rows.length) {
      decide(agent, { outcome: "skipped", lane: "weekly", reason: "Bilan hebdomadaire non produit : aucune information vérifiée de valeur suffisante." });
      return { status: "done", result: { outcome: "no-material" } };
    }
    for (const row of rows) {
      db.prepare("UPDATE watch_candidate SET lane = 'night', data = json_set(data, '$.weeklySelected', json('true')), reason = ?, updated_at = ? WHERE agent_id = ? AND story_id = ?")
        .run("Retenue pour le bilan hebdomadaire (publication distincte, un seul sujet).", now(), agentId, row.story_id);
      decide(agent, { story: row.story_id, lane: "weekly", outcome: "selected", reason: `Retenue pour le bilan hebdomadaire (importance ${row.importance}).` });
    }
    return { status: "done", result: { outcome: "selected", selected: rows.length } };
  };

  return { attempt, handlers: { "publication-window": night, "publish-alert": alert, "weekly-review": weekly, [DIFFUSION_KIND]: diffuse } };
}

/** Alert jobs for drafted immediate candidates (once per candidate version), most important first. */
export function planAlerts(db: Database.Database, queue: JobQueue, agents: WatchAgent[], now: number) {
  migrateWatchCandidates(db);
  let planned = 0;
  for (const agent of runningAgents(agents)) {
    for (const row of db.prepare<[string], { story_id: string; story_version: number }>("SELECT story_id, story_version FROM watch_candidate WHERE agent_id = ? AND status = 'drafted' AND lane = 'immediate' ORDER BY importance DESC, updated_at").all(agent.id)) {
      if (queue.enqueue({ kind: "publish-alert", key: `publish-alert:${agent.id}:${row.story_id}:${row.story_version}`, payload: { agentId: agent.id, storyId: row.story_id, storyVersion: row.story_version }, runAfter: now, maxAttempts: 3 }).created) planned++;
    }
  }
  return planned;
}

/** Decisions older than 90 days are removed. */
export function purgeDecisions(db: Database.Database, now: number) {
  migrateWatchDecisions(db);
  return db.prepare("DELETE FROM watch_decision WHERE at < ?").run(now - 90 * DAY).changes;
}
