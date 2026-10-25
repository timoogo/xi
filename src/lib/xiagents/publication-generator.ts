import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { AccountStore } from "../accounts/store";
import type { PublicationStore } from "../publications/store";
import type { TopicStore } from "../topics/store";
import { TopicError } from "../topics/types";
import { readCandidate, writeCandidateDraft } from "../watch/drafting";
import { migrateWatchCandidates } from "../watch/evaluate";
import { InferenceConfigError, InferenceOutputError, InferenceUnavailableError } from "../watch/inference";
import { bindSafely, describeLLM, type BindLLM } from "../watch/llm-binding";
import { finishRun, startRun } from "../watch/orchestrator";

/**
 * Real publication, on the owner's explicit request ("Générer une publication"): the same circuit
 * as the autonomous watch — information collected and verified by the evaluation, then drafted by
 * the agent's own model (agent → account → error) from the verified claims only, checked by code
 * and by a consistency review — ending in a private draft. Publishing it stays a separate,
 * confirmed review action (`reviewDraft`, private only). Distinct from the fixture generator
 * (generator.ts): no shared business logic, and an inference failure is reported as is, never
 * replaced by fictitious content.
 *
 * Synchronous: the request lasts as long as the model writes. The run is recorded in the execution
 * history (kind `manual-generate`) with its real outcome; there is no intermediate progress to show.
 */
export const generateRequestSchema = z.object({
  format: z.enum(["post", "thread"]),
  /** An accepted candidate of the agent; absent, the most important one not yet drafted. */
  storyId: z.string().min(1).max(200).optional(),
}).strict();

type Deps = { db: Database.Database; accounts: AccountStore; topics: TopicStore; publications: PublicationStore; llm: BindLLM; now?: () => number };

/** Accepted, not yet drafted candidates of an agent, most important first (what can be drafted now). */
export function draftableCandidates(db: Database.Database, agentId: string) {
  migrateWatchCandidates(db);
  return db.prepare<[string], { storyId: string; title: string | null; importance: number | null }>(`SELECT c.story_id AS storyId, coalesce(s.title, json_extract(c.data, '$.title')) AS title, c.importance
    FROM watch_candidate c LEFT JOIN watch_story s ON s.id = c.story_id WHERE c.agent_id = ? AND c.status = 'accepted' AND c.topic_id IS NOT NULL ORDER BY c.importance DESC, c.updated_at DESC LIMIT 20`).all(agentId);
}

export async function generatePublication({ db, accounts, topics, publications, llm, now = Date.now }: Deps, owner: string, agentId: string, input: unknown) {
  const request = generateRequestSchema.parse(input);
  const account = await accounts.getOwned(owner, agentId);
  const agent = (await accounts.watchAgents()).find(item => item.id === agentId && item.owner === owner);
  if (!account.editorial?.active || !agent?.active) throw new TopicError("Complétez et activez le ΞAgent avant de générer.", 409);
  if (agent.watch.policy.paused) throw new TopicError("ΞAgent en pause : reprenez-le avant de générer.", 409);

  const storyId = request.storyId ?? draftableCandidates(db, agentId)[0]?.storyId;
  if (!storyId) throw new TopicError("Aucune information vérifiée et retenue pour ce ΞAgent. Lancez une veille (collecte puis analyse) : seules des informations collectées et vérifiées peuvent être rédigées.", 409);
  const candidate = readCandidate(db, agentId, storyId);
  if (!candidate) throw new TopicError("Information introuvable.", 404);
  if (candidate.status === "drafted") throw new TopicError("Cette information a déjà un brouillon : relisez-le dans « Brouillons ».", 409);
  if (candidate.status !== "accepted" || !candidate.topic_id) throw new TopicError("Seules les informations vérifiées et retenues peuvent être rédigées.", 409);

  const runId = `manual-generate:${randomUUID()}`;
  const fail = (message: string, status: number, result: unknown = null) => {
    finishRun(db, runId, "failed", now(), { error: message, log: message, result });
    return new TopicError(message, status);
  };
  const binding = bindSafely(llm, agent);
  startRun(db, { id: runId, agentId, owner, kind: "manual-generate", trigger: "manual", log: `Rédaction demandée par le propriétaire (${request.format}) : ${binding.ok ? describeLLM(binding.resolved) : "modèle non résolu"}.` }, now());
  if (!binding.ok) throw fail(`Configuration du modèle (${binding.code}) : ${binding.message}`, 409);

  const used = { model: binding.resolved.model, instance: binding.resolved.instance.name, instanceSource: binding.resolved.instanceSource };
  const data = JSON.parse(candidate.data) as Record<string, unknown>;
  // A fresh drafting state: attempts of the autonomous circuit may have targeted another format.
  const drafting = { attempts: [] };
  try {
    const written = await writeCandidateDraft({ db, accounts, topics, publications, now }, { agent, storyId, candidate, binding, drafting, data, format: request.format, persist: () => {} });
    // A non-compliant draft is reported, the candidate stays available (unlike the worker, which holds it).
    if (written.outcome === "held") throw fail(written.reason, 422, { storyId, llm: used });
    finishRun(db, runId, "done", now(), { log: `Brouillon privé prêt pour relecture : ${written.format === "thread" ? `thread de ${written.messages} messages` : "post"}. Aucune publication.`, result: { outcome: "drafted", storyId, draftId: written.id, format: written.format, llm: used } });
    return { draft: { id: written.id, revision: written.revision, format: written.format, messages: written.messages }, storyId, llm: used, runId };
  } catch (error) {
    if (error instanceof TopicError) throw error;
    const describe = describeLLM(binding.resolved);
    if (error instanceof InferenceUnavailableError) throw fail(`${error.message} (${describe})`, 503, { code: error.code });
    if (error instanceof InferenceConfigError) throw fail(`${error.message} (${describe})`, 409, { code: error.code });
    if (error instanceof InferenceOutputError) throw fail(`${error.message} (${describe})`, 422, { code: error.code });
    finishRun(db, runId, "failed", now(), { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error), log: "Échec inattendu de la rédaction." });
    throw error;
  }
}
