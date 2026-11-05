import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { AccountStore } from "../accounts/store";
import type { WatchAgent } from "../accounts/types";
import type { SystemAgentStore } from "../system-agents/store";
import { enqueueSystemTask } from "../system-agents/queue";
import type { SystemServices, SystemTask } from "../system-agents/tasks";
import type { TopicStore } from "../topics/store";
import { isPersonal, type Topic } from "../topics/types";
import { migrateWatchCollection, sourceState } from "../watch/collect";
import { InferenceUnavailableError } from "../watch/inference";
import { migrateWatchJobs, type JobQueue } from "../watch/jobs";
import { agentLLMSettings } from "../watch/llm-binding";
import { jobAgent, SYSTEM_TASK_KIND } from "../watch/orchestrator";
import type { SourceStore } from "../watch/sources";
import { INHERIT_LLM_DRAFT } from "../llm/types";
import { defaultSchedule, scheduleSchema } from "../xiagents/schedule";
import { loadContext, type ModelChoices } from "./context";
import { askKonstruktor } from "./converse";
import { createConversationStore, migrateKonstruktor, type ConversationStore } from "./store";
import type { KonstruktorTarget, Proposal, ProposedChange } from "./types";

/**
 * Konstruktor's proactive suggestions. A review reads the owner's configuration and a few signals
 * (watch calendar, model availability, source health, definitive job failures, topic coverage) and
 * turns each problem into a finding with a fingerprint: its kind, what it concerns and the state
 * that makes it a problem. A finding is recorded once per (owner, fingerprint), as a Konstruktor
 * conversation opened by Konstruktor (its preview and validation are L5's), linked to the ΞAgents
 * and Topics it concerns. The same problem in the same state is never suggested twice, whatever
 * the owner decided; a significant change (another configuration, other failing sources) gives
 * another fingerprint. A finding that disappears makes its undecided suggestion obsolete.
 *
 * Nothing here writes a ΞAgent or a Topic. Reviews run as `system-task` jobs on the watch queue:
 * planned by the worker's pass (`planReviews`: rules only, a job only when a finding is new, a
 * suggestion became obsolete or awaits its model's proposal, at most once a day for the same state)
 * or asked from the inbox. Proposals needing content (sources, perimeter) come from the owner's
 * local model; while it is unavailable the suggestion keeps its reason and is completed later.
 */
export const SUGGESTION_KINDS = {
  "model-unavailable": "Modèle local indisponible",
  "watch-closed": "Veille sans plage horaire",
  "failing-sources": "Sources en échec",
  "no-sources": "Aucune source approuvée",
  blocked: "ΞAgent bloqué",
  "empty-profile": "Périmètre éditorial vide",
  "topic-uncovered": "Topic sans ΞAgent",
} as const;
export type SuggestionKind = keyof typeof SUGGESTION_KINDS;

export type Finding = {
  kind: SuggestionKind; fingerprint: string; target: KonstruktorTarget; agentIds: string[]; topicIds: string[];
  title: string; reason: string;
  /** A correction known without a model. */
  change?: { summary: string; change: ProposedChange };
  /** What the local model is asked, for a correction that needs content. */
  ask?: string;
};

const FAILURE_WINDOW = 7 * 86_400_000;
const BLOCKED_AFTER = 3;
const SOURCE_ERRORS = 3;
const TOPIC_GRACE = 86_400_000;
const RULE_MODEL = "règle de Konstruktor";

const hash = (...parts: unknown[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
/** A UUID (version 5 layout) derived from its parts: the same parts give the same id. */
export function stableUuid(...parts: unknown[]) {
  const h = hash(...parts);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;
const topicsOf = (agent: WatchAgent) => [agent.primaryTopicId, ...agent.secondaryTopicIds];
const rule = (summary: string, change: ProposedChange) => ({ summary, change });

export type ReviewServices = Pick<SystemServices, "db" | "accounts" | "topics" | "sources" | "models">;

/** Every finding about the owner's ΞAgents and Topics now (rules only: no model call). */
export async function findings({ db, accounts, topics, sources, models }: ReviewServices, owner: string, now: number): Promise<Finding[]> {
  migrateWatchCollection(db);
  migrateWatchJobs(db);
  const everyone = await accounts.watchAgents();
  const agents = everyone.filter(agent => agent.owner === owner);
  const catalog = sources ? (await sources.list(owner)).sources : [];
  const choices: ModelChoices | null = models?.(owner) ?? null;
  const failures = new Map<string, { count: number; lastError: string | null }>();
  for (const row of db.prepare<[number, string], { payload: string; last_error: string | null }>("SELECT payload, last_error FROM watch_job WHERE state = 'failed' AND updated_at > ? AND kind != ? ORDER BY updated_at").all(now - FAILURE_WINDOW, SYSTEM_TASK_KIND)) {
    const agentId = jobAgent({ payload: JSON.parse(row.payload) });
    if (!agentId) continue;
    const current = failures.get(agentId) ?? { count: 0, lastError: null };
    failures.set(agentId, { count: current.count + 1, lastError: row.last_error ?? current.lastError });
  }
  const out: Finding[] = [];
  const add = (finding: Omit<Finding, "fingerprint">, ...state: unknown[]) => out.push({ ...finding, fingerprint: hash(finding.kind, finding.target, ...state) });

  for (const agent of agents) {
    const target: KonstruktorTarget = { type: "agent", id: agent.id };
    const name = `@${agent.handle}`;
    const topicIds = topicsOf(agent);
    const running = agent.active && agent.watch.valid && agent.watch.policy.enabled && !agent.watch.policy.paused;

    // The model chosen for the agent no longer exists: back to the owner's global configuration.
    const llm = agentLLMSettings(agent).config;
    if (choices && llm.instanceId) {
      const instance = choices.instances.find(item => item.id === llm.instanceId);
      const missing = !instance ? "L’instance locale choisie n’existe plus ou est désactivée."
        : llm.model && instance.models.length && !instance.models.includes(llm.model) ? `Le modèle « ${llm.model} » n’est plus proposé par l’instance « ${instance.name} ».` : null;
      if (missing) add({
        kind: "model-unavailable", target, agentIds: [agent.id], topicIds, title: `${name} : modèle local indisponible`,
        reason: `${missing} Analyse et rédaction échoueront tant que le ΞAgent l’utilise.`,
        change: rule("Revenir à la configuration locale globale", { type: "agent-draft", agentId: agent.id, patch: { llm: { ...INHERIT_LLM_DRAFT, options: llm.options } } }),
      }, llm.instanceId, llm.model, instance?.models ?? null);
    }

    // Watch enabled but its calendar never opens: nothing is ever collected or analysed.
    const schedule = agent.schedule;
    if (running && schedule && (!schedule.valid || schedule.watch.week.every(ranges => !ranges.length))) {
      const base = schedule.valid ? scheduleSchema.strip().parse(schedule) : defaultSchedule(schedule.timeZone);
      add({
        kind: "watch-closed", target, agentIds: [agent.id], topicIds, title: `${name} : veille jamais ouverte`,
        reason: schedule.valid ? "La veille est activée mais son calendrier ne comporte aucune plage : rien n’est collecté ni analysé." : "Le calendrier enregistré est illisible : la veille reste fermée.",
        change: rule("Rétablir le calendrier de veille par défaut", { type: "agent-draft", agentId: agent.id, patch: { schedule: { ...base, watch: defaultSchedule(base.timeZone).watch } } }),
      }, schedule.revision);
    }

    // Sources: durably failing ones, or none approved at all for the agent's topics.
    const relevant = catalog.filter(source => source.topicIds.some(id => topicIds.includes(id)));
    const failing = relevant.filter(source => source.status === "approved" && (sourceState(db, source.id)?.consecutive_errors ?? 0) >= SOURCE_ERRORS);
    if (failing.length) add({
      kind: "failing-sources", target, agentIds: [agent.id], topicIds: [...new Set(failing.flatMap(source => source.topicIds))], title: `${name} : ${plural(failing.length, "source en échec", "sources en échec")}`,
      reason: `Collecte en échec répété (${SOURCE_ERRORS} erreurs consécutives ou plus) : ${failing.map(source => source.publisher).join(", ")}.`,
      ask: `Bilan automatique : les sources ${failing.map(source => source.url).join(", ")} de ce ΞAgent échouent à chaque collecte. Propose dans "sources" deux à quatre sources de remplacement fiables, publiques et adaptées à ses topics. Ne change rien d’autre.`,
    }, failing.map(source => source.id).sort());
    else if (agent.active && !relevant.some(source => source.status === "approved")) add({
      kind: "no-sources", target, agentIds: [agent.id], topicIds, title: `${name} : aucune source approuvée`,
      reason: "Aucune source approuvée ne couvre les topics de ce ΞAgent : il ne peut établir aucune information.",
      ask: "Bilan automatique : ce ΞAgent n’a aucune source approuvée pour ses topics. Propose dans \"sources\" trois à cinq sources fiables, publiques et adaptées à ses topics. Ne change rien d’autre.",
    }, [...topicIds].sort(), relevant.map(source => `${source.id}:${source.status}`).sort());

    // Durably blocked: repeated definitive failures; same configuration, same suggestion.
    const failed = failures.get(agent.id);
    if (running && failed && failed.count >= BLOCKED_AFTER) add({
      kind: "blocked", target, agentIds: [agent.id], topicIds, title: `${name} : bloqué`,
      reason: `${plural(failed.count, "tâche a échoué", "tâches ont échoué")} définitivement ces 7 derniers jours${failed.lastError ? ` (dernière erreur : ${failed.lastError.slice(0, 300)})` : ""}.`,
      ask: `Bilan automatique : ce ΞAgent est bloqué, ${failed.count} tâches en échec définitif en 7 jours${failed.lastError ? `, dernière erreur « ${failed.lastError.slice(0, 300)} »` : ""}. Si sa configuration en est la cause (modèle, calendrier, sources), propose la correction ; sinon explique la cause probable sans proposition.`,
    }, llm, schedule?.revision ?? null, agent.watch.revision ?? null);

    if (!agent.profile?.perimeter.trim()) add({
      kind: "empty-profile", target, agentIds: [agent.id], topicIds, title: `${name} : périmètre éditorial vide`,
      reason: "Sans périmètre ni charte, l’évaluation des actualités et la rédaction reposent sur les seuls topics.",
      ask: "Bilan automatique : le périmètre éditorial de ce ΞAgent est vide. Propose un périmètre précis et une charte courte adaptés à ses topics. Ne change rien d’autre.",
    }, agent.profile?.charter ?? "");
  }

  // Coverage: a shared topic the owner created, followed by no ΞAgent at all, after a day.
  const followed = new Set(everyone.flatMap(topicsOf));
  const created = (await topics.visible(owner)).shared.filter((topic: Topic) => !isPersonal(topic) && topic.createdBy === owner && !followed.has(topic.id) && now - Date.parse(topic.createdAt) >= TOPIC_GRACE);
  for (const topic of created) {
    const handle = `veille-${topic.tag.replace(/\./g, "-")}`.slice(0, 60);
    add({
      kind: "topic-uncovered", target: { type: "new-agent", id: null }, agentIds: [], topicIds: [topic.id], title: `#${topic.tag} : aucun ΞAgent ne le suit`,
      reason: `Le topic « ${topic.name} » que vous avez créé n’est suivi par aucun ΞAgent : aucune veille ne l’alimente.`,
      change: rule(`Créer un ΞAgent pour #${topic.tag}`, { type: "agent-draft", agentId: null, patch: { name: `Veille ${topic.name}`.slice(0, 160), handle, perimeter: topic.scope, topics: [{ type: "existing", id: topic.id, reason: `Topic #${topic.tag}` }] } }),
    }, topic.id);
  }
  return out;
}

// ---------------------------------------------------------------- store

type SuggestionRow = {
  id: string; owner: string; fingerprint: string; kind: SuggestionKind; session_id: string; title: string; reason: string; ask: string | null;
  enriched: number; dismissed_at: number | null; obsolete_at: number | null; created_at: number; updated_at: number;
};
export type StoredSuggestion = {
  id: string; kind: SuggestionKind; sessionId: string; title: string; reason: string; awaitingModel: boolean;
  dismissed: boolean; obsolete: boolean; createdAt: number; updatedAt: number; agentIds: string[]; topicIds: string[];
};

export function migrateSuggestions(db: Database.Database) {
  migrateKonstruktor(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS konstruktor_suggestion (
      id TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      kind TEXT NOT NULL,
      session_id TEXT NOT NULL REFERENCES konstruktor_session (id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      reason TEXT NOT NULL,
      ask TEXT,
      enriched INTEGER NOT NULL DEFAULT 0,
      dismissed_at INTEGER,
      obsolete_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (owner, fingerprint)
    );
    CREATE TABLE IF NOT EXISTS konstruktor_suggestion_link (
      suggestion_id TEXT NOT NULL REFERENCES konstruktor_suggestion (id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('agent', 'topic')),
      ref_id TEXT NOT NULL,
      PRIMARY KEY (suggestion_id, type, ref_id)
    );
    CREATE INDEX IF NOT EXISTS konstruktor_suggestion_ref ON konstruktor_suggestion_link (type, ref_id);
  `);
}

/** Suggestions per owner: every read and write is scoped by owner (another user's id is unknown). */
export function createSuggestionStore(db: Database.Database, now: () => number = Date.now) {
  migrateSuggestions(db);
  const links = db.prepare<[string], { type: "agent" | "topic"; ref_id: string }>("SELECT type, ref_id FROM konstruktor_suggestion_link WHERE suggestion_id = ?");
  const toSuggestion = (row: SuggestionRow): StoredSuggestion => {
    const linked = links.all(row.id);
    return {
      id: row.id, kind: row.kind, sessionId: row.session_id, title: row.title, reason: row.reason, awaitingModel: !!row.ask && !row.enriched,
      dismissed: row.dismissed_at !== null, obsolete: row.obsolete_at !== null, createdAt: row.created_at, updatedAt: row.updated_at,
      agentIds: linked.filter(link => link.type === "agent").map(link => link.ref_id), topicIds: linked.filter(link => link.type === "topic").map(link => link.ref_id),
    };
  };

  /**
   * Records a finding once: its conversation (opened by Konstruktor with the reason and, when known
   * without a model, the correction) and its links, in one transaction. Seen again, it is current
   * again (no longer obsolete); nothing else changes, whatever the owner decided.
   */
  const record = db.transaction((owner: string, finding: Finding, conversations: ConversationStore) => {
    const id = stableUuid(owner, finding.fingerprint);
    const existing = db.prepare<[string, string], SuggestionRow>("SELECT * FROM konstruktor_suggestion WHERE id = ? AND owner = ?").get(id, owner);
    if (existing) {
      if (existing.obsolete_at !== null) db.prepare("UPDATE konstruktor_suggestion SET obsolete_at = NULL, updated_at = ? WHERE id = ?").run(now(), id);
      return { id, created: false };
    }
    conversations.createSession(owner, id, finding.target, `Suggestion : ${finding.title}`);
    const proposals: Proposal[] = finding.change ? [{ id: stableUuid(id, "rule"), summary: finding.change.summary, origin: "ai", model: RULE_MODEL, status: "proposed", change: finding.change.change, notes: [] }] : [];
    const text = `${finding.reason}${proposals.length ? " Voici une correction à revoir avant toute application." : finding.ask ? " Je prépare une proposition avec votre modèle local." : ""}`;
    conversations.suggest(id, "finding", text, { proposals, model: RULE_MODEL });
    db.prepare("INSERT INTO konstruktor_suggestion VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?, ?)").run(id, owner, finding.fingerprint, finding.kind, id, finding.title.slice(0, 200), finding.reason.slice(0, 2_000), finding.ask ?? null, now(), now());
    const link = db.prepare("INSERT OR IGNORE INTO konstruktor_suggestion_link VALUES (?, ?, ?)");
    for (const agentId of finding.agentIds) link.run(id, "agent", agentId);
    for (const topicId of finding.topicIds) link.run(id, "topic", topicId);
    return { id, created: true };
  });
  /** Undecided suggestions whose finding is gone are marked obsolete (kept in the history). */
  function markObsolete(owner: string, current: string[]) {
    const rows = db.prepare<[string], { id: string; fingerprint: string }>("SELECT id, fingerprint FROM konstruktor_suggestion WHERE owner = ? AND obsolete_at IS NULL").all(owner);
    const gone = rows.filter(row => !current.includes(row.fingerprint));
    const mark = db.prepare("UPDATE konstruktor_suggestion SET obsolete_at = ?, updated_at = ? WHERE id = ?");
    db.transaction(() => { for (const row of gone) mark.run(now(), now(), row.id); })();
    return gone.length;
  }
  const list = (owner: string) => db.prepare<[string], SuggestionRow>("SELECT * FROM konstruktor_suggestion WHERE owner = ? ORDER BY created_at DESC, rowid DESC LIMIT 200").all(owner).map(toSuggestion);
  function get(owner: string, id: string) {
    const row = z.uuid().safeParse(id).success ? db.prepare<[string, string], SuggestionRow>("SELECT * FROM konstruktor_suggestion WHERE id = ? AND owner = ?").get(id, owner) : undefined;
    return row ? toSuggestion(row) : null;
  }
  const fingerprints = (owner: string) => new Set(db.prepare<[string], { fingerprint: string }>("SELECT fingerprint FROM konstruktor_suggestion WHERE owner = ?").all(owner).map(row => row.fingerprint));
  const current = (owner: string) => db.prepare<[string], { fingerprint: string }>("SELECT fingerprint FROM konstruktor_suggestion WHERE owner = ? AND obsolete_at IS NULL").all(owner).map(row => row.fingerprint);
  const awaiting = (owner: string) => db.prepare<[string], SuggestionRow>("SELECT * FROM konstruktor_suggestion WHERE owner = ? AND ask IS NOT NULL AND enriched = 0 AND dismissed_at IS NULL AND obsolete_at IS NULL ORDER BY created_at").all(owner);
  const enriched = (id: string) => db.prepare("UPDATE konstruktor_suggestion SET enriched = 1, updated_at = ? WHERE id = ?").run(now(), id);
  const dismiss = (owner: string, id: string, dismissed: boolean) => db.prepare("UPDATE konstruktor_suggestion SET dismissed_at = ?, updated_at = ? WHERE id = ? AND owner = ?").run(dismissed ? now() : null, now(), id, owner);

  return { record: (owner: string, finding: Finding, conversations: ConversationStore) => record.immediate(owner, finding, conversations), markObsolete, list, get, fingerprints, current, awaiting, enriched, dismiss };
}
export type SuggestionStore = ReturnType<typeof createSuggestionStore>;

/** Whether a review would change anything: a new finding, one gone, or a proposal still to ask the model. */
export function needsReview(store: SuggestionStore, owner: string, found: Finding[]) {
  const known = store.fingerprints(owner);
  const live = found.map(finding => finding.fingerprint);
  return found.some(finding => !known.has(finding.fingerprint)) || store.current(owner).some(fingerprint => !live.includes(fingerprint)) || store.awaiting(owner).length > 0;
}
/** The review's request id: one review per owner, state and day (the same state is reviewed once a day at most). */
export const reviewRequestId = (owner: string, found: Finding[], at: number) => stableUuid("review", owner, found.map(finding => finding.fingerprint).sort(), Math.floor(at / 86_400_000));

// ---------------------------------------------------------------- task and planning

const reviewInput = z.object({}).strict().nullable();

/** One review of the owner's configuration: records findings, marks obsolete ones, asks the model for missing proposals. */
export const REVIEW_TASK: SystemTask<z.infer<typeof reviewInput>> = {
  input: reviewInput,
  internal: true,
  async run({ owner, llm, services, now }) {
    const found = await findings(services, owner, now());
    const suggestions = createSuggestionStore(services.db, now);
    const conversations = createConversationStore(services.db, now);
    let created = 0;
    for (const finding of found) if (suggestions.record(owner, finding, conversations).created) created++;
    const obsolete = suggestions.markObsolete(owner, found.map(finding => finding.fingerprint));
    let completed = 0;
    for (const pending of suggestions.awaiting(owner)) {
      const session = conversations.session(owner, pending.session_id);
      try {
        const context = await loadContext(services, owner, session.target);
        const { answer, model, proposal } = await askKonstruktor(llm(), context, session.target, [], pending.ask!);
        conversations.suggest(session.id, "proposal", answer.reply, { questions: answer.questions, unsupported: answer.unsupported, proposals: proposal ? [proposal] : [], model });
      } catch (error) {
        // Unavailable: the job waits and retries (already recorded findings stay). Anything else
        // (no model configured, invalid answer, target gone): the reason stays, the owner can ask.
        if (error instanceof InferenceUnavailableError) throw error;
      }
      suggestions.enriched(pending.id);
      completed++;
    }
    return { findings: found.length, created, obsolete, completed };
  },
};

/**
 * Worker pass: plans a review for each owner whose findings changed (rules only), on the system
 * tasks' queue. Konstruktor disabled: nothing is planned.
 */
export async function planReviews({ queue, systemAgents, services, now }: {
  queue: JobQueue; systemAgents: SystemAgentStore; services: ReviewServices & { accounts: AccountStore; topics: TopicStore; sources?: SourceStore }; now: number;
}) {
  const agent = await systemAgents.get("konstruktor");
  if (!agent.enabled) return 0;
  const store = createSuggestionStore(services.db);
  const owners = new Set([...(await services.accounts.watchAgents()).map(item => item.owner), ...(await services.topics.list()).map(topic => topic.createdBy)]);
  let planned = 0;
  for (const owner of owners) {
    const found = await findings(services, owner, now);
    if (!needsReview(store, owner, found)) continue;
    const requestId = reviewRequestId(owner, found, now);
    if (enqueueSystemTask(queue, { agentId: agent.id, kind: "konstruktor", task: "review", owner, requestId, input: null, trigger: "review" }).created) planned++;
  }
  return planned;
}
