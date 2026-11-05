import type Database from "better-sqlite3";
import { migrateWatchCollection } from "../watch/collect";
import { migrateWatchCandidates } from "../watch/evaluate";
import { migrateWatchJobs } from "../watch/jobs";
import { getRun, listRuns, TRIGGER_LABELS, type RunRecord } from "../watch/orchestrator";
import { migrateWatchDecisions } from "../watch/publisher";

/**
 * Execution history of an owner's ΞAgents, read from the orchestrator records and joined with the
 * editorial traces of the same work (candidate, its sources and claims, publication decisions).
 * Always owner-scoped: another owner's run is "not found".
 */
export const RUN_KIND_LABELS: Record<string, string> = {
  "collect-source": "Collecte d’une source", "discover-sources": "Découverte de sources", "evaluate-story": "Analyse d’une information",
  "draft-candidate": "Rédaction d’un brouillon", "publication-window": "Fenêtre de publication", "editorial-diffusion": "Diffusion de la queue éditoriale", "weekly-review": "Revue hebdomadaire",
  "publish-alert": "Publication immédiate", "catch-up": "Rattrapage", "manual-watch": "Veille manuelle", "manual-reanalyze": "Analyse relancée", "manual-reanalyze-held": "Analyses suspendues relancées",
  "manual-draft": "Préparation manuelle", pause: "Mise en pause", resume: "Reprise",
};
export const RUN_STATUS_LABELS: Record<RunRecord["status"], string> = {
  running: "En cours", done: "Terminée", waiting: "En attente", retrying: "Nouvel essai prévu", failed: "Échec", interrupted: "Interrompue", lost: "Reprise ailleurs",
};
export { TRIGGER_LABELS };

export const agentRuns = (db: Database.Database, owner: string, agentId: string, before?: number) => listRuns(db, owner, { agentId, limit: 30, before });

export function runDetail(db: Database.Database, owner: string, id: string) {
  const run = getRun(db, owner, id);
  if (!run) return null;
  migrateWatchCollection(db); migrateWatchJobs(db); migrateWatchCandidates(db); migrateWatchDecisions(db);
  const job = run.jobId ? db.prepare<[string], { key: string; payload: string; state: string; attempts: number; last_error: string | null }>("SELECT key, payload, state, attempts, last_error FROM watch_job WHERE id = ?").get(run.jobId) : undefined;
  const payload = job ? JSON.parse(job.payload) as { storyId?: string; sourceId?: string } | null : null;
  const storyId = payload?.storyId ?? null;
  const candidate = storyId && run.agentId ? db.prepare<[string, string], { status: string; stage: string; lane: string | null; reason: string | null; relevance: number | null; novelty: number | null; importance: number | null; data: string; title: string | null }>(
    "SELECT c.status, c.stage, c.lane, c.reason, c.relevance, c.novelty, c.importance, c.data, s.title FROM watch_candidate c LEFT JOIN watch_story s ON s.id = c.story_id WHERE c.agent_id = ? AND c.story_id = ?").get(run.agentId, storyId) : undefined;
  const stages = candidate ? JSON.parse(candidate.data) as { sources?: { publisher: string; url: string; official: boolean }[] } : null;
  const claims = storyId && run.agentId ? db.prepare<[string, string], { text: string; status: string; reason: string }>("SELECT text, status, reason FROM watch_claim WHERE agent_id = ? AND story_id = ? ORDER BY position").all(run.agentId, storyId) : [];
  const decisions = run.agentId ? db.prepare<[string, string, number, number], { outcome: string; reason: string; lane: string | null; visibility: string | null; at: number; story_id: string | null }>(
    "SELECT outcome, reason, lane, visibility, at, story_id FROM watch_decision WHERE owner = ? AND agent_id = ? AND at BETWEEN ? AND ? ORDER BY at").all(owner, run.agentId, run.startedAt, run.finishedAt ?? Date.now())
    .filter(decision => !storyId || decision.story_id === storyId) : [];
  return {
    run, job: job ? { key: job.key, state: job.state, attempts: job.attempts, lastError: job.last_error } : null,
    candidate: candidate ? { storyId, title: candidate.title, status: candidate.status, stage: candidate.stage, lane: candidate.lane, reason: candidate.reason, relevance: candidate.relevance, novelty: candidate.novelty, importance: candidate.importance, sources: stages?.sources ?? [] } : null,
    claims, decisions,
  };
}
