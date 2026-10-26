import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { WatchAgent } from "../accounts/types";
import { TopicError } from "../topics/types";
import { DEFAULT_FORMAT, formatOverridesSchema, formatSettingsSchema, resolveFormat, type FormatSettings } from "./format";

/**
 * The owner's global publication limits (SQLite, like the LLM settings: "global" is per account).
 * Absent row = built-in defaults. Optimistic on `revision` (null before the first save).
 */
export function migratePublicationFormat(db: Database.Database) {
  db.exec("CREATE TABLE IF NOT EXISTS publication_format (owner TEXT PRIMARY KEY, settings TEXT NOT NULL, revision TEXT NOT NULL, updated_at TEXT NOT NULL)");
}

/** `valid: false`: a stored value is unreadable; the defaults apply until the owner saves again. */
export type OwnerFormat = { format: FormatSettings; revision: string | null; valid: boolean; defaults: FormatSettings };

export function ownerFormat(db: Database.Database, owner: string): OwnerFormat {
  migratePublicationFormat(db);
  const row = db.prepare<[string], { settings: string; revision: string }>("SELECT settings, revision FROM publication_format WHERE owner = ?").get(owner);
  // A row written by a newer version keeps its known fields.
  const parsed = row ? formatSettingsSchema.safeParse({ ...DEFAULT_FORMAT, ...pick(JSON.parse(row.settings)) }) : null;
  return { format: parsed?.success ? parsed.data : DEFAULT_FORMAT, revision: row?.revision ?? null, valid: !parsed || parsed.success, defaults: DEFAULT_FORMAT };
}
const pick = (raw: unknown) => Object.fromEntries(Object.entries(typeof raw === "object" && raw ? raw : {}).filter(([key]) => key in DEFAULT_FORMAT));

export function setOwnerFormat(db: Database.Database, owner: string, input: unknown): OwnerFormat {
  const parsed = z.object({ revision: z.uuid().nullable(), format: formatSettingsSchema }).strict().safeParse(input);
  if (!parsed.success) {
    // Inconsistent limits are explained; any other invalid field is a plain validation error.
    const consistency = parsed.error.issues.filter(issue => issue.code === "custom").map(issue => issue.message);
    if (consistency.length) throw new TopicError(consistency.join(" "));
    throw parsed.error;
  }
  const data = parsed.data;
  return db.transaction(() => {
    if (ownerFormat(db, owner).revision !== data.revision) throw new TopicError("Les limites de publication ont été modifiées depuis votre lecture. Rechargez.", 409);
    db.prepare(`INSERT INTO publication_format (owner, settings, revision, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(owner) DO UPDATE SET settings = excluded.settings, revision = excluded.revision, updated_at = excluded.updated_at`)
      .run(owner, JSON.stringify(data.format), randomUUID(), new Date().toISOString());
    return ownerFormat(db, owner);
  }).immediate();
}

/** Refuses agent overrides that would be inconsistent once merged onto the owner's current limits. */
export function assertAgentFormat(db: Database.Database, owner: string, overrides: unknown) {
  const parsed = formatOverridesSchema.safeParse(overrides);
  if (!parsed.success) return; // the policy schema reports it
  const resolved = resolveFormat(ownerFormat(db, owner).format, parsed.data);
  if (!resolved.ok) throw new TopicError(`Limites de publication incohérentes : ${resolved.problems.join(" ")}`);
}

/** The limits that apply to an agent now: its overrides on its owner's global limits. */
export const agentFormat = (db: Database.Database, agent: Pick<WatchAgent, "owner" | "watch">) =>
  resolveFormat(ownerFormat(db, agent.owner).format, agent.watch.policy.format);
