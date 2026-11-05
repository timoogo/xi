import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { bloubConfigSchema } from "../bloub/config";
import type { BloubConfig } from "../bloub/types";
import { assertWithin, inside, listDir, writeAtomic, type Vault } from "../publications/vault";
import { locked } from "../topics/lock";
import { TopicError } from "../topics/types";
import { assertInstanceOwner } from "./owner";
import { SYSTEM_AGENTS, systemAgentDefinition, type SystemAgentDefinition, type SystemAgentKind } from "./registry";

/**
 * Persistence of the system ΞAgents (registry.ts). Source of truth: `<vault>/system-agents/<kind>.md`,
 * one file per kind, so a kind exists at most once on disk; `system_agent` is a reconstructible
 * projection whose keys (kind, id, handle) make a duplicate impossible in the database too. Files are
 * created under the cross-process lock of their folder, only when missing: restarts and concurrent
 * processes never duplicate or reset them. An invalid file, or an editorial generator already using a
 * reserved handle, blocks the initialisation with an explicit error and is never overwritten.
 * Configuration (activation, appearance) is reserved to the instance owner (owner.ts).
 */
const storedSchema = z.object({
  id: z.uuid(), kind: z.string().min(1), handle: z.string().min(1), enabled: z.boolean(), bloub: bloubConfigSchema,
  revision: z.uuid(), updatedAt: z.iso.datetime(), updatedBy: z.string().min(1),
}).strict();
type Stored = z.infer<typeof storedSchema>;
export const systemAgentConfigSchema = z.object({ revision: z.uuid(), enabled: z.boolean().optional(), bloub: bloubConfigSchema.optional() }).strict()
  .refine(input => input.enabled !== undefined || input.bloub !== undefined, "Aucune modification.");

export type SystemAgent = Omit<SystemAgentDefinition, "bloub" | "kind"> & { kind: SystemAgentKind; enabled: boolean; bloub: BloubConfig; revision: string; updatedAt: string };

const encode = (value: unknown) => `---\n${stringify(value)}---\n`;
const decode = (text: string) => {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) throw new Error("Markdown invalide.");
  return parse(match[1]);
};

export function migrateSystemAgents(db: Database.Database) {
  db.exec("CREATE TABLE IF NOT EXISTS system_agent (kind TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, handle TEXT NOT NULL UNIQUE, data TEXT NOT NULL)");
}

export function createSystemAgentStore({ vault, db, now = () => new Date() }: { vault: Vault; db: Database.Database; now?: () => Date }) {
  const directory = join(vault.root, "system-agents");
  const generators = join(vault.root, "generators");
  migrateSystemAgents(db);

  async function exclusive<T>(task: () => Promise<T>) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await assertWithin(vault.root, directory);
    return locked(directory, task);
  }
  const fileOf = (kind: string) => inside(directory, `${kind}.md`);

  async function readStored(definition: SystemAgentDefinition): Promise<Stored | null> {
    const path = fileOf(definition.kind);
    let text: string;
    try { await assertWithin(directory, path); text = await readFile(path, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    let stored: Stored;
    try { stored = storedSchema.parse(decode(text)); }
    catch { throw new TopicError(`Fichier d’agent système invalide : system-agents/${definition.kind}.md. Corrigez-le ou supprimez-le pour le recréer.`, 409); }
    if (stored.id !== definition.id || stored.kind !== definition.kind || stored.handle !== definition.handle) {
      throw new TopicError(`Identité incohérente dans system-agents/${definition.kind}.md : identifiant, type et handle sont fixés par Ξ.`, 409);
    }
    return stored;
  }

  /** A reserved handle already used by an editorial generator blocks everything: nothing is written. */
  async function assertNoGeneratorConflict() {
    const taken = new Set((await listDir(generators)).map(entry => entry.name));
    const conflict = SYSTEM_AGENTS.find(agent => taken.has(agent.handle));
    if (conflict) throw new TopicError(`Le handle @${conflict.handle}, réservé à l’agent système « ${conflict.name} », est déjà utilisé par un ΞAgent éditorial (generators/${conflict.handle}). Renommez ce ΞAgent pour activer les agents systèmes.`, 409);
  }

  const toAgent = (definition: SystemAgentDefinition, stored: Stored): SystemAgent => ({
    ...definition, kind: definition.kind as SystemAgentKind, enabled: stored.enabled, bloub: stored.bloub, revision: stored.revision, updatedAt: stored.updatedAt,
  });

  function index(agents: SystemAgent[]) {
    db.transaction(() => {
      db.exec("DELETE FROM system_agent");
      const insert = db.prepare("INSERT INTO system_agent (kind, id, handle, data) VALUES (?, ?, ?, ?)");
      for (const agent of agents) insert.run(agent.kind, agent.id, agent.handle, JSON.stringify(agent));
    })();
  }

  /** Under the lock: creates missing files with the registry defaults, validates the others, refreshes the projection. */
  async function reconcile(): Promise<SystemAgent[]> {
    await assertNoGeneratorConflict();
    const agents: SystemAgent[] = [];
    for (const definition of SYSTEM_AGENTS) {
      let stored = await readStored(definition);
      if (!stored) {
        stored = { id: definition.id, kind: definition.kind, handle: definition.handle, enabled: true, bloub: definition.bloub, revision: randomUUID(), updatedAt: now().toISOString(), updatedBy: "system" };
        await writeAtomic(fileOf(definition.kind), encode(stored));
      }
      agents.push(toAgent(definition, stored));
    }
    index(agents);
    return agents;
  }

  /** Every system agent, initialised on first read (idempotent). */
  const list = () => exclusive(reconcile);

  async function get(kind: string) {
    const agent = (await list()).find(item => item.kind === kind);
    if (!agent) throw new TopicError("Agent système introuvable.", 404);
    return agent;
  }

  /** Instance owner only (404 otherwise, also while the owner is missing); optimistic on `revision` (409). */
  async function configure(userId: string, kind: string, input: unknown) {
    assertInstanceOwner(db, userId);
    const definition = systemAgentDefinition(kind);
    if (!definition) throw new TopicError("Agent système introuvable.", 404);
    const data = systemAgentConfigSchema.parse(input);
    return exclusive(async () => {
      await reconcile();
      const current = (await readStored(definition))!;
      if (current.revision !== data.revision) throw new TopicError("Agent système modifié depuis votre lecture. Rechargez.", 409);
      const next: Stored = { ...current, enabled: data.enabled ?? current.enabled, bloub: data.bloub ?? current.bloub, revision: randomUUID(), updatedAt: now().toISOString(), updatedBy: userId };
      await writeAtomic(fileOf(definition.kind), encode(next));
      return (await reconcile()).find(agent => agent.kind === kind)!;
    });
  }

  return { list, get, configure };
}
export type SystemAgentStore = ReturnType<typeof createSystemAgentStore>;
