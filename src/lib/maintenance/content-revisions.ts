// One-time move of analysis references from the exact revision of a publication (file names and bytes) to its content
// revision (vault.ts contentRevision). The content is the same, so the analyses still hold: Konstruktor's knowledge
// stays visible, completed or failed analyses are not planned again, discovery records stay current.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { PUBLICATION_ID, writeAtomic } from "../publications/vault";

const DONE = "content_revision_migration";
const table = (db: Database.Database, name: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

/**
 * Runs after a reconciliation, once per database (flag in `xi_index_meta`). Only references equal to the exact revision
 * of the publication's current files are moved: an older revision was already stale and stays so.
 */
export async function migrateContentRevisions(db: Database.Database, vaultRoot: string) {
  if (db.prepare("SELECT 1 FROM xi_index_meta WHERE key = ?").get(DONE)) return null;
  // Loaded only when the migration runs: the publication store calling it stays free of these modules.
  const [{ knowledgeRequestId }, { SYSTEM_TASK_KIND }, { DISCOVERY_JOB }] = await Promise.all([import("../konstruktor/pipelines"), import("../watch/orchestrator"), import("../topics/discovery")]);
  const rows = db.prepare<[], { id: string; revision: string; content_revision: string }>("SELECT id, revision, content_revision FROM publication WHERE revision != '' AND content_revision != ''").all();
  const map = new Map(rows.map(row => [row.id, { from: row.revision, to: row.content_revision }]));
  const moved = { knowledge: 0, jobs: 0, pipelineJobs: 0, discovery: 0 };

  // Discovery records live in the vault (`topic-discovery/<publication>.md`); only their `revision:` line changes.
  const dir = join(vaultRoot, "topic-discovery");
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const id = name.replace(/\.md$/, ""), change = map.get(id);
    if (!PUBLICATION_ID.test(id) || !change) continue;
    const text = await readFile(join(dir, name), "utf8");
    const updated = text.replace(new RegExp(`^revision: ["']?${change.from}["']?$`, "m"), `revision: ${change.to}`);
    if (updated !== text) { await writeAtomic(join(dir, name), updated); moved.discovery++; }
  }

  db.transaction(() => {
    if (db.prepare("SELECT 1 FROM xi_index_meta WHERE key = ?").get(DONE)) return;
    if (table(db, "xi_agent_knowledge")) {
      const update = db.prepare("UPDATE xi_agent_knowledge SET revision = ? WHERE publication = ? AND revision = ?");
      for (const [id, { from, to }] of map) moved.knowledge += update.run(to, id, from).changes;
    }
    const keys = new Map<string, string>();
    if (table(db, "watch_job")) {
      const jobs = db.prepare<[], { id: string; kind: string; key: string; payload: string }>("SELECT id, kind, key, payload FROM watch_job").all();
      const update = db.prepare("UPDATE watch_job SET key = ?, payload = ? WHERE id = ?");
      const taken = db.prepare<[string, string]>("SELECT 1 FROM watch_job WHERE key = ? AND id != ?");
      for (const job of jobs) {
        // Konstruktor's analysis task, or a discovery job: the fields that name a publication revision.
        const payload = JSON.parse(job.payload) as { task?: string; owner: string; requestId?: string; input?: { publication: string; agent: string; revision: string }; publicationId?: string; revision?: string };
        let key = job.key;
        if (job.kind === SYSTEM_TASK_KIND && payload.task === "publication-knowledge" && payload.input) {
          const change = map.get(payload.input.publication);
          if (!change || payload.input.revision !== change.from) continue;
          payload.input.revision = change.to;
          // The worker's automatic task is named after the revision: renamed with it, so it is found again.
          const old = knowledgeRequestId(payload.owner, payload.input.agent, payload.input.publication, change.from);
          if (payload.requestId === old) {
            payload.requestId = knowledgeRequestId(payload.owner, payload.input.agent, payload.input.publication, change.to);
            key = job.key.replace(old, payload.requestId);
          }
        } else if (job.kind === DISCOVERY_JOB) {
          const change = map.get(payload.publicationId ?? "");
          if (!change || payload.revision !== change.from) continue;
          payload.revision = change.to;
          key = job.key.replace(change.from, change.to);
        } else continue;
        // The analysis of this content may already exist under its new name (planned since): this one keeps its own.
        if (key !== job.key && taken.get(key, job.id)) key = job.key;
        update.run(key, JSON.stringify(payload), job.id);
        if (key !== job.key) keys.set(job.key, key);
        moved.jobs++;
      }
    }
    if (table(db, "konstruktor_pipeline_job")) {
      const jobs = db.prepare<[], { run_id: string; publication: string; revision: string | null; job_key: string | null; previous_keys: string }>("SELECT run_id, publication, revision, job_key, previous_keys FROM konstruktor_pipeline_job").all();
      const update = db.prepare("UPDATE konstruktor_pipeline_job SET revision = ?, job_key = ?, previous_keys = ? WHERE run_id = ? AND publication = ?");
      for (const job of jobs) {
        const change = map.get(job.publication);
        const revision = change && job.revision === change.from ? change.to : job.revision;
        const jobKey = job.job_key ? keys.get(job.job_key) ?? job.job_key : null;
        const previous = JSON.stringify((JSON.parse(job.previous_keys) as string[]).map(key => keys.get(key) ?? key));
        if (revision === job.revision && jobKey === job.job_key && previous === job.previous_keys) continue;
        update.run(revision, jobKey, previous, job.run_id, job.publication);
        moved.pipelineJobs++;
      }
    }
    db.prepare("INSERT INTO xi_index_meta (key, value) VALUES (?, ?)").run(DONE, new Date().toISOString());
  }).immediate();
  return moved;
}
