import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { DEFAULT_WATCH_POLICY, watchPolicySchema } from "../src/lib/accounts/types";
import { TopicError } from "../src/lib/topics/types";
import { charCount, checkFormat, DEFAULT_FORMAT, formatOverridesSchema, formatSettingsSchema, resolveFormat } from "../src/lib/watch/format";
import { agentFormat, assertAgentFormat, ownerFormat, setOwnerFormat } from "../src/lib/watch/format-store";

test("format limits: defaults, consistency, per-message lengths, threads, never truncated", () => {
  assert.deepEqual(DEFAULT_FORMAT, { maxPostChars: 280, maxThreadMessageChars: 280, minThreadMessages: 2, maxThreadMessages: 10, targetPostMin: 180, targetPostMax: 250, threads: true, autoFormat: true, correctionAttempts: 2 });
  assert.ok(formatSettingsSchema.safeParse(DEFAULT_FORMAT).success);
  for (const bad of [{ minThreadMessages: 6, maxThreadMessages: 4 }, { targetPostMin: 260, targetPostMax: 200 }, { maxPostChars: 200 }, { maxPostChars: 10 }, { correctionAttempts: 9 }, { extra: 1 }])
    assert.equal(formatSettingsSchema.safeParse({ ...DEFAULT_FORMAT, ...bad }).success, false, JSON.stringify(bad));
  assert.equal(formatOverridesSchema.safeParse({ maxPostChars: 200, unknown: true }).success, false, "strict overrides");

  // Overrides merge field by field; consistency is checked on the merged result.
  assert.deepEqual(resolveFormat(DEFAULT_FORMAT, { maxThreadMessages: 4, threads: false }), { ok: true, format: { ...DEFAULT_FORMAT, maxThreadMessages: 4, threads: false } });
  assert.deepEqual(resolveFormat(DEFAULT_FORMAT, undefined), { ok: true, format: DEFAULT_FORMAT });
  const broken = resolveFormat(DEFAULT_FORMAT, { maxPostChars: 200 });
  assert.equal(broken.ok, false);
  assert.match(!broken.ok ? broken.problems.join() : "", /longueur cible dépasse/);

  // Code points, not UTF-16 units: an emoji counts once.
  assert.equal(charCount("Ξ 🚀 ok "), 6);
  assert.deepEqual(checkFormat(["a".repeat(280)], DEFAULT_FORMAT), []);
  assert.match(checkFormat(["a".repeat(281)], DEFAULT_FORMAT).join(), /Message 1 : 281 caractères, au-delà de la limite de 280/);
  // Each thread message is checked individually, with the thread limit.
  const thread = { ...DEFAULT_FORMAT, maxThreadMessageChars: 100 };
  assert.deepEqual(checkFormat(["a".repeat(100), "b".repeat(100)], thread), []);
  assert.deepEqual(checkFormat(["a".repeat(100), "b".repeat(101), "c".repeat(50)], thread).map(problem => problem.slice(0, 9)), ["Message 2"]);
  assert.match(checkFormat(Array(5).fill("x"), { ...DEFAULT_FORMAT, maxThreadMessages: 4 }).join(), /au plus 4 messages/);
  assert.match(checkFormat(["x", "y"], { ...DEFAULT_FORMAT, minThreadMessages: 3 }).join(), /au moins 3 messages/);
  assert.match(checkFormat(["x", "y"], { ...DEFAULT_FORMAT, threads: false }).join(), /threads sont désactivés/);

  // Existing agents: no `format` key, weekly review unchanged, manual mode stays the default.
  const legacy = watchPolicySchema.parse(DEFAULT_WATCH_POLICY);
  assert.equal(legacy.format, undefined); assert.equal(legacy.weeklyReview, undefined); assert.equal(legacy.autoPublish, false);
  assert.equal(watchPolicySchema.safeParse({ ...DEFAULT_WATCH_POLICY, format: { maxPostChars: 9 } }).success, false);
});

test("global limits: per owner, optimistic revision, explained refusals, agent resolution", () => {
  const db = new Database(":memory:");
  assert.deepEqual(ownerFormat(db, "alice"), { format: DEFAULT_FORMAT, revision: null, valid: true, defaults: DEFAULT_FORMAT });
  const saved = setOwnerFormat(db, "alice", { revision: null, format: { ...DEFAULT_FORMAT, maxPostChars: 500, targetPostMax: 400 } });
  assert.equal(saved.format.maxPostChars, 500);
  assert.equal(ownerFormat(db, "bob").format.maxPostChars, 280, "owners are isolated");
  assert.throws(() => setOwnerFormat(db, "alice", { revision: null, format: DEFAULT_FORMAT }), (error: TopicError) => error.status === 409);
  assert.throws(() => setOwnerFormat(db, "alice", { revision: saved.revision, format: { ...DEFAULT_FORMAT, minThreadMessages: 8, maxThreadMessages: 3 } }), /minimum de messages/);
  assert.throws(() => setOwnerFormat(db, "alice", { revision: saved.revision, format: { ...DEFAULT_FORMAT, maxPostChars: "280" } }), (error: Error) => error.name === "ZodError");

  const agent = (format?: object) => ({ owner: "alice", watch: { policy: { ...DEFAULT_WATCH_POLICY, ...(format ? { format } : {}) }, revision: null, valid: true, publicConfirmedAt: null } });
  assert.deepEqual(agentFormat(db, agent()), { ok: true, format: { ...DEFAULT_FORMAT, maxPostChars: 500, targetPostMax: 400 } });
  assert.equal((agentFormat(db, agent({ maxPostChars: 300 })) as { ok: false }).ok, false, "override inconsistent with the global target");
  assert.throws(() => assertAgentFormat(db, "alice", { maxPostChars: 300 }), /incohérentes/);
  assert.doesNotThrow(() => assertAgentFormat(db, "alice", { maxPostChars: 450 }));

  // A row unreadable by this version: defaults apply, visibly.
  db.prepare("UPDATE publication_format SET settings = ? WHERE owner = 'alice'").run(JSON.stringify({ maxPostChars: -1 }));
  assert.deepEqual([ownerFormat(db, "alice").valid, ownerFormat(db, "alice").format], [false, DEFAULT_FORMAT]);
  db.close();
});
