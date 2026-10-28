import { createWatchLogger } from "../src/lib/watch/events";
import Database from "better-sqlite3";
import { resolve } from "node:path";
import { createAccountStore } from "../src/lib/accounts/store";
import type { WatchAgent } from "../src/lib/accounts/types";
import { createPublicationStore } from "../src/lib/publications/store";
import { openVault, vaultPathFromEnv } from "../src/lib/publications/vault";
import { createTopicDiscovery, DISCOVERY_JOB } from "../src/lib/topics/discovery";
import { createTopicRelationStore } from "../src/lib/topics/relations";
import { createTopicStore } from "../src/lib/topics/store";
import { TopicError } from "../src/lib/topics/types";
import { createLLMRuntime } from "../src/lib/llm/server";
import { agentLLMSettings, bindSafely, shouldPlanInference } from "../src/lib/watch/llm-binding";
import { createPoliteFetch, createSafeFetch } from "../src/lib/watch/net";
import { watchDiagnostics } from "../src/lib/watch/diagnostics";
import { createSourceStore } from "../src/lib/watch/sources";
import { engineHandlers, recordWorker, reevaluate, tick, type Handler } from "../src/lib/watch/worker";

/**
 * One short, idempotent pass of the watch engine, run by a systemd timer (see docs/watch.md).
 * XI_WATCH_DISABLED=true stops it; automatic publication requires XI_WATCH_AUTOPUBLISH=true
 * and stays off until the engine's tests are complete.
 *
 * `reevaluate <agent> [storyId]`: relaunches one candidate, or every held candidate of the agent
 * (id or handle), and runs only their evaluation jobs: never a draft or a publication.
 * `explain <agent>`: read-only, where each recent candidate stops on the way to a publication.
 */
const logger = createWatchLogger();

async function main() {
  const [command, agentRef, storyId] = process.argv.slice(2);
  if (command !== "tick" && !((command === "reevaluate" || command === "explain") && agentRef)) {
    console.error("Usage: watch-worker tick | watch-worker reevaluate <agent> [storyId] | watch-worker explain <agent>");
    process.exitCode = 2;
    return;
  }
  if (process.env.XI_WATCH_DISABLED === "true") {
    console.log(JSON.stringify({ disabled: true }));
    return;
  }
  const db = new Database(resolve(process.env.AUTH_DATABASE_PATH || "./data/xi-auth.sqlite"), { fileMustExist: true });
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  try {
    const vault = await openVault(vaultPathFromEnv());
    const topics = createTopicStore({ vault, db });
    const accounts = createAccountStore({ vault, db, topics });
    const publications = createPublicationStore({ vault, db });
    const sources = createSourceStore({ vault, topics });
    const fetch = createPoliteFetch({ db, fetch: createSafeFetch() });
    const now = () => new Date();
    // Local inference only, resolved per agent: its own choice, else its owner's global
    // configuration (or the operator's XI_INFERENCE_URL server), else an explicit problem in the
    // run history. Never a fallback to another instance, model or provider; collection is unaffected.
    const runtime = createLLMRuntime({ db });
    const llm = (agent: WatchAgent) => runtime.bind(agent.owner, agentLLMSettings(agent));
    // Both flags are off unless the operator sets them; each agent must also enable its autonomous mode.
    const settings = { autoPublish: process.env.XI_WATCH_AUTOPUBLISH === "true", allowPublic: process.env.XI_WATCH_AUTOPUBLISH_PUBLIC === "true" };
    // Topic discovery: public publications only, the author's (or the ΞAgent owner's) local model, never a cloud one.
    const discovery = createTopicDiscovery({
      vault, topics, publications, relations: createTopicRelationStore({ vault, db, topics }), now,
      llm: owner => bindSafely(() => runtime.bind(owner, null), null),
      ownerOf: async ({ authorId, authorType }) => authorType === "human" ? authorId : (await accounts.watchAgents()).find(agent => agent.id === authorId)?.owner ?? null,
      autoAccept: process.env.XI_TOPIC_AUTOACCEPT === "true",
    });
    const handlers: Record<string, Handler> = { ...engineHandlers({ db, accounts, topics, publications, sources, fetch, llm, settings, now }), [DISCOVERY_JOB]: discovery.handler };
    const inferenceConcurrency = positive(process.env.XI_INFERENCE_CONCURRENCY, 1);
    if (command === "explain") {
      const handle = agentRef.replace(/^@/, "").toLowerCase();
      const agent = (await accounts.watchAgents()).find(item => item.id === agentRef || item.handle.toLowerCase() === handle);
      if (!agent) { console.error(`ΞAgent introuvable : ${agentRef}.`); process.exitCode = 1; return; }
      const report = await watchDiagnostics({ db, accounts, sources, publications, owner: agent.owner, agentId: agent.id, ...settings });
      console.log(JSON.stringify({
        agent: agent.handle, running: report.running, nextWindow: report.nextWindow, publishBlocks: report.publishBlocks,
        candidates: report.candidates.map(candidate => ({ title: candidate.title, status: candidate.status, lane: candidate.lane, importance: candidate.importance, updatedAt: candidate.updatedAt, blocker: candidate.blocker })),
      }, null, 2));
      return;
    }
    if (command === "reevaluate") {
      try {
        console.log(JSON.stringify(await reevaluate({ db, accounts, sources, evaluate: handlers["evaluate-story"], agent: agentRef, storyId, now, observer: logger, deadline: Date.now() + 8 * 60_000, inferenceConcurrency }), null, 2));
      } catch (error) {
        // A refused command (agent paused, unknown, candidate not relaunchable) is not a worker failure.
        if (!(error instanceof TopicError)) throw error;
        console.error(error.message);
        process.exitCode = 1;
      }
      return;
    }
    const canEvaluate = (agent: WatchAgent) => shouldPlanInference(bindSafely(llm, agent));
    // Leave room before the next timer run; leases cover a pass that overruns anyway.
    console.log(JSON.stringify(await tick({ db, accounts, sources, handlers, enrichment: discovery, canEvaluate, now, observer: event => logger({ ...event, ...(event.event === "worker.start" ? settings : {}) }), deadline: Date.now() + 8 * 60_000, concurrency: positive(process.env.XI_WATCH_CONCURRENCY, 2), inferenceConcurrency })));
  } finally {
    db.close();
  }
}
main().catch((error) => {
  // Counts and error names only: no paths, content or credentials in the journal.
  console.error("[watch] Detailed error :", error); 
  const name = error instanceof Error ? error.name : "unknown";
  logger({ event: "worker.error", level: "error", status: "error" });
  // Shown on the agent pages; best effort when the database itself is the problem.
  try {
    const db = new Database(resolve(process.env.AUTH_DATABASE_PATH || "./data/xi-auth.sqlite"), { fileMustExist: true });
    try { recordWorker(db, { at: Date.now(), error: `Échec du passage : ${name}` }); } finally { db.close(); }
  } catch { /* nothing more to report */ }
  process.exitCode = 1;
});

/** Bounded positive integer from the environment (1–16), else the default. */
function positive(value: string | undefined, fallback: number) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 && number <= 16 ? number : fallback;
}
