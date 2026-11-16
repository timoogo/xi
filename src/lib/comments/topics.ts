import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { normalizeTag } from "../search/query";
import { references } from "./references";

export function migrateCommentTopics(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS xi_comment_topic (
    comment_id TEXT NOT NULL, source_id TEXT NOT NULL, owner TEXT NOT NULL, tag TEXT NOT NULL,
    topic_id TEXT, state TEXT NOT NULL, request_id TEXT NOT NULL,
    PRIMARY KEY (comment_id, tag)
  ); CREATE INDEX IF NOT EXISTS xi_comment_topic_source ON xi_comment_topic(source_id, tag);`);
}
/** Called inside the comment transaction: only published human text initiates topic requests. */
export function addCommentTopics(db: Database.Database, commentId: string, parentId: string | null, owner: string, body: string | null) {
  if (parentId) db.prepare("INSERT OR IGNORE INTO xi_comment_topic SELECT ?, source_id, owner, tag, topic_id, state, request_id FROM xi_comment_topic WHERE comment_id = ?").run(commentId, parentId);
  if (body === null) return;
  const insert = db.prepare("INSERT OR IGNORE INTO xi_comment_topic VALUES (?, ?, ?, ?, NULL, 'pending', ?)");
  for (const ref of references(body)) {
    const tag = ref.kind === "topic" ? normalizeTag(ref.text.replace(/[.-]+$/, "")) : null;
    if (tag) insert.run(commentId, commentId, owner, tag, randomUUID());
  }
}
