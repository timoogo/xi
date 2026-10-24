import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { AccountStore } from "../accounts/store";
import type { WatchAgent } from "../accounts/types";
import type { PublicationStore } from "../publications/store";
import { migrateWatchCollection, runningAgents } from "./collect";
import { migrateWatchCandidates, normalizeQuote } from "./evaluate";
import type { JobQueue } from "./jobs";
import { publicationGate, type GateReason } from "./schedule";
import { agentSchedule, localSunday, nextPublishOpening, publishOpen, publishWindow } from "../xiagents/schedule";
import type { SourceStore } from "./sources";
import { tokens } from "./stories";
import type { Handler } from "./worker";

/**
 * Autonomous publication: drafted candidates are published by the night window or as immediate
 * alerts, after checks made at the exact moment of publication. Every attempt that reaches a
 * candidate leaves a traceable decision. Off unless the operator flags and the agent's own
 * autonomous mode allow it; public additionally needs its own flag and confirmation.
 */
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** A news item is not published after this age (from its first publication by a source). */
export const MAX_AGE = { immediate: 6 * HOUR, night: 36 * HOUR, weekly: 8 * DAY };
/** Weekly review: verified material below the night threshold, only above this importance. */
export const WEEKLY_FLOOR = 0.25;
const SUSTAINED_ERRORS = 3;

export type PublishSettings = { autoPublish: boolean; allowPublic: boolean };
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
  `);
}

/** The publish calendar of an agent, as the gate expects it. */
const windowOf = (agent: WatchAgent, at: number) => {
  const next = nextPublishOpening(agent, at);
  return { open: publishOpen(agent, at), next: next === null ? null : new Date(next), sunday: localSunday(agent, at) };
};
const outsideWindow = (agent: WatchAgent | undefined) => agent && agentSchedule(agent).explicit ? "Hors du calendrier de publication." : GATE_REASONS["outside-window"];
const GATE_REASONS: Record<GateReason, string> = {
  "auto-disabled": "Publication automatique désactivée.", inactive: "ΞAgent désactivé.", "invalid-policy": "Configuration de veille illisible.",
  disabled: "Veille désactivée.", paused: "Veille en pause.", "outside-window": "Hors de la fenêtre 3 h–6 h.", "not-weekly-window": "Hors de la fenêtre du dimanche.",
  "recent-publication": "Publication récente : pas de bilan.", interval: "Intervalle minimal entre publications non écoulé.", "daily-cap": "Plafond de publications sur 24 h atteint.",
};

type CandidateRow = { story_id: string; story_version: number; status: string; lane: string | null; importance: number | null; novelty_kind: string | null; data: string };
type Attempt = { outcome: Outcome; reason: string; retryAt?: number | null };

export function createPublisher({ db, accounts, sources, publications, settings, now = Date.now }: {
  db: Database.Database; accounts: AccountStore; sources: SourceStore; publications: PublicationStore; settings: PublishSettings; now?: () => number;
}) {
  migrateWatchDecisions(db);
  const decide = (agent: WatchAgent, entry: { story?: string; draft?: string; lane?: string; outcome: Outcome; reason: string; visibility?: string; id?: string }) =>
    db.prepare("INSERT OR IGNORE INTO watch_decision VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(entry.id ?? `${entry.outcome}:${randomUUID()}`, agent.id, agent.owner, entry.story ?? null, entry.draft ?? null, entry.lane ?? null, entry.outcome, entry.reason, entry.visibility ?? null, now());
  const setCandidate = (agentId: string, storyId: string, fields: Record<string, unknown>) => {
    const values = { ...fields, updated_at: now() };
    db.prepare(`UPDATE watch_candidate SET ${Object.keys(values).map(key => `${key} = @${key}`).join(", ")} WHERE agent_id = @agent AND story_id = @story`).run({ ...values, agent: agentId, story: storyId });
  };
  const immediatesSince = (agentId: string, since: number) => (db.prepare("SELECT count(*) AS n FROM watch_decision WHERE agent_id = ? AND outcome = 'published' AND lane = 'immediate' AND at > ?").get(agentId, since) as { n: number }).n;
  /** Agent-level conditions, re-read every time: pauses and switches apply to anything already planned. */
  function agentBlock(agent: WatchAgent | undefined): string | null {
    if (!settings.autoPublish) return "Publication automatique désactivée par l’opérateur (XI_WATCH_AUTOPUBLISH).";
    if (!agent) return "ΞAgent introuvable.";
    if (!agent.active) return GATE_REASONS.inactive;
    if (!agent.watch.valid) return GATE_REASONS["invalid-policy"];
    if (!agent.watch.policy.enabled) return GATE_REASONS.disabled;
    if (agent.watch.policy.paused) return GATE_REASONS.paused;
    if (!agent.watch.policy.autoPublish) return "Mode autonome désactivé pour ce ΞAgent.";
    return null;
  }

  /** The decision of a publication whose recording was interrupted: stored once (fixed id). */
  function recovered(agent: WatchAgent, storyId: string, draftId: string, lane: string, visibility: string): Attempt {
    decide(agent, { id: `published:${draftId}`, story: storyId, draft: draftId, lane, outcome: "published", reason: "Publication automatique (reprise après interruption).", visibility });
    setCandidate(agent.id, storyId, { status: "published", reason: "Publiée automatiquement." });
    return { outcome: "published", reason: "Déjà publiée." };
  }

  /** One drafted candidate, checked and published now, or a traced reason why not. */
  async function attempt(agentId: string, storyId: string, lane: "night" | "immediate"): Promise<Attempt> {
    const agent = (await accounts.watchAgents()).find(item => item.id === agentId);
    const blocked = agentBlock(agent);
    if (blocked || !agent) return { outcome: "skipped", reason: blocked ?? "ΞAgent introuvable." };
    const policy = agent.watch.policy;
    const row = db.prepare<[string, string], CandidateRow>("SELECT story_id, story_version, status, lane, importance, novelty_kind, data FROM watch_candidate WHERE agent_id = ? AND story_id = ?").get(agentId, storyId);
    if (!row || row.status !== "drafted") return { outcome: "skipped", reason: "Aucun brouillon validé pour cette actualité." };
    const data = JSON.parse(row.data) as { draft?: { id: string; revision?: string }; weeklySelected?: boolean };
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

    // The draft's sources: each quote still in its article, each article still carried by an approved source.
    const catalog = new Map((await sources.list(agent.owner, { includeDeleted: true })).sources.map(source => [source.id, source]));
    for (const note of draft.sources) {
      const item = note.url ? db.prepare<[string, string], { id: string; title: string; summary: string }>("SELECT id, title, summary FROM watch_item WHERE owner = ? AND url = ?").get(agent.owner, note.url) : undefined;
      if (!item) return abandon(`Article source expiré : ${note.publisher ?? note.title}.`);
      const text = normalizeQuote(`${item.title}\n${item.summary}`);
      if ((note.claims ?? []).some(quote => !text.includes(normalizeQuote(quote)))) return abandon(`Citation introuvable dans ${note.publisher ?? note.title} : brouillon non publié.`);
      const carriers = db.prepare<[string], { source_id: string }>("SELECT source_id FROM watch_item_seen WHERE item_id = ?").all(item.id).map(entry => catalog.get(entry.source_id)).filter(source => source?.status === "approved");
      if (!carriers.length) return abandon(`Source plus approuvée pour ${note.publisher ?? note.title}.`);
      const healthy = carriers.some(source => ((db.prepare<[string], { consecutive_errors: number }>("SELECT consecutive_errors FROM watch_source_state WHERE source_id = ?").get(source!.id))?.consecutive_errors ?? 0) < SUSTAINED_ERRORS);
      // Retried at the next window; it does not hold the other candidates of this one.
      if (!healthy) return trace("deferred", `Source indisponible depuis plusieurs collectes : ${note.publisher ?? note.title}.`);
    }
    if (!(db.prepare("SELECT count(*) AS n FROM watch_claim WHERE agent_id = ? AND story_id = ? AND status IN ('corroborated', 'primary')").get(agentId, storyId) as { n: number }).n) return abandon("Plus aucune affirmation établie.");

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

    // Under the cross-process lock: configuration and ceilings re-read at the exact moment.
    let retryAt: number | null = null;
    const offHours = lane === "immediate" && !publishOpen(agent, now());
    const result = await publications.publishWatchDraft(agent.owner, agentId, draftId, {
      visibility: policy.visibility, revision: data.draft.revision,
      details: { lane, story: storyId, importance: row.importance, decided_by: "watch-auto" },
      guard: async () => {
        const fresh = (await accounts.watchAgents()).find(item => item.id === agentId);
        const block = agentBlock(fresh);
        if (block || !fresh) return block ?? "ΞAgent introuvable.";
        if (fresh.watch.policy.visibility !== policy.visibility) return "Visibilité modifiée pendant la publication : reportée.";
        const gate = publicationGate({ lane: lane === "immediate" ? "immediate" : "night", now: new Date(now()), autoPublish: true, active: fresh.active, policyValid: fresh.watch.valid, policy: fresh.watch.policy, publishedAt: publications.agentPublications(agentId).filter(p => !p.test).map(p => p.publishedAt), window: windowOf(fresh, now()) });
        if (!gate.allowed) { retryAt = gate.retryAt?.getTime() ?? null; return gate.reason === "outside-window" ? outsideWindow(fresh) : GATE_REASONS[gate.reason]; }
        // Outside the publish calendar, only an allowed major event may go out.
        if (lane === "immediate" && !publishOpen(fresh, now()) && !agentSchedule(fresh).majorEvents.enabled) return "Hors du calendrier de publication et exception pour événement majeur désactivée.";
        if (lane === "immediate" && immediatesSince(agentId, now() - DAY) >= fresh.watch.policy.maxImmediatePerDay) return "Plafond d’alertes immédiates atteint : fenêtre nocturne.";
        return null;
      },
      record: () => db.transaction(() => {
        decide(agent, { id: `published:${draftId}`, story: storyId, draft: draftId, lane, outcome: "published", reason: `Publication ${policy.visibility === "public" ? "publique" : "privée"} automatique (${lane === "immediate" ? "alerte majeure" : data.weeklySelected ? "bilan hebdomadaire" : "fenêtre nocturne"}).${offHours ? ` Hors calendrier de publication : événement majeur (importance ${row.importance ?? "?"} ≥ seuil d’alerte ${policy.alertThreshold}, affirmations établies par plusieurs voix ou une source primaire).` : ""}`, visibility: policy.visibility });
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

  /** Immediate alert, outside the window if needed; otherwise it waits for the night window. */
  const alert: Handler = async job => {
    const { agentId, storyId } = job.payload as { agentId: string; storyId: string };
    const agent = (await accounts.watchAgents()).find(item => item.id === agentId);
    // Without the major-event exception, an alert only goes out inside the publish calendar.
    if (agent && !publishOpen(agent, now()) && !agentSchedule(agent).majorEvents.enabled) {
      const reason = "Hors du calendrier de publication et exception pour événement majeur désactivée : différée au calendrier.";
      setCandidate(agentId, storyId, { lane: "night", reason: `Alerte différée : ${reason}` });
      decide(agent, { story: storyId, lane: "immediate", outcome: "deferred", reason, visibility: agent.watch.policy.visibility });
      return { status: "done", result: { outcome: "deferred", reason } };
    }
    const result = await attempt(agentId, storyId, "immediate");
    if (result.outcome === "deferred") setCandidate(agentId, storyId, { lane: "night", reason: `Alerte différée : ${result.reason}` });
    return { status: "done", result: { outcome: result.outcome, reason: result.reason } };
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

  return { attempt, handlers: { "publication-window": night, "publish-alert": alert, "weekly-review": weekly } };
}

/** Alert jobs for drafted immediate candidates (once per candidate version), most important first. */
export function planAlerts(db: Database.Database, queue: JobQueue, agents: WatchAgent[], now: number) {
  migrateWatchCandidates(db);
  let planned = 0;
  for (const agent of runningAgents(agents)) {
    for (const row of db.prepare<[string], { story_id: string; story_version: number }>("SELECT story_id, story_version FROM watch_candidate WHERE agent_id = ? AND status = 'drafted' AND lane = 'immediate' ORDER BY importance DESC, updated_at").all(agent.id)) {
      if (queue.enqueue({ kind: "publish-alert", key: `publish-alert:${agent.id}:${row.story_id}:${row.story_version}`, payload: { agentId: agent.id, storyId: row.story_id }, runAfter: now, maxAttempts: 3 }).created) planned++;
    }
  }
  return planned;
}

/** Decisions older than 90 days are removed. */
export function purgeDecisions(db: Database.Database, now: number) {
  migrateWatchDecisions(db);
  return db.prepare("DELETE FROM watch_decision WHERE at < ?").run(now - 90 * DAY).changes;
}
