import type Database from "better-sqlite3";
import { TopicError } from "../topics/types";

/**
 * Owner of the instance: the only account that may configure the system ΞAgents. Ξ is a personal,
 * single-user instance: there are no roles. The owner is chosen once, at initialisation (the first
 * account created), then kept in the local configuration (`xi_instance`, in the application database
 * beside the accounts it refers to) and never recomputed.
 *
 * If that account disappears, nobody inherits its permissions: configuration is refused to everyone
 * until an explicit local recovery (`pnpm instance:owner recover <email>`, scripts/instance-owner.ts).
 */
export type InstanceOwner =
  | { status: "uninitialized" }
  | { status: "ok" | "missing"; ownerId: string; source: "first-account" | "recovery"; initializedAt: number; updatedAt: number };
type Row = { owner_id: string; source: "first-account" | "recovery"; initialized_at: number; updated_at: number };

export function migrateInstanceOwner(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS xi_instance (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    owner_id TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('first-account', 'recovery')),
    previous_owner_id TEXT,
    initialized_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
}

const hasUsers = (db: Database.Database) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'user'").get();
const userExists = (db: Database.Database, id: string) => hasUsers(db) && !!db.prepare(`SELECT 1 FROM "user" WHERE id = ?`).get(id);
const read = (db: Database.Database) => db.prepare<[], Row>("SELECT owner_id, source, initialized_at, updated_at FROM xi_instance WHERE id = 1").get();

/** Initialisation only: an existing row is never replaced, so a later, older or remaining account never takes over. */
const initialize = (db: Database.Database, now: number) => db.transaction(() => {
  if (read(db) || !hasUsers(db)) return;
  const first = db.prepare<[], { id: string }>(`SELECT id FROM "user" ORDER BY createdAt, id LIMIT 1`).get();
  if (first) db.prepare("INSERT INTO xi_instance (id, owner_id, source, initialized_at, updated_at) VALUES (1, ?, 'first-account', ?, ?)").run(first.id, now, now);
}).immediate();

/** The recorded owner, initialised on first use once an account exists; `missing` when its account was deleted. */
export function instanceOwner(db: Database.Database, now = Date.now()): InstanceOwner {
  migrateInstanceOwner(db);
  if (!read(db)) initialize(db, now);
  const row = read(db);
  if (!row) return { status: "uninitialized" };
  return { status: userExists(db, row.owner_id) ? "ok" : "missing", ownerId: row.owner_id, source: row.source, initializedAt: row.initialized_at, updatedAt: row.updated_at };
}

export const isInstanceOwner = (db: Database.Database, userId: string) => {
  const owner = instanceOwner(db);
  return owner.status === "ok" && owner.ownerId === userId;
};

/** Refused like any resource of someone else (404), also while the owner is missing. */
export function assertInstanceOwner(db: Database.Database, userId: string) {
  if (!isInstanceOwner(db, userId)) throw new TopicError("Configuration introuvable.", 404);
}

/**
 * Local, explicit recovery (never reachable over HTTP): only when the recorded owner's account no
 * longer exists. Transferring ownership from an existing account is not supported.
 */
export function recoverInstanceOwner(db: Database.Database, email: string, now = Date.now()) {
  migrateInstanceOwner(db);
  if (!hasUsers(db)) throw new TopicError("Aucun compte sur cette instance.", 404);
  const target = db.prepare<[string], { id: string }>(`SELECT id FROM "user" WHERE lower(email) = lower(?)`).get(email.trim());
  if (!target) throw new TopicError("Aucun compte avec cette adresse.", 404);
  return db.transaction(() => {
    const row = read(db);
    if (row && userExists(db, row.owner_id)) throw new TopicError("Le propriétaire de l’instance existe toujours : aucune récupération nécessaire.", 409);
    if (row) db.prepare("UPDATE xi_instance SET owner_id = ?, source = 'recovery', previous_owner_id = ?, updated_at = ? WHERE id = 1").run(target.id, row.owner_id, now);
    else db.prepare("INSERT INTO xi_instance (id, owner_id, source, initialized_at, updated_at) VALUES (1, ?, 'recovery', ?, ?)").run(target.id, now, now);
    return { ownerId: target.id, previousOwnerId: row?.owner_id ?? null };
  }).immediate();
}
