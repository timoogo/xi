import type Database from "better-sqlite3";

/**
 * Per-user pinned ΞAgents, a display preference only: pinning never changes an
 * agent's activation or watch. Callers check that the user owns the agent (or that it is a
 * system agent, listed for every user); rows
 * for agents that no longer exist are ignored by readers.
 */
export function migrateAgentPins(db: Database.Database) {
  db.exec("CREATE TABLE IF NOT EXISTS xiagent_pin (user_id TEXT NOT NULL, agent_id TEXT NOT NULL, pinned_at INTEGER NOT NULL, PRIMARY KEY (user_id, agent_id))");
}

/** Agent id → pin time (ms), for one user. */
export function agentPins(db: Database.Database, userId: string): Map<string, number> {
  const rows = db.prepare<[string], { agent_id: string; pinned_at: number }>("SELECT agent_id, pinned_at FROM xiagent_pin WHERE user_id = ?").all(userId);
  return new Map(rows.map(row => [row.agent_id, row.pinned_at]));
}

/** Idempotent: pinning again keeps the original pin time, so the pinned order is stable. */
export function setAgentPin(db: Database.Database, userId: string, agentId: string, pinned: boolean, now = Date.now()) {
  if (pinned) db.prepare("INSERT OR IGNORE INTO xiagent_pin(user_id, agent_id, pinned_at) VALUES (?, ?, ?)").run(userId, agentId, now);
  else db.prepare("DELETE FROM xiagent_pin WHERE user_id = ? AND agent_id = ?").run(userId, agentId);
}
