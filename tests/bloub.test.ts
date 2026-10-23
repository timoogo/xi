import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { migrateAvatarPreferences, getAvatarPreference } from "../src/lib/avatar-preferences";
import { bloubAppearance, bloubEyes } from "../src/lib/bloub/appearance";

test("Bloub migration preserves photos, is idempotent and supports legacy writers", () => {
  const db = new Database(":memory:");
  try {
    db.pragma("foreign_keys = ON");
    migrateAvatarPreferences(db);
    db.exec(`CREATE TABLE user(id TEXT PRIMARY KEY, image TEXT, name TEXT);
      INSERT INTO user VALUES ('a', NULL, 'A'), ('b', '/portrait.webp', 'B');`);
    migrateAvatarPreferences(db);
    const a = getAvatarPreference(db, "a"), b = getAvatarPreference(db, "b");
    assert.equal(a.mode, "bloub"); assert.equal(b.mode, "photo");
    assert.match(a.seed, /^[0-9a-f]{32}$/); assert.notEqual(a.seed, b.seed);
    migrateAvatarPreferences(db); assert.deepEqual(getAvatarPreference(db, "a"), a);
    assert.deepEqual(db.prepare("SELECT image FROM user WHERE id='b'").get(), { image: "/portrait.webp" });
    db.exec("INSERT INTO user VALUES ('c', NULL, 'C'); UPDATE user SET name='Renamed' WHERE id='a'");
    assert.equal(getAvatarPreference(db, "c").mode, "bloub");
    assert.deepEqual(getAvatarPreference(db, "a"), a);
    db.exec("UPDATE user SET image='/new.webp' WHERE id='a'");
    assert.deepEqual(getAvatarPreference(db, "a"), { ...a, mode: "photo", revision: 1 });
    db.exec("UPDATE user SET image=NULL WHERE id='a'");
    assert.deepEqual(getAvatarPreference(db, "a"), { ...a, revision: 2 });
    assert.throws(() => db.prepare("UPDATE user_avatar SET seed=? WHERE user_id='b'").run(a.seed));
    db.exec("DELETE FROM user WHERE id='c'");
    assert.equal(db.prepare("SELECT * FROM user_avatar WHERE user_id='c'").get(), undefined);
  } finally { db.close(); }
});

test("seed mapping and static pose are deterministic; animation varies eyes", () => {
  const seed = "0123456789abcdef0123456789abcdef";
  const a = bloubAppearance(seed);
  assert.deepEqual(a, bloubAppearance(seed));
  assert.notDeepEqual(a, bloubAppearance("f".repeat(32)));
  assert.deepEqual(bloubEyes(a), bloubEyes(bloubAppearance(seed)));
  assert.notDeepEqual(bloubEyes(a, 1), bloubEyes(a, 2));
  assert.ok(!a.body.includes("NaN"));
});
