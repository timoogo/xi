import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

/** One budget per human intervention; legacy comments are assigned to their nearest human ancestor. */
export function migrateSequences(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS xi_comment_sequence (comment_id TEXT PRIMARY KEY, sequence_id TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS xi_comment_sequence_id ON xi_comment_sequence(sequence_id);
    CREATE TABLE IF NOT EXISTS xi_agent_sequence (id TEXT PRIMARY KEY, allowance INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS xi_comment_mention (parent TEXT NOT NULL, agent TEXT NOT NULL, PRIMARY KEY (parent, agent))`);
  db.transaction(() => {
    db.exec(`INSERT OR IGNORE INTO xi_agent_sequence SELECT id, 10 FROM xi_comment WHERE agent IS NULL;
      INSERT OR IGNORE INTO xi_comment_sequence SELECT id, id FROM xi_comment WHERE agent IS NULL;
      INSERT OR IGNORE INTO xi_comment_mention SELECT parent, agent FROM xi_comment WHERE parent IS NOT NULL AND agent IS NOT NULL;
      WITH RECURSIVE lineage(comment_id, parent, depth) AS (
        SELECT id, parent, 0 FROM xi_comment WHERE agent IS NOT NULL AND id NOT IN (SELECT comment_id FROM xi_comment_sequence)
        UNION ALL SELECT l.comment_id, c.parent, l.depth + 1 FROM lineage l JOIN xi_comment c ON c.id = l.parent WHERE c.agent IS NOT NULL AND l.depth < 1000
      ) INSERT OR IGNORE INTO xi_comment_sequence
        SELECT l.comment_id, c.id FROM lineage l JOIN xi_comment c ON c.id = l.parent WHERE c.agent IS NULL;
      UPDATE xi_agent_sequence SET allowance = max(allowance, COALESCE((SELECT allowance FROM xi_comment_chain WHERE root = xi_agent_sequence.id), 10))
        WHERE id IN (SELECT root FROM xi_comment_chain);`);
  })();
}
type Parent = { id: string; publication: string; root: string; owner: string };
/** One waiting reply per (parent, agent), whatever the number of calls: the mention row is the idempotency key. */
export function queueMentions(db: Database.Database, parent: Parent, agents: { id: string; name: string }[], onQueued: (id: string) => void = () => {}) {
  return db.transaction(() => {
    const queued: string[] = [];
    for (const agent of agents) {
      if (!db.prepare("INSERT OR IGNORE INTO xi_comment_mention VALUES (?, ?)").run(parent.id, agent.id).changes) continue;
      const id = randomUUID();
      db.prepare("INSERT INTO xi_comment VALUES (?, ?, ?, ?, ?, ?, ?, '', 'waiting', ?)").run(id, parent.publication, parent.id, parent.root, parent.owner, agent.name, agent.id, Date.now());
      db.prepare("INSERT INTO xi_comment_sequence SELECT ?, sequence_id FROM xi_comment_sequence WHERE comment_id = ?").run(id, parent.id);
      onQueued(id); queued.push(id);
    }
    return queued;
  })();
}
const used = (db: Database.Database, sequence: string) => (db.prepare(`SELECT count(*) AS n FROM xi_comment c JOIN xi_comment_sequence s ON s.comment_id = c.id JOIN xi_comment p ON p.id = c.parent
  WHERE s.sequence_id = ? AND p.agent IS NOT NULL AND c.state IN ('running', 'done', 'error')`).get(sequence) as { n: number }).n;
/** Grants 10 more automatic replies only to a sequence actually blocked at its limit; a repeated request is refused. */
export function extendSequence(db: Database.Database, publication: string, sequence: string, owner: string) {
  return db.transaction(() => {
    const waiting = db.prepare(`SELECT 1 FROM xi_comment c JOIN xi_comment_sequence s ON s.comment_id = c.id JOIN xi_comment p ON p.id = c.parent
      WHERE c.publication = ? AND s.sequence_id = ? AND c.owner = ? AND c.state = 'waiting' AND p.agent IS NOT NULL`).get(publication, sequence, owner);
    const row = db.prepare("SELECT allowance FROM xi_agent_sequence WHERE id = ?").get(sequence) as { allowance: number } | undefined;
    if (!waiting || !row || used(db, sequence) < row.allowance) return false;
    db.prepare("UPDATE xi_agent_sequence SET allowance = allowance + 10 WHERE id = ?").run(sequence);
    return true;
  })();
}
export function reserveSequence(db: Database.Database, sequence: string): string[] {
  return db.transaction(() => {
    const row = db.prepare("SELECT allowance FROM xi_agent_sequence WHERE id = ?").get(sequence) as { allowance: number } | undefined;
    if (!row) return [];
    const waiting = db.prepare(`SELECT c.id, p.agent AS parent_agent FROM xi_comment c JOIN xi_comment_sequence s ON s.comment_id = c.id JOIN xi_comment p ON p.id = c.parent
      WHERE s.sequence_id = ? AND c.state = 'waiting' ORDER BY c.created, c.rowid`).all(sequence) as { id: string; parent_agent: string | null }[];
    let available = Math.max(0, row.allowance - used(db, sequence));
    const chosen = waiting.filter(item => item.parent_agent === null || available-- > 0);
    for (const item of chosen) db.prepare("UPDATE xi_comment SET state = 'running' WHERE id = ? AND state = 'waiting'").run(item.id);
    return chosen.map(item => item.id);
  })();
}
