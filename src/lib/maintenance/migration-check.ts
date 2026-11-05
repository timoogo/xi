import { createHash } from "node:crypto";
import { cp, mkdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import Database from "better-sqlite3";
import { createAccountStore } from "../accounts/store";
import { migrateArbitrations } from "../arbiter/arbitration";
import { migrateAvatarPreferences } from "../avatar-preferences";
import { migrateGraphIndex } from "../graph/index-db";
import { migrateKonstruktor } from "../konstruktor/store";
import { migrateSuggestions } from "../konstruktor/suggestions";
import { migrateLLM } from "../llm/store";
import { migratePublicationIndex } from "../publications/index-db";
import { createPublicationStore } from "../publications/store";
import { openVault } from "../publications/vault";
import { migrateInstanceOwner } from "../system-agents/owner";
import { migrateSystemAgents } from "../system-agents/store";
import { createTopicStore } from "../topics/store";
import { migrateWatchCollection } from "../watch/collect";
import { migrateWatchCandidates } from "../watch/evaluate";
import { migratePublicationFormat } from "../watch/format-store";
import { migrateWatchJobs } from "../watch/jobs";
import { migrateWatchHosts } from "../watch/net";
import { migrateOrchestrator } from "../watch/orchestrator";
import { migrateWatchDecisions } from "../watch/publisher";
import { migrateEditorialQueue, syncEditorialQueue } from "../watch/queue";
import { migrateWatchItems } from "../watch/stories";
import { migrateSourceTrust } from "../watch/trust";
import { migrateWatchWorker } from "../watch/worker";
import { migrateAgentPins } from "../xiagents/pins";

/**
 * Every application schema (Better Auth's own tables aside), in dependency order. Each step only
 * creates or adds (tables, columns, indexes) and is idempotent: the services also run theirs lazily,
 * so an old process keeps working on an expanded schema and a rollback finds nothing removed.
 */
export function migrateSchemas(db: Database.Database) {
  for (const migrate of [
    migrateAvatarPreferences, migratePublicationIndex, migrateGraphIndex, migrateWatchJobs, migrateOrchestrator, migrateWatchWorker, migrateSystemAgents, migrateInstanceOwner,
    migrateLLM, migrateWatchHosts, migrateWatchItems, migrateWatchCollection, migrateSourceTrust, migrateWatchCandidates, migrateWatchDecisions, migrateEditorialQueue,
    migrateArbitrations, migratePublicationFormat, migrateKonstruktor, migrateSuggestions, migrateAgentPins,
  ]) migrate(db);
}

/** Indexes rebuilt from the vault at any time: their row counts follow the Markdown files, not the migration. */
const DERIVED = new Set(["publication", "publication_message", "publication_topic", "publication_fts", "feed_follow", "feed_managed_agent", "graph_generator", "graph_relation", "topic_index", "topic_relation", "topic_relation_basis", "topic_routing", "topic_tag", "xi_index_meta"]);

type Snapshot = { counts: Record<string, number>; schema: string };
function snapshot(db: Database.Database): Snapshot {
  const objects = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all() as { type: string; name: string; sql: string | null }[];
  const counts: Record<string, number> = {};
  for (const { type, name } of objects) {
    // FTS shadow tables are counted through their virtual table.
    if (type === "table" && !/_(data|idx|docsize|config|content)$/.test(name)) counts[name] = db.prepare(`SELECT count(*) FROM "${name.replaceAll('"', '""')}"`).pluck().get() as number;
  }
  return { counts, schema: createHash("sha256").update(JSON.stringify(objects)).digest("hex") };
}

const inside = (child: string, parent: string) => { const path = relative(parent, child); return path === "" || (!path.startsWith("..") && !path.startsWith(sep) && path !== ".."); };

export type MigrationCheck = {
  ok: boolean; problems: string[]; notes: string[];
  copy: { database: string; vault: string };
  before: Record<string, number>; after: Record<string, number>;
  queue: { ready: number; drafted: number }; agents: { total: number; invalid: number }; publications: number;
};

/**
 * Migration rehearsal on a copy, never on the originals: the database is copied with SQLite's online
 * backup (consistent even while the app runs; the source is opened read-only) and the vault with its
 * timestamps; every migration then runs on the copy, twice, followed by the checks a deployment
 * relies on. `authMigrate` runs Better Auth's migrations on the copied file when given.
 */
export async function checkMigrationOnCopy({ database, vault, workDir, now = Date.now(), authMigrate }: {
  database: string; vault: string; workDir: string; now?: number; authMigrate?: (copy: string) => Promise<void>;
}): Promise<MigrationCheck> {
  const [source, sourceVault, work] = [resolve(database), resolve(vault), resolve(workDir)];
  if (inside(work, sourceVault) || inside(work, resolve(source, "..")) || inside(sourceVault, work)) throw new Error("Le répertoire de travail doit être distinct de la base et du vault d’origine.");
  await mkdir(work, { recursive: true });
  const copy = { database: join(work, "xi.sqlite"), vault: join(work, "vault") };
  const original = new Database(source, { readonly: true, fileMustExist: true });
  try { await original.backup(copy.database); } finally { original.close(); }
  await cp(sourceVault, copy.vault, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false });

  const problems: string[] = [];
  const notes: string[] = [];
  const baseline = new Database(copy.database, { readonly: true });
  let before: Snapshot;
  try { before = snapshot(baseline); } finally { baseline.close(); }
  if (authMigrate) await authMigrate(copy.database);
  const db = new Database(copy.database);
  try {
    db.pragma("foreign_keys = ON");
    migrateSchemas(db);
    // The projections a pass maintains: the Markdown index, then the editorial queue.
    const openedVault = await openVault(copy.vault);
    const topics = createTopicStore({ vault: openedVault, db });
    const accounts = createAccountStore({ vault: openedVault, db, topics });
    const publications = createPublicationStore({ vault: openedVault, db, now: () => new Date(now) });
    await topics.list();
    const agents = await accounts.watchAgents();
    await publications.reconcileAll();
    syncEditorialQueue(db, now);
    const after = snapshot(db);

    // Idempotence: a second run (another process, a retry) changes nothing.
    migrateSchemas(db);
    syncEditorialQueue(db, now);
    const again = snapshot(db);
    if (again.schema !== after.schema) problems.push("Une seconde migration modifie encore le schéma (migration non idempotente).");
    for (const [table, count] of Object.entries(after.counts)) if (again.counts[table] !== count) problems.push(`Une seconde migration modifie la table ${table} (${count} → ${again.counts[table]}).`);

    const integrity = db.pragma("integrity_check", { simple: true });
    if (integrity !== "ok") problems.push(`Intégrité SQLite : ${String(integrity)}.`);
    const foreign = db.pragma("foreign_key_check") as unknown[];
    if (foreign.length) problems.push(`${foreign.length} référence(s) étrangère(s) invalide(s).`);
    for (const [table, count] of Object.entries(before.counts)) {
      if (!(table in after.counts)) problems.push(`Table supprimée par la migration : ${table}.`);
      else if (after.counts[table] < count) (DERIVED.has(table) ? notes : problems).push(`${table} : ${count} → ${after.counts[table]} ligne(s)${DERIVED.has(table) ? " (index reconstruit depuis le vault)" : " (perte de données)"}.`);
    }
    for (const table of Object.keys(after.counts)) if (!(table in before.counts)) notes.push(`Table créée : ${table}.`);

    // Markdown ↔ SQLite ↔ projection: every validated draft is in the queue; agents parse.
    const drafted = db.prepare("SELECT count(*) FROM watch_candidate WHERE status = 'drafted' AND lane IN ('night', 'immediate') AND json_extract(data, '$.draft.id') IS NOT NULL AND json_extract(data, '$.draft.revision') IS NOT NULL").pluck().get() as number;
    const queued = db.prepare("SELECT count(*) FROM watch_candidate c JOIN editorial_queue q ON q.draft_id = json_extract(c.data, '$.draft.id') WHERE c.status = 'drafted' AND c.lane IN ('night', 'immediate') AND json_extract(c.data, '$.draft.revision') IS NOT NULL").pluck().get() as number;
    if (queued !== drafted) problems.push(`${drafted - queued} brouillon(s) validé(s) absent(s) de la queue éditoriale.`);
    const ready = db.prepare("SELECT count(*) FROM editorial_queue WHERE state = 'ready'").pluck().get() as number;
    const invalid = agents.filter(agent => !agent.watch.valid).length;
    if (invalid) notes.push(`${invalid} ΞAgent(s) avec une configuration de veille invalide : ils ne seront pas planifiés tant qu’elle n’est pas corrigée.`);
    const legacyJobs = db.prepare("SELECT count(*) FROM watch_job WHERE kind = 'publication-window' AND state IN ('pending', 'running')").pluck().get() as number;
    if (legacyJobs) notes.push(`${legacyJobs} fenêtre(s) de publication historique(s) planifiée(s) : sans effet en mode queue, reprises en cas de retour au mode legacy.`);
    return {
      ok: problems.length === 0, problems, notes, copy, before: before.counts, after: after.counts,
      queue: { ready, drafted }, agents: { total: agents.length, invalid }, publications: db.prepare("SELECT count(*) FROM publication").pluck().get() as number,
    };
  } finally {
    db.close();
  }
}
