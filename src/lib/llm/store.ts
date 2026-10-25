import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { validateBaseUrl, type DestinationPolicy } from "./network";
import { instanceInputSchema, type ConnectionStatus, type LLMInstance, type LLMSettings, type ModelInfo } from "./types";

/** Configuration error with its HTTP status (404 for another owner's instance: never revealed). */
export class LLMStoreError extends Error {
  name = "LLMStoreError";
  constructor(message: string, readonly status = 400, readonly data: Record<string, unknown> = {}) { super(message); }
}

type Row = {
  id: string; owner: string; type: "ollama"; key: string; name: string; base_url: string; enabled: number; default_model: string | null;
  options: string; status: string; models: string | null; models_at: string | null; revision: string; created_at: string; updated_at: string;
};
const toInstance = (row: Row): LLMInstance => ({
  id: row.id, owner: row.owner, type: row.type, key: row.key, name: row.name, baseUrl: row.base_url, enabled: row.enabled === 1,
  defaultModel: row.default_model, options: JSON.parse(row.options), status: JSON.parse(row.status) as ConnectionStatus,
  models: row.models === null ? null : JSON.parse(row.models) as ModelInfo[], modelsAt: row.models_at,
  revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at,
});

export function migrateLLM(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS llm_instance (
      id TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('ollama')),
      key TEXT NOT NULL,
      name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      default_model TEXT,
      options TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT '{"state":"unknown"}',
      models TEXT,
      models_at TEXT,
      revision TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (owner, key)
    );
    CREATE TABLE IF NOT EXISTS llm_settings (owner TEXT PRIMARY KEY, default_instance_id TEXT, revision TEXT NOT NULL, updated_at TEXT NOT NULL);
  `);
}

/**
 * The owner's LLM instances and default instance ("global" is per account: Ξ has no installation
 * administrator). Every read and write is scoped by owner; another owner's instance is "introuvable".
 * URLs are validated against the destination policy on every write.
 */
export function createLLMStore(db: Database.Database, { policy, now = () => new Date() }: { policy: DestinationPolicy; now?: () => Date }) {
  migrateLLM(db);
  const row = (owner: string, id: string) => z.uuid().safeParse(id).success
    ? db.prepare<[string, string], Row>("SELECT * FROM llm_instance WHERE id = ? AND owner = ?").get(id, owner) ?? null : null;
  const owned = (owner: string, id: string) => {
    const found = row(owner, id);
    if (!found) throw new LLMStoreError("Instance introuvable.", 404);
    return found;
  };
  const keyTaken = (owner: string, key: string, exceptId: string | null) =>
    !!db.prepare<[string, string, string], { id: string }>("SELECT id FROM llm_instance WHERE owner = ? AND key = ? AND id != ?").get(owner, key, exceptId ?? "");
  const normalized = (raw: string) => validateBaseUrl(raw, policy).href;

  function list(owner: string) {
    return db.prepare<[string], Row>("SELECT * FROM llm_instance WHERE owner = ? ORDER BY created_at, name").all(owner).map(toInstance);
  }
  function create(owner: string, input: unknown) {
    const data = instanceInputSchema.parse(input);
    const baseUrl = normalized(data.baseUrl);
    if (keyTaken(owner, data.key, null)) throw new LLMStoreError(`La clé « ${data.key} » est déjà utilisée par une autre instance.`, 409);
    const id = randomUUID();
    const at = now().toISOString();
    db.prepare(`INSERT INTO llm_instance (id, owner, type, key, name, base_url, enabled, default_model, options, revision, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, owner, data.type, data.key, data.name, baseUrl, data.enabled ? 1 : 0, data.defaultModel, JSON.stringify(data.options), randomUUID(), at, at);
    return toInstance(owned(owner, id));
  }
  /** Optimistic on `revision`; a new URL or type resets the connection status and discovered models. */
  function update(owner: string, id: string, input: unknown) {
    const { revision, ...data } = instanceInputSchema.extend({ revision: z.uuid() }).strict().parse(input);
    const current = owned(owner, id);
    if (current.revision !== revision) throw new LLMStoreError("L’instance a été modifiée depuis votre lecture. Rechargez.", 409);
    const baseUrl = normalized(data.baseUrl);
    if (keyTaken(owner, data.key, id)) throw new LLMStoreError(`La clé « ${data.key} » est déjà utilisée par une autre instance.`, 409);
    const moved = baseUrl !== current.base_url || data.type !== current.type;
    db.prepare(`UPDATE llm_instance SET type = ?, key = ?, name = ?, base_url = ?, enabled = ?, default_model = ?, options = ?, revision = ?, updated_at = ?
      ${moved ? ", status = '{\"state\":\"unknown\"}', models = NULL, models_at = NULL" : ""} WHERE id = ? AND owner = ?`)
      .run(data.type, data.key, data.name, baseUrl, data.enabled ? 1 : 0, data.defaultModel, JSON.stringify(data.options), randomUUID(), now().toISOString(), id, owner);
    return toInstance(owned(owner, id));
  }
  /** Dependencies (agents, default) are the caller's decision: see the DELETE route. */
  function remove(owner: string, id: string) {
    owned(owner, id);
    db.prepare("DELETE FROM llm_instance WHERE id = ? AND owner = ?").run(id, owner);
  }
  function settings(owner: string): LLMSettings {
    const found = db.prepare<[string], { default_instance_id: string | null; revision: string }>("SELECT default_instance_id, revision FROM llm_settings WHERE owner = ?").get(owner);
    return { defaultInstanceId: found?.default_instance_id ?? null, revision: found?.revision ?? null };
  }
  /** Optimistic on `revision` (null before the first choice). Only an enabled instance of the owner. */
  function setDefault(owner: string, input: unknown): LLMSettings {
    const data = z.object({ revision: z.uuid().nullable(), defaultInstanceId: z.uuid().nullable() }).strict().parse(input);
    if (settings(owner).revision !== data.revision) throw new LLMStoreError("La configuration globale a été modifiée depuis votre lecture. Rechargez.", 409);
    if (data.defaultInstanceId && owned(owner, data.defaultInstanceId).enabled !== 1) throw new LLMStoreError("Instance désactivée : réactivez-la avant d’en faire l’instance par défaut.");
    db.prepare(`INSERT INTO llm_settings (owner, default_instance_id, revision, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(owner) DO UPDATE SET default_instance_id = excluded.default_instance_id, revision = excluded.revision, updated_at = excluded.updated_at`)
      .run(owner, data.defaultInstanceId, randomUUID(), now().toISOString());
    return settings(owner);
  }
  /** Result of an explicit check; not a configuration edit (the revision is kept). */
  function recordCheck(owner: string, id: string, status: ConnectionStatus, models?: ModelInfo[]) {
    owned(owner, id);
    if (models) db.prepare("UPDATE llm_instance SET status = ?, models = ?, models_at = ? WHERE id = ? AND owner = ?").run(JSON.stringify(status), JSON.stringify(models), now().toISOString(), id, owner);
    else db.prepare("UPDATE llm_instance SET status = ? WHERE id = ? AND owner = ?").run(JSON.stringify(status), id, owner);
    return toInstance(owned(owner, id));
  }
  return {
    list, create, update, remove, settings, setDefault, recordCheck,
    get: (owner: string, id: string) => { const found = row(owner, id); return found ? toInstance(found) : null; },
    byKey: (owner: string, key: string) => { const found = db.prepare<[string, string], Row>("SELECT * FROM llm_instance WHERE owner = ? AND key = ?").get(owner, key); return found ? toInstance(found) : null; },
  };
}
export type LLMStore = ReturnType<typeof createLLMStore>;
