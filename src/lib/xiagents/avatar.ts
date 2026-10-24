import type Database from "better-sqlite3";
import { z } from "zod";
import { bloubConfigSchema, DEFAULT_BLOUB_CONFIG } from "../bloub/config";
import type { BloubActivity, BloubConfig } from "../bloub/types";
import { storedWatchPolicySchema } from "../accounts/types";

/** What a client needs to draw a ΞAgent: its saved appearance and its current activity. */
export type XiAgentBloub = { config: BloubConfig; activity: BloubActivity };
type Status = { config: BloubConfig; active: boolean; watching: boolean };

/**
 * Top-level `bloub` key of the generator file, outside `editorial` and `watch`.
 * The generic appearance stays nested so it can be read without Ξ metadata.
 */
export const storedAgentBloubSchema = z.object({ config: bloubConfigSchema, revision: z.uuid(), updatedAt: z.iso.datetime(), updatedBy: z.string().min(1) });
export type AgentBloubSettings = { config: BloubConfig; revision: string | null };

/** Agents created before avatars, or with an unreadable value, render the default (revision null). */
export function readAgentBloub(raw: unknown): AgentBloubSettings {
  const parsed = storedAgentBloubSchema.safeParse(raw);
  return parsed.success ? { config: parsed.data.config, revision: parsed.data.revision } : { config: DEFAULT_BLOUB_CONFIG, revision: null };
}

/**
 * Universal states, never customisable:
 * disabled or incomplete → unavailable; a claimed watch job → working;
 * watch enabled and not paused → idle; otherwise (watch off or paused) → sleeping.
 */
export function agentActivity({ active, watching, busy }: { active: boolean; watching: boolean; busy: boolean }): BloubActivity {
  if (!active) return "unavailable";
  if (busy) return "working";
  return watching ? "idle" : "sleeping";
}

/**
 * Reads the generator file's top-level keys `bloub`, `editorial.active` and `watch`. An
 * unreadable watch policy counts as disabled, as for the worker.
 */
export function agentStatus(data: unknown): Status {
  const record = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const editorial = record.editorial as { active?: unknown } | undefined;
  const watch = storedWatchPolicySchema.safeParse(record.watch);
  return { config: readAgentBloub(record.bloub).config, active: editorial?.active === true, watching: watch.success && watch.data.enabled && !watch.data.paused };
}

/** Agents whose watch job is currently claimed by a live worker (unexpired lease). */
export function busyAgents(db: Database.Database, ids: string[], now = Date.now()): Set<string> {
  if (!ids.length || !db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'watch_job'").get()) return new Set();
  const wanted = new Set(ids);
  const rows = db.prepare<[number], { id: string | null }>("SELECT DISTINCT json_extract(payload, '$.agentId') AS id FROM watch_job WHERE state = 'running' AND lease_until > ?").all(now);
  return new Set(rows.flatMap(row => row.id && wanted.has(row.id) ? [row.id] : []));
}

export const xiAgentBloub = (status: Status, busy: boolean): XiAgentBloub =>
  ({ config: status.config, activity: agentActivity({ ...status, busy }) });
