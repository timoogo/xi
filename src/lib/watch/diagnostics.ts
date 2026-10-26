import { tooOld } from "./drafting";
import type Database from "better-sqlite3";
import type { AccountStore } from "../accounts/store";
import type { Resolution } from "../llm/types";
import { splitSourcesSection } from "../publications/markdown";
import type { PublicationStore } from "../publications/store";
import { migrateWatchCollection, sourceState } from "./collect";
import { migrateWatchCandidates } from "./evaluate";
import { resolveFormat } from "./format";
import { ownerFormat } from "./format-store";
import { migrateWatchJobs } from "./jobs";
import { migrateWatchDecisions } from "./publisher";
import { migrateWatchWorker } from "./worker";
import { planAgentJobs } from "./schedule";
import type { Source, SourceStore } from "./sources";

/** The operator's environment server (XI_INFERENCE_URL), kept for compatibility. */
export type InferenceStatus = { configured: boolean; model: string | null; error: string | null };

const CLAIM_LABELS: Record<string, string> = {
  corroborated: "corroborée", primary: "source primaire", "single-source": "une seule voix", "pending-trust": "source en attente d’approbation",
  qualified: "hypothèse ou interprétation", contradicted: "contredite", unsupported: "sans citation valide",
};
export type CandidateBlocker = { step: "évaluation" | "rédaction" | "publication" | "publiée"; reason: string };

/**
 * Where a candidate stops on the way to a publication, from stored state only: evaluation (with the
 * verdict on its claims), drafting (lane, job), or publication (operator and agent switches, window).
 */
export function candidateBlocker(candidate: { status: string; reason: string | null; lane: string | null; claims: { status: string }[]; draftJob: { state: string; lastError: string | null } | null; obsolete?: boolean },
  publishBlocks: string[], nextWindow: string | null): CandidateBlocker {
  const { status, reason, lane, claims } = candidate;
  if (status === "published") return { step: "publiée", reason: "Publiée." };
  if (status === "drafted") {
    if (publishBlocks.length) return { step: "publication", reason: publishBlocks.join(" ") };
    return { step: "publication", reason: lane === "immediate" ? "Brouillon prêt : publication d’alerte dès que la fenêtre et les plafonds le permettent." : `Brouillon prêt : publication à la prochaine fenêtre${nextWindow ? ` (${nextWindow})` : ""}, dans la limite des plafonds.` };
  }
  if (status === "accepted") {
    if (lane === "weekly") return { step: "rédaction", reason: "Importance sous le seuil de la fenêtre nocturne : réservée au bilan hebdomadaire du dimanche." };
    if (candidate.obsolete) return { step: "rédaction", reason: "Actualité déjà trop ancienne pour sa voie : ne sera ni rédigée ni publiée." };
    if (candidate.draftJob?.state === "failed") return { step: "rédaction", reason: `Rédaction échouée : ${candidate.draftJob.lastError ?? "erreur inconnue"}.` };
    if (candidate.draftJob) return { step: "rédaction", reason: "Rédaction planifiée ou en cours." };
    return { step: "rédaction", reason: "Retenue : rédaction à la prochaine passe de veille." };
  }
  const counts = new Map<string, number>();
  for (const claim of claims) counts.set(claim.status, (counts.get(claim.status) ?? 0) + 1);
  const verdict = claims.length ? ` Affirmations : ${[...counts].map(([key, n]) => `${n} ${CLAIM_LABELS[key] ?? key}`).join(", ")}.` : "";
  return { step: "évaluation", reason: `${reason ?? (status === "evaluating" ? "Évaluation en cours." : "Non retenue.")}${verdict}` };
}

/**
 * Everything the agent page shows about its watch. Owner only: a foreign agent is 404. Plain JSON.
 * `llm`: the agent's resolved model (instance, model, origin) or its configuration problem, as
 * computed by the caller (llm/server.ts `resolve`); null when not provided.
 */
export async function watchDiagnostics({ db, accounts, sources, publications, owner, agentId, autoPublish, allowPublic = false, inference = { configured: false, model: null, error: null }, llm = null, now = new Date() }: {
  db: Database.Database; accounts: AccountStore; sources: SourceStore; publications?: PublicationStore; owner: string; agentId: string; autoPublish: boolean; allowPublic?: boolean; inference?: InferenceStatus; llm?: Resolution | null; now?: Date;
}) {
  const account = await accounts.getOwned(owner, agentId);
  const watch = await accounts.watchPolicy(owner, agentId);
  migrateWatchCollection(db);
  migrateWatchJobs(db);
  migrateWatchCandidates(db);
  migrateWatchDecisions(db);
  migrateWatchWorker(db);
  const topics = new Set(account.editorial ? [account.editorial.primaryTopicId, ...account.editorial.secondaryTopicIds] : []);
  const { sources: catalog, invalid } = await sources.list(owner);
  const relevant = catalog.filter(source => source.topicIds.some(topic => topics.has(topic)));
  const running = !!account.editorial?.active && watch.valid && watch.policy.enabled && !watch.policy.paused;
  const iso = (value: number | null | undefined) => (value ? new Date(value).toISOString() : null);
  const withState = (source: Source) => {
    const state = sourceState(db, source.id);
    return { ...source, state: state && { nextFetchAt: iso(state.next_fetch_at), lastFetchAt: iso(state.last_fetch_at), lastOutcome: state.last_outcome, lastError: state.last_error, consecutiveErrors: state.consecutive_errors } };
  };
  const ids = relevant.map(source => source.id);
  const marks = ids.map(() => "?").join(", ");
  const publisher = new Map(relevant.map(source => [source.id, source.publisher]));
  const fetchLog = ids.length ? db.prepare<string[], { source_id: string; at: number; outcome: string; http_status: number | null; items_new: number; items_seen: number; duration_ms: number; error: string | null }>(
    `SELECT source_id, at, outcome, http_status, items_new, items_seen, duration_ms, error FROM watch_fetch_log WHERE source_id IN (${marks}) ORDER BY at DESC, id DESC LIMIT 30`).all(...ids)
    .map(row => ({ sourceId: row.source_id, publisher: publisher.get(row.source_id) ?? "Source", at: iso(row.at)!, outcome: row.outcome, httpStatus: row.http_status, itemsNew: row.items_new, itemsSeen: row.items_seen, durationMs: row.duration_ms, error: row.error })) : [];

  const stories = db.prepare<[string], { id: string; title: string; first_seen_at: number; last_seen_at: number; first_published_at: string | null; item_count: number; publisher_count: number; independent_count: number; topic_ids: string }>(
    "SELECT id, title, first_seen_at, last_seen_at, first_published_at, item_count, publisher_count, independent_count, topic_ids FROM watch_story WHERE owner = ? ORDER BY last_seen_at DESC LIMIT 300").all(owner)
    .filter(story => (JSON.parse(story.topic_ids) as string[]).some(topic => topics.has(topic))).slice(0, 20);
  const items = stories.length ? db.prepare<string[], { id: string; story_id: string; url: string; publisher: string; title: string; published_at: string | null; fetched_at: number; credits: string; lineage: number; sightings: number }>(
    `SELECT i.id, i.story_id, i.url, i.publisher, i.title, i.published_at, i.fetched_at, i.credits, i.lineage, (SELECT count(*) FROM watch_item_seen s WHERE s.item_id = i.id) AS sightings
     FROM watch_item i WHERE i.story_id IN (${stories.map(() => "?").join(", ")}) ORDER BY i.lineage, coalesce(i.published_at, i.fetched_at)`).all(...stories.map(story => story.id)) : [];

  const jobs = db.prepare<string[], { kind: string; key: string; state: string; run_after: number; attempts: number; max_attempts: number; last_error: string | null; result: string | null; updated_at: number }>(
    `SELECT kind, key, state, run_after, attempts, max_attempts, last_error, result, updated_at FROM watch_job
     WHERE instr(key, ?) > 0 ${ids.length ? `OR (kind = 'collect-source' AND json_extract(payload, '$.sourceId') IN (${marks}))` : ""} ORDER BY updated_at DESC LIMIT 30`).all(agentId, ...ids)
    .map(job => ({ kind: job.kind, state: job.state, runAfter: iso(job.run_after)!, attempts: job.attempts, maxAttempts: job.max_attempts, lastError: job.last_error, result: job.result ? JSON.parse(job.result) as Record<string, unknown> : null, updatedAt: iso(job.updated_at)!, source: publisher.get(job.key.split(":")[1]) ?? null }));

  const nextWindow = running ? planAgentJobs({ id: agentId, active: true, watch }, now)[0]?.runAfter.toISOString() ?? null : null;
  // Same switches as the publisher (publisher.ts), so a ready draft says what keeps it waiting.
  const publishBlocks = [
    ...(!autoPublish ? ["Publication automatique désactivée par l’opérateur (XI_WATCH_AUTOPUBLISH)."] : []),
    ...(!running ? ["Veille arrêtée, en pause ou ΞAgent inactif."] : []),
    ...(!watch.policy.autoPublish ? ["Mode autonome désactivé pour ce ΞAgent."] : []),
    ...(watch.policy.visibility === "public" && !watch.publicConfirmedAt ? ["Visibilité publique non confirmée."] : []),
    ...(watch.policy.visibility === "public" && !allowPublic ? ["Publication publique non autorisée par l’opérateur (XI_WATCH_AUTOPUBLISH_PUBLIC)."] : []),
  ];
  const draftJobs = new Map(db.prepare<[string], { story: string; state: string; last_error: string | null }>(
    "SELECT json_extract(payload, '$.storyId') AS story, state, last_error FROM watch_job WHERE kind = 'draft-candidate' AND json_extract(payload, '$.agentId') = ? ORDER BY updated_at").all(agentId)
    .map(row => [row.story, { state: row.state, lastError: row.last_error }]));
  type CandidateRow = { story_id: string; status: string; stage: string; lane: string | null; topic_id: string | null; relevance: number | null; novelty: number | null; novelty_kind: string | null; importance: number | null; related_publication_id: string | null; related_story_id: string | null; reason: string | null; data: string; model: string | null; updated_at: number; story_title: string | null; related_title: string | null };
  const candidateRows = db.prepare<[string], CandidateRow>(`SELECT c.story_id, c.status, c.stage, c.lane, c.topic_id, c.relevance, c.novelty, c.novelty_kind, c.importance, c.related_publication_id, c.related_story_id, c.reason, c.data, c.model, c.updated_at,
    s.title AS story_title, r.title AS related_title FROM watch_candidate c LEFT JOIN watch_story s ON s.id = c.story_id LEFT JOIN watch_story r ON r.id = c.related_story_id
    WHERE c.agent_id = ? ORDER BY c.updated_at DESC LIMIT 30`).all(agentId);
  const claimRows = candidateRows.length ? db.prepare<string[], { story_id: string; text: string; kind: string; attribution: string | null; status: string; reason: string; evidence: string; independent_count: number }>(
    `SELECT story_id, text, kind, attribution, status, reason, evidence, independent_count FROM watch_claim WHERE agent_id = ? AND story_id IN (${candidateRows.map(() => "?").join(", ")}) ORDER BY position`).all(agentId, ...candidateRows.map(row => row.story_id)) : [];
  const candidates = candidateRows.map(row => {
    const stages = JSON.parse(row.data) as {
      title?: string; relevance?: { justification: string; outOfScope: string[] }; novelty?: { justification: string; newFacts: string[] };
      importance?: { factors: { label: string; weight: number; value: number; contribution: number }[]; note: string }; extraction?: { impact: { reasons: string[] } };
      sources?: { publisher: string; url: string; lineage: number; official: boolean; trust?: "approved" | "pending" | "denied" }[];
    };
    return {
      storyId: row.story_id, title: row.story_title ?? stages.title ?? "Actualité fusionnée ou expirée", status: row.status, stage: row.stage, lane: row.lane, topicId: row.topic_id,
      relevance: row.relevance, novelty: row.novelty, noveltyKind: row.novelty_kind, importance: row.importance, reason: row.reason, model: row.model, updatedAt: iso(row.updated_at)!,
      relevanceJustification: stages.relevance?.justification ?? null, outOfScope: stages.relevance?.outOfScope ?? [],
      noveltyJustification: stages.novelty?.justification ?? null, newFacts: stages.novelty?.newFacts ?? [],
      relatedPublicationId: row.related_publication_id, relatedStory: row.related_story_id ? { id: row.related_story_id, title: row.related_title } : null,
      importanceFactors: stages.importance?.factors ?? [], importanceNote: stages.importance?.note ?? null, impactReasons: stages.extraction?.impact.reasons ?? [],
      sources: stages.sources ?? [],
      blocker: candidateBlocker({ status: row.status, reason: row.reason, lane: row.lane, claims: claimRows.filter(claim => claim.story_id === row.story_id), draftJob: draftJobs.get(row.story_id) ?? null, obsolete: row.status === "accepted" && tooOld(db, owner, row.story_id, row.lane, now.getTime()) }, publishBlocks, nextWindow),
      claims: claimRows.filter(claim => claim.story_id === row.story_id).map(claim => ({
        text: claim.text, kind: claim.kind, attribution: claim.attribution, status: claim.status, reason: claim.reason, independent: claim.independent_count,
        quotes: (JSON.parse(claim.evidence) as { quotes: { publisher: string; quote: string; url: string }[] }).quotes.map(({ publisher, quote, url }) => ({ publisher, quote, url })),
        rejectedQuotes: (JSON.parse(claim.evidence) as { rejectedQuotes: number }).rejectedQuotes,
      })),
    };
  });

  // Drafts are read through the publication store with the owner's own permissions: what is shown is what is stored.
  const draftRows = db.prepare<[string], { story_id: string; status: string; lane: string | null; relevance: number | null; novelty: number | null; importance: number | null; reason: string | null; data: string; updated_at: number }>(
    "SELECT story_id, status, lane, relevance, novelty, importance, reason, data, updated_at FROM watch_candidate WHERE agent_id = ? AND json_extract(data, '$.draft.id') IS NOT NULL ORDER BY updated_at DESC LIMIT 20").all(agentId);
  const drafts = publications ? (await Promise.all(draftRows.map(async row => {
    const data = JSON.parse(row.data) as { title?: string; draft: { id: string }; drafting?: { attempts: { problems: string[] }[] } };
    const draft = await publications.get({ id: owner }, data.draft.id).catch(() => null);
    if (!draft || draft.authorId !== agentId) return null;
    return {
      id: draft.id, storyId: row.story_id, title: data.title ?? "Actualité", type: draft.type, status: draft.status, visibility: draft.visibility, revision: draft.revision,
      review: draft.status === "published" ? "approved" as const : row.status === "rejected" ? "rejected" as const : "pending" as const,
      lane: row.lane, relevance: row.relevance, novelty: row.novelty, importance: row.importance, reason: row.reason, attempts: data.drafting?.attempts.length ?? 0,
      summary: draft.summary, updatedAt: iso(row.updated_at)!,
      messages: draft.messages.map(message => ({ file: message.file, body: message.body, ...splitSourcesSection(message.body) })),
      sources: draft.sources.map(source => ({ file: source.file, title: source.title, publisher: source.publisher, url: source.url, date: source.date ?? null, facts: source.claims ?? [], reservations: source.reservations ?? [] })),
    };
  }))).filter(draft => !!draft) : [];

  const decisions = db.prepare<[string], { story_id: string | null; draft_id: string | null; lane: string | null; outcome: string; reason: string; visibility: string | null; at: number; title: string | null }>(
    "SELECT d.story_id, d.draft_id, d.lane, d.outcome, d.reason, d.visibility, d.at, s.title FROM watch_decision d LEFT JOIN watch_story s ON s.id = d.story_id WHERE d.agent_id = ? ORDER BY d.at DESC LIMIT 30").all(agentId)
    .map(row => ({ storyId: row.story_id, title: row.title, draftId: row.draft_id, lane: row.lane, outcome: row.outcome, reason: row.reason, visibility: row.visibility, at: iso(row.at)! }));
  // Drafting failures and refusals: candidates held after a drafting attempt (limits, sources, model's decline).
  const draftFailures = db.prepare<[string], { story_id: string; reason: string | null; data: string; updated_at: number; title: string | null }>(
    `SELECT c.story_id, c.reason, c.data, c.updated_at, s.title FROM watch_candidate c LEFT JOIN watch_story s ON s.id = c.story_id
     WHERE c.agent_id = ? AND c.status = 'held' AND json_extract(c.data, '$.drafting') IS NOT NULL ORDER BY c.updated_at DESC LIMIT 20`).all(agentId)
    .map(row => {
      const data = JSON.parse(row.data) as { title?: string; drafting?: { attempts: { format: string; messages: number; problems: string[] }[]; declined?: string } };
      return { storyId: row.story_id, title: row.title ?? data.title ?? "Actualité", reason: row.reason, at: iso(row.updated_at)!, declined: data.drafting?.declined ?? null, attempts: data.drafting?.attempts ?? [] };
    });
  const global = ownerFormat(db, owner);
  const format = { global, overrides: watch.policy.format ?? {}, resolved: resolveFormat(global.format, watch.policy.format) };
  const workerRow = db.prepare<[], { last_tick_at: number | null; summary: string | null; last_error: string | null; last_error_at: number | null }>("SELECT last_tick_at, summary, last_error, last_error_at FROM watch_worker WHERE id = 'worker'").get();
  // The timer runs every 10 minutes: no pass for 30 minutes means the worker is not running.
  const worker = { lastTickAt: iso(workerRow?.last_tick_at), stale: !workerRow?.last_tick_at || now.getTime() - workerRow.last_tick_at > 30 * 60_000, summary: workerRow?.summary ? JSON.parse(workerRow.summary) as Record<string, unknown> : null, lastError: workerRow?.last_error ?? null, lastErrorAt: iso(workerRow?.last_error_at) };
  const failedJobs = (db.prepare<[string], { n: number }>("SELECT count(*) AS n FROM watch_job WHERE state = 'failed' AND instr(key, ?) > 0").get(agentId))!.n;

  return {
    watch, running, publishBlocks, autoPublish, allowPublic, inference, llm, nextWindow, invalidSources: invalid, candidates, drafts, decisions, worker, failedJobs, format, draftFailures,
    sources: relevant.map(withState),
    fetchLog,
    stories: stories.map(story => ({
      id: story.id, title: story.title, firstSeenAt: iso(story.first_seen_at)!, lastSeenAt: iso(story.last_seen_at)!, firstPublishedAt: story.first_published_at,
      itemCount: story.item_count, publisherCount: story.publisher_count, independentCount: story.independent_count,
      items: items.filter(item => item.story_id === story.id).map(item => ({ id: item.id, url: item.url, publisher: item.publisher, title: item.title, publishedAt: item.published_at, fetchedAt: iso(item.fetched_at)!, credits: JSON.parse(item.credits) as string[], lineage: item.lineage, sightings: item.sightings })),
    })),
    jobs,
  };
}
export type WatchDiagnostics = Awaited<ReturnType<typeof watchDiagnostics>>;
