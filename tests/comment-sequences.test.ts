import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { extendSequence, migrateSequences, queueMentions, reserveSequence } from "../src/lib/comments/sequences";

test("une intervention humaine ouvre un budget indépendant des échanges autonomes", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE xi_comment(id TEXT PRIMARY KEY, parent TEXT, root TEXT, agent TEXT, state TEXT, created INTEGER); CREATE TABLE xi_comment_chain(root TEXT PRIMARY KEY, allowance INTEGER)");
    const insert = db.prepare("INSERT INTO xi_comment VALUES (?, ?, 'h1', ?, ?, ?)");
    insert.run("h1", null, null, "done", 0); insert.run("first", "h1", "a", "done", 1);
    let last = "first";
    for (let i = 0; i < 10; i++) { const id = `auto${i}`; insert.run(id, last, "a", "done", i + 2); last = id; }
    insert.run("blocked", last, "b", "waiting", 20);
    insert.run("h2", last, null, "done", 21);
    insert.run("direct-a", "h2", "a", "waiting", 22);
    insert.run("direct-b", "h2", "b", "waiting", 23);
    db.prepare("INSERT INTO xi_comment_chain VALUES ('h1', 10)").run();
    migrateSequences(db);
    assert.deepEqual(reserveSequence(db, "h1"), []);
    assert.deepEqual(reserveSequence(db, "h2"), ["direct-a", "direct-b"]);
    assert.deepEqual(reserveSequence(db, "h2"), []);
    assert.equal((db.prepare("SELECT state FROM xi_comment WHERE id = 'blocked'").get() as { state: string }).state, "waiting");
  } finally { db.close(); }
});

function commentDb() {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE xi_comment (id TEXT PRIMARY KEY, publication TEXT NOT NULL, parent TEXT, root TEXT NOT NULL, owner TEXT NOT NULL, author TEXT NOT NULL, agent TEXT, body TEXT NOT NULL, state TEXT NOT NULL, created INTEGER NOT NULL); CREATE TABLE xi_comment_chain(root TEXT PRIMARY KEY, allowance INTEGER)");
  migrateSequences(db);
  const human = (id: string, parent: string | null, root = id) => {
    db.prepare("INSERT INTO xi_comment VALUES (?, 'pub', ?, ?, 'alice', 'Alice', NULL, 'question', 'done', ?)").run(id, parent, root, Date.now());
    db.prepare("INSERT INTO xi_agent_sequence VALUES (?, 10)").run(id);
    db.prepare("INSERT INTO xi_comment_sequence VALUES (?, ?)").run(id, id);
    return { id, publication: "pub", root, owner: "alice" };
  };
  const states = (sequence: string) => db.prepare("SELECT c.agent, c.state, p.agent AS parent_agent FROM xi_comment c JOIN xi_comment_sequence s ON s.comment_id = c.id JOIN xi_comment p ON p.id = c.parent WHERE s.sequence_id = ?").all(sequence) as { agent: string; state: string; parent_agent: string | null }[];
  return { db, human, states };
}
const alpha = { id: "alpha", name: "Alpha" }, beta = { id: "beta", name: "Beta" }, gamma = { id: "gamma", name: "Gamma" };

test("plusieurs mentions humaines : une seule réponse par agent, même en cas d’appels répétés", () => {
  const { db, human, states } = commentDb();
  try {
    const parent = human("h1", null);
    // Simultaneous enqueues for the same comment (a retry racing with the original request).
    const queued = [queueMentions(db, parent, [alpha, beta]), queueMentions(db, parent, [alpha, beta, alpha]), queueMentions(db, parent, [beta])];
    assert.deepEqual(queued.map(ids => ids.length), [2, 0, 0]);
    assert.deepEqual(reserveSequence(db, "h1").length, 2);
    assert.deepEqual(reserveSequence(db, "h1"), [], "une réponse déjà réservée n’est jamais relancée");
    assert.deepEqual(states("h1").map(row => row.state), ["running", "running"]);
    // A later human mention of the same agents is a new request with its own reply.
    const again = human("h2", "h1", "h1");
    assert.equal(queueMentions(db, again, [alpha]).length, 1);
  } finally { db.close(); }
});

test("le budget automatique est partagé par les agents concurrents, pas par les mentions humaines", () => {
  const { db, human, states } = commentDb();
  try {
    const root = human("h1", null);
    const [first] = queueMentions(db, root, [alpha]);
    reserveSequence(db, "h1"); db.prepare("UPDATE xi_comment SET state = 'done' WHERE id = ?").run(first);
    // Each automatic reply mentions two agents at once: the budget must not be overrun by parallel branches.
    let frontier = [first];
    for (let round = 0; round < 8 && frontier.length; round++) {
      const next: string[] = [];
      for (const id of frontier) next.push(...queueMentions(db, { id, publication: "pub", root: "h1", owner: "alice" }, [beta, gamma]));
      const reserved = [...reserveSequence(db, "h1"), ...reserveSequence(db, "h1")];
      for (const id of reserved) db.prepare("UPDATE xi_comment SET state = 'done' WHERE id = ?").run(id);
      frontier = reserved;
    }
    const automatic = states("h1").filter(row => row.parent_agent);
    assert.equal(automatic.filter(row => row.state === "done").length, 10);
    assert.ok(automatic.some(row => row.state === "waiting"));
    // A human intervening deep in the exhausted chain gets every mentioned agent, and a fresh budget.
    const last = (db.prepare("SELECT id FROM xi_comment WHERE state = 'done' AND agent IS NOT NULL ORDER BY rowid DESC").get() as { id: string }).id;
    const h2 = human("h2", last, "h1");
    queueMentions(db, h2, [alpha, beta, gamma]);
    assert.equal(reserveSequence(db, "h2").length, 3);
    assert.deepEqual(reserveSequence(db, "h1"), [], "l’ancienne séquence reste bloquée");
  } finally { db.close(); }
});

test("la continuation n’est accordée qu’une fois, à son propriétaire, pour une séquence bloquée", () => {
  const { db, human } = commentDb();
  try {
    const root = human("h1", null);
    let parent = queueMentions(db, root, [alpha])[0];
    reserveSequence(db, "h1"); db.prepare("UPDATE xi_comment SET state = 'done' WHERE id = ?").run(parent);
    assert.equal(extendSequence(db, "pub", "h1", "alice"), false, "pas de continuation avant la limite");
    for (let n = 0; n < 11; n++) {
      const [id] = queueMentions(db, { id: parent, publication: "pub", root: "h1", owner: "alice" }, [n % 2 ? alpha : beta]);
      if (n < 10) { assert.deepEqual(reserveSequence(db, "h1"), [id]); db.prepare("UPDATE xi_comment SET state = 'done' WHERE id = ?").run(id); }
      parent = id;
    }
    assert.deepEqual(reserveSequence(db, "h1"), []);
    assert.equal(extendSequence(db, "pub", "h1", "bob"), false, "un autre utilisateur ne prolonge pas la séquence");
    assert.equal(extendSequence(db, "other", "h1", "alice"), false);
    assert.equal(extendSequence(db, "pub", "h1", "alice"), true);
    assert.equal(extendSequence(db, "pub", "h1", "alice"), false, "une double demande n’accorde pas +20");
    assert.equal((db.prepare("SELECT allowance FROM xi_agent_sequence WHERE id = 'h1'").get() as { allowance: number }).allowance, 20);
    assert.deepEqual(reserveSequence(db, "h1"), [parent]);
  } finally { db.close(); }
});
