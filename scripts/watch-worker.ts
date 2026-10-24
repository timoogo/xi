import Database from "better-sqlite3";
import { resolve } from "node:path";
import { createAccountStore } from "../src/lib/accounts/store";
import { createPublicationStore } from "../src/lib/publications/store";
import { openVault, vaultPathFromEnv } from "../src/lib/publications/vault";
import { createTopicStore } from "../src/lib/topics/store";
import { createLocalInference, inferenceConfigFromEnv, type Inference } from "../src/lib/watch/inference";
import { createPoliteFetch, createSafeFetch } from "../src/lib/watch/net";
import { createSourceStore } from "../src/lib/watch/sources";
import { engineHandlers, recordWorker, tick } from "../src/lib/watch/worker";

/**
 * One short, idempotent pass of the watch engine, run by a systemd timer (see docs/watch.md).
 * XI_WATCH_DISABLED=true stops it; automatic publication requires XI_WATCH_AUTOPUBLISH=true
 * and stays off until the engine's tests are complete.
 */
async function main() {
  if (process.argv[2] !== "tick") {
    console.error("Usage: watch-worker tick");
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
    // Local inference only. A refused configuration (non-local address) disables evaluation,
    // never collection, and never falls back to another provider.
    let inference: Inference | null = null;
    let defaultModel: string | null = null;
    try {
      const config = inferenceConfigFromEnv();
      if (config) { inference = createLocalInference(config); defaultModel = config.defaultModel; }
    } catch (error) {
      console.error("Watch inference configuration refused", error instanceof Error ? error.message : "unknown");
    }
    // Both flags are off unless the operator sets them; each agent must also enable its autonomous mode.
    const settings = { autoPublish: process.env.XI_WATCH_AUTOPUBLISH === "true", allowPublic: process.env.XI_WATCH_AUTOPUBLISH_PUBLIC === "true" };
    const handlers = engineHandlers({ db, accounts, topics, publications, sources, fetch, inference, defaultModel, settings, now });
    const canEvaluate = (agent: { modelRef: string | null }) => !!inference && !!(agent.modelRef ?? defaultModel);
    // Leave room before the next timer run; leases cover a pass that overruns anyway.
    console.log(JSON.stringify(await tick({ db, accounts, sources, handlers, canEvaluate, now, deadline: Date.now() + 8 * 60_000, concurrency: positive(process.env.XI_WATCH_CONCURRENCY, 2), inferenceConcurrency: positive(process.env.XI_INFERENCE_CONCURRENCY, 1) })));
  } finally {
    db.close();
  }
}
main().catch((error) => {
  // Counts and error names only: no paths, content or credentials in the journal.
  const name = error instanceof Error ? error.name : "unknown";
  console.error("Watch tick failed", name);
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
