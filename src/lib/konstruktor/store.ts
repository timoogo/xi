import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { TopicError } from "../topics/types";
import type { KonstruktorMessage, KonstruktorTarget, Proposal, SessionSummary } from "./types";

/**
 * Durable conversations with Konstruktor, in the application database (operational, per-user data
 * like the run history; never in the shared vault). Every read is scoped by owner: a session id
 * of another user is unknown (404). Messages are append-only.
 */
export function migrateKonstruktor(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS konstruktor_session (
      id TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      target_type TEXT NOT NULL CHECK (target_type IN ('topic', 'agent', 'new-topic', 'new-agent')),
      target_id TEXT,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS konstruktor_session_target ON konstruktor_session (owner, target_type, target_id, updated_at);
    CREATE TABLE IF NOT EXISTS konstruktor_message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES konstruktor_session (id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      text TEXT NOT NULL,
      request_id TEXT,
      reply_to TEXT UNIQUE,
      data TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      UNIQUE (session_id, seq),
      UNIQUE (session_id, request_id)
    );
    CREATE TABLE IF NOT EXISTS konstruktor_decision (
      session_id TEXT NOT NULL REFERENCES konstruktor_session (id) ON DELETE CASCADE,
      proposal_id TEXT NOT NULL,
      decision TEXT NOT NULL CHECK (decision IN ('accepted', 'refused')),
      deployment_id TEXT,
      decided_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, proposal_id)
    );
    CREATE TABLE IF NOT EXISTS konstruktor_preview (
      session_id TEXT PRIMARY KEY REFERENCES konstruktor_session (id) ON DELETE CASCADE,
      state TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
}

type SessionRow = { id: string; owner: string; target_type: KonstruktorTarget["type"]; target_id: string | null; title: string; created_at: number; updated_at: number; messages?: number };
type MessageRow = { id: string; session_id: string; seq: number; role: "user" | "assistant"; text: string; request_id: string | null; reply_to: string | null; data: string; created_at: number };
export type MessageData = { questions?: string[]; proposals?: Proposal[]; model?: string; unsupported?: string[] };
export type Decision = { proposalId: string; decision: "accepted" | "refused"; deploymentId: string | null; decidedAt: number };

const toSession = (row: SessionRow): SessionSummary => ({
  id: row.id, target: (row.target_id ? { type: row.target_type, id: row.target_id } : { type: row.target_type, id: null }) as KonstruktorTarget,
  title: row.title, createdAt: row.created_at, updatedAt: row.updated_at, messages: row.messages ?? 0,
});
const toMessage = (row: MessageRow): KonstruktorMessage => {
  const data = JSON.parse(row.data) as MessageData;
  return { id: row.id, role: row.role, text: row.text, createdAt: row.created_at, requestId: row.request_id, replyTo: row.reply_to, questions: data.questions ?? [], proposals: (data.proposals ?? []).map(proposal => ({ ...proposal, notes: proposal.notes ?? [] })), unsupported: data.unsupported ?? [] };
};

export function createConversationStore(db: Database.Database, now: () => number = Date.now) {
  migrateKonstruktor(db);
  const sessionRow = db.prepare<[string, string], SessionRow>("SELECT s.*, (SELECT count(*) FROM konstruktor_message m WHERE m.session_id = s.id) AS messages FROM konstruktor_session s WHERE id = ? AND owner = ?");

  /** Idempotent on the client's id; an id already used for another target (or user) is refused. */
  function createSession(owner: string, id: string, target: KonstruktorTarget, title: string) {
    const at = now();
    db.prepare("INSERT INTO konstruktor_session VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING").run(id, owner, target.type, target.id, title.slice(0, 200), at, at);
    const row = sessionRow.get(id, owner);
    if (!row) throw new TopicError("Conversation introuvable.", 404);
    if (row.target_type !== target.type || row.target_id !== target.id) throw new TopicError("Identifiant de conversation déjà utilisé pour une autre cible.", 409);
    return toSession(row);
  }
  function session(owner: string, id: string) {
    const row = sessionRow.get(id, owner);
    if (!row) throw new TopicError("Conversation introuvable.", 404);
    return toSession(row);
  }
  /** The owner's conversations about one target, most recent first. */
  function sessions(owner: string, target: KonstruktorTarget, limit = 20) {
    return db.prepare<[string, string, string | null, number], SessionRow>(`SELECT s.*, (SELECT count(*) FROM konstruktor_message m WHERE m.session_id = s.id) AS messages FROM konstruktor_session s
      WHERE owner = ? AND target_type = ? AND target_id IS ? ORDER BY updated_at DESC, rowid DESC LIMIT ?`).all(owner, target.type, target.id, limit).map(toSession);
  }
  function messages(sessionId: string) {
    return db.prepare<[string], MessageRow>("SELECT * FROM konstruktor_message WHERE session_id = ? ORDER BY seq").all(sessionId).map(toMessage);
  }
  const append = db.transaction((sessionId: string, role: "user" | "assistant", text: string, requestId: string | null, replyTo: string | null, data: MessageData) => {
    const seq = (db.prepare<[string], { seq: number | null }>("SELECT max(seq) AS seq FROM konstruktor_message WHERE session_id = ?").get(sessionId)!.seq ?? 0) + 1;
    const id = randomUUID();
    db.prepare("INSERT INTO konstruktor_message VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, sessionId, seq, role, text, requestId, replyTo, JSON.stringify(data), now());
    db.prepare("UPDATE konstruktor_session SET updated_at = ? WHERE id = ?").run(now(), sessionId);
    return id;
  });
  const byId = (id: string) => { const row = db.prepare<[string], MessageRow>("SELECT * FROM konstruktor_message WHERE id = ?").get(id); return row ? toMessage(row) : null; };

  /** Idempotent on `requestId`: the same text again returns the same message; a different one is 409. */
  function addUserMessage(sessionId: string, requestId: string, text: string) {
    const existing = db.prepare<[string, string], MessageRow>("SELECT * FROM konstruktor_message WHERE session_id = ? AND request_id = ?").get(sessionId, requestId);
    if (existing) {
      if (existing.text !== text) throw new TopicError("Identifiant de message déjà utilisé pour un autre texte.", 409);
      return { message: toMessage(existing), created: false };
    }
    return { message: byId(append.immediate(sessionId, "user", text, requestId, null, {}))!, created: true };
  }
  /** Removes a user message whose turn could not be queued (nothing answered it). */
  function retract(messageId: string) {
    db.prepare("DELETE FROM konstruktor_message WHERE id = ? AND role = 'user' AND NOT EXISTS (SELECT 1 FROM konstruktor_message r WHERE r.reply_to = ?)").run(messageId, messageId);
  }
  /** One reply per user message, whatever the number of attempts. */
  function reply(sessionId: string, replyTo: string, text: string, data: MessageData) {
    const existing = db.prepare<[string], MessageRow>("SELECT * FROM konstruktor_message WHERE reply_to = ?").get(replyTo);
    if (existing) return toMessage(existing);
    return byId(append.immediate(sessionId, "assistant", text, null, replyTo, data))!;
  }
  const replyTo = (messageId: string) => { const row = db.prepare<[string], MessageRow>("SELECT * FROM konstruktor_message WHERE reply_to = ?").get(messageId); return row ? toMessage(row) : null; };

  /** The owner's decisions on the session's proposals (the last one per proposal). */
  function decisions(sessionId: string): Decision[] {
    return db.prepare<[string], { proposal_id: string; decision: Decision["decision"]; deployment_id: string | null; decided_at: number }>("SELECT * FROM konstruktor_decision WHERE session_id = ?").all(sessionId)
      .map(row => ({ proposalId: row.proposal_id, decision: row.decision, deploymentId: row.deployment_id, decidedAt: row.decided_at }));
  }
  const decide = db.transaction((sessionId: string, proposalIds: string[], decision: Decision["decision"], deploymentId: string | null) => {
    const upsert = db.prepare("INSERT INTO konstruktor_decision VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id, proposal_id) DO UPDATE SET decision = excluded.decision, deployment_id = excluded.deployment_id, decided_at = excluded.decided_at");
    for (const id of proposalIds) upsert.run(sessionId, id, decision, deploymentId, now());
  });
  /** Back to undecided (an accepted proposal whose application is final is never reset: see the service). */
  function undecide(sessionId: string, proposalIds: string[]) {
    const remove = db.prepare("DELETE FROM konstruktor_decision WHERE session_id = ? AND proposal_id = ?");
    db.transaction(() => { for (const id of proposalIds) remove.run(sessionId, id); })();
  }

  /** The owner's unfinished preview of the session (choices and edits only: never a configuration). */
  function preview(sessionId: string) {
    const row = db.prepare<[string], { state: string; updated_at: number }>("SELECT state, updated_at FROM konstruktor_preview WHERE session_id = ?").get(sessionId);
    return row ? { state: JSON.parse(row.state) as unknown, updatedAt: row.updated_at } : null;
  }
  function savePreview(sessionId: string, state: unknown) {
    db.prepare("INSERT INTO konstruktor_preview VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at").run(sessionId, JSON.stringify(state), now());
    return preview(sessionId)!;
  }

  /** An assistant message Konstruktor opens a conversation with (a suggestion), once per `key`. */
  function suggest(sessionId: string, key: string, text: string, data: MessageData) {
    const existing = db.prepare<[string, string], MessageRow>("SELECT * FROM konstruktor_message WHERE session_id = ? AND request_id = ? AND role = 'assistant'").get(sessionId, key);
    if (existing) return toMessage(existing);
    return byId(append.immediate(sessionId, "assistant", text, key, null, data))!;
  }

  return { suggest, preview, savePreview, createSession, session, sessions, messages, message: byId, addUserMessage, retract, reply, replyTo, decisions, decide: (sessionId: string, proposalIds: string[], decision: Decision["decision"], deploymentId: string | null = null) => decide.immediate(sessionId, proposalIds, decision, deploymentId), undecide };
}
export type ConversationStore = ReturnType<typeof createConversationStore>;
