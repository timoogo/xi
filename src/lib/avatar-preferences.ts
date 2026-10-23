import type Database from "better-sqlite3";

export type AvatarPreference = { seed: string; mode: "bloub" | "photo"; revision: number };

/** Expand-only migration. Old writers still update user.image; triggers keep both versions compatible. */
export function migrateAvatarPreferences(db: Database.Database) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'user'").get()) return;
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_avatar (
        user_id TEXT PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
        seed TEXT NOT NULL UNIQUE CHECK(length(seed) = 32 AND seed NOT GLOB '*[^0-9a-f]*'),
        mode TEXT NOT NULL CHECK(mode IN ('bloub', 'photo')),
        revision INTEGER NOT NULL DEFAULT 0
      );
      CREATE TRIGGER IF NOT EXISTS user_avatar_insert AFTER INSERT ON "user" BEGIN
        INSERT INTO user_avatar(user_id, seed, mode)
        VALUES(NEW.id, lower(hex(randomblob(16))), CASE WHEN coalesce(NEW.image, '') = '' THEN 'bloub' ELSE 'photo' END);
      END;
      CREATE TRIGGER IF NOT EXISTS user_avatar_image AFTER UPDATE OF image ON "user"
      WHEN NEW.image IS NOT OLD.image BEGIN
        UPDATE user_avatar SET mode = CASE WHEN coalesce(NEW.image, '') = '' THEN 'bloub' ELSE 'photo' END,
          revision = revision + 1 WHERE user_id = NEW.id;
      END;
      INSERT INTO user_avatar(user_id, seed, mode)
      SELECT id, lower(hex(randomblob(16))), CASE WHEN coalesce(image, '') = '' THEN 'bloub' ELSE 'photo' END
      FROM "user" WHERE id NOT IN (SELECT user_id FROM user_avatar);
    `);
  }).immediate();
}

export function getAvatarPreference(db: Database.Database, userId: string): AvatarPreference {
  const row = db.prepare("SELECT seed, mode, revision FROM user_avatar WHERE user_id = ?").get(userId) as AvatarPreference | undefined;
  if (!row) throw new Error("Avatar preference missing; run db:migrate.");
  return row;
}
