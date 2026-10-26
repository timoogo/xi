import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { AccountStore } from "../accounts/store";
import { TopicError } from "../topics/types";
import { prepareDraft } from "../watch/drafting";
import { relaunchEvaluation, relaunchHeld } from "../watch/evaluate";
import { createJobQueue, PRIORITY } from "../watch/jobs";
import { catchUp, finishRun, grant, startRun } from "../watch/orchestrator";
import type { SourceStore } from "../watch/sources";

/**
 * Owner commands of a ΞAgent: pause (indefinite or until a date, with the resume choice recorded),
 * resume (from now, or with a bounded catch-up), and one-off manual runs. Manual runs never change
 * the automatic mode and never publish: they only queue monitoring work for the worker.
 * Every command leaves a row in the execution history.
 */
const HOUR = 3_600_000;
type Deps = { db: Database.Database; accounts: AccountStore; sources: SourceStore; now?: () => Date };

async function ownedAgent(accounts: AccountStore, owner: string, id: string) {
  await accounts.getOwned(owner, id);
  const agent = (await accounts.watchAgents()).find(item => item.id === id && item.owner === owner);
  if (!agent) throw new TopicError("Complétez la configuration éditoriale de ce ΞAgent.", 409);
  return agent;
}

export const controlSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("pause"), resumeAt: z.iso.datetime().nullable(), resumeWith: z.enum(["now", "catch-up"]) }).strict(),
  z.object({ action: z.literal("resume"), resumeWith: z.enum(["now", "catch-up"]) }).strict(),
  z.object({ action: z.literal("run"), task: z.enum(["watch", "reanalyze-held"]), storyId: z.undefined().optional() }).strict(),
]).or(z.object({ action: z.literal("run"), task: z.enum(["reanalyze", "prepare"]), storyId: z.string().min(1).max(200) }).strict());

export async function control({ db, accounts, sources, now = () => new Date() }: Deps, owner: string, id: string, input: unknown) {
  const command = controlSchema.parse(input);
  const at = now().getTime();
  const agent = await ownedAgent(accounts, owner, id);
  const record = (kind: string, log: string, result: unknown = null) => {
    const runId = `${kind}:${randomUUID()}`;
    startRun(db, { id: runId, agentId: id, owner, kind, trigger: "manual", log: "Commande du propriétaire." }, at);
    finishRun(db, runId, "done", at, { log, result });
    return runId;
  };

  if (command.action === "pause") {
    const pause = await accounts.pauseAgent(owner, id, { resumeAt: command.resumeAt, resumeWith: command.resumeWith }, now());
    const log = pause.resumeAt ? `Pause jusqu’au ${pause.resumeAt}, reprise ${pause.resumeWith === "catch-up" ? "avec rattrapage" : "à partir de ce moment"}.` : "Pause indéfinie : aucune veille ni publication, événements majeurs compris.";
    return { pause, runId: record("pause", log, pause) };
  }
  if (command.action === "resume") {
    const ended = await accounts.resumeAgent(owner, id, { resumeWith: command.resumeWith });
    if (!ended) throw new TopicError("Ce ΞAgent n’est pas en pause.", 409);
    const fresh = (await accounts.watchAgents()).find(item => item.id === id)!;
    const caught = command.resumeWith === "catch-up" && ended.since ? catchUp(db, fresh, Date.parse(ended.since), at, "Reprise manuelle avec rattrapage.") : null;
    const log = command.resumeWith === "catch-up" ? (caught ? `Reprise avec rattrapage. ${caught.reason}` : "Reprise : aucune plage de veille manquée à rattraper.") : "Reprise à partir de maintenant, sans rattrapage.";
    return { resumed: true, catchUp: caught, runId: record("resume", log) };
  }

  // Manual runs: the agent must be running (a pause blocks them like everything else).
  if (agent.watch.policy.paused) throw new TopicError("ΞAgent en pause : reprenez-le avant une exécution manuelle.", 409);
  if (!agent.active || !agent.watch.valid || !agent.watch.policy.enabled) throw new TopicError("Veille inactive : activez le ΞAgent avant une exécution manuelle.", 409);
  const queue = createJobQueue(db, () => now().getTime());
  const runId = randomUUID();
  if (command.task === "watch") {
    // One hour of monitoring outside the calendar: collection now, then evaluation and drafting by the next passes.
    grant(db, { id: `manual:${runId}`, agentId: id, owner, kind: "manual", from: at, until: at + HOUR, reason: "Veille lancée manuellement." }, at);
    const topics = new Set([agent.primaryTopicId, ...agent.secondaryTopicIds]);
    const collectable = (await sources.collectable()).filter(source => source.owner === owner && source.topicIds.some(topic => topics.has(topic)));
    for (const source of collectable) queue.enqueue({ kind: "collect-source", key: `collect-source:manual:${runId}:${source.id}`, payload: { sourceId: source.id, owner, agentId: id, trigger: "manual" }, runAfter: at, maxAttempts: 3, priority: PRIORITY.manual });
    const log = collectable.length ? `Veille manuelle : ${collectable.length} collecte(s) planifiée(s) ; évaluation et rédaction autorisées hors calendrier pendant 1 h. Exécution au prochain passage du worker.` : "Veille manuelle : aucune source approuvée ou en attente à collecter.";
    return { runId: record("manual-watch", log, { sources: collectable.length, until: new Date(at + HOUR).toISOString() }), planned: collectable.length };
  }
  if (command.task === "reanalyze-held") {
    const { relaunched, skipped } = relaunchHeld(db, queue, agent, at, runId);
    const log = `${relaunched.length} analyse(s) suspendue(s) relancée(s)${skipped.length ? `, ${skipped.length} écartée(s) : ${skipped.map(entry => entry.reason).join(" ; ")}` : ""}. Évaluation par le pipeline normal ; aucune publication.`;
    return { runId: record("manual-reanalyze-held", log, { relaunched, skipped }), relaunched, skipped };
  }
  if (command.task === "reanalyze" && command.storyId) {
    const { previous } = relaunchEvaluation(db, queue, agent, command.storyId, at, runId);
    return { runId: record("manual-reanalyze", `Analyse relancée (état précédent : ${previous.status}${previous.reason ? ` — ${previous.reason}` : ""}).`, { storyId: command.storyId, previous }) };
  }
  if (!command.storyId) throw new TopicError("Actualité manquante.", 422);
  prepareDraft(db, queue, agent, command.storyId, at, runId);
  return { runId: record("manual-draft", "Préparation d’un brouillon privé à partir des affirmations vérifiées. Aucune publication : relecture requise.", { storyId: command.storyId }) };
}
