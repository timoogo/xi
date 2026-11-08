import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompanion, glanceAt, glances, MOOD_TRANSITION, target } from "../src/lib/bloub/companion";

const REST = -22;
/** Manual clock and timers: time only moves when the test says so. */
function harness(options: { calmAfterMs?: number; dormantAfterMs?: number } = {}) {
  let now = 0;
  const pending = new Map<number, { at: number; run: () => void }>();
  let ids = 0;
  const timers = {
    setTimeout: (run: () => void, ms: number) => { pending.set(++ids, { at: now + ms / 1000, run }); return ids; },
    clearTimeout: (id: unknown) => { pending.delete(id as number); },
  };
  const companion = createCompanion({ restYaw: REST, seed: 7, now: () => now, timers, ...options });
  const advance = (seconds: number) => {
    const end = now + seconds;
    for (;;) {
      const next = [...pending.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      pending.delete(next[0]); now = next[1].at; next[1].run();
    }
    now = end;
  };
  return { companion, advance, pending };
}
const rest = target({ mood: "neutral", aim: null }, REST);

test("at rest the Bloub looks towards the page (left of the bubble), and glances always come back", () => {
  assert.ok(rest.yaw < -15 && rest.mix === 1 && rest.spin === 0, "looks left, fully driven, no eye spin");
  const list = glances(7);
  for (let i = 1; i < list.length; i++) {
    const gap = list[i].at - list[i - 1].at;
    assert.ok(gap >= 6 && gap <= 15, `irregular but calm spacing (${gap})`);
  }
  assert.ok(new Set(list.slice(1, 11).map((g, i) => Math.round(g.at - list[i].at))).size > 3, "not periodic");
  for (const g of list.slice(0, 20)) {
    const peak = glanceAt(list, g.at + 0.35 + g.hold / 2);
    assert.ok(Math.abs(peak.yaw) >= 6 && Math.abs(peak.yaw) <= 12, "small glance");
    assert.deepEqual(glanceAt(list, g.at + 0.35 + g.hold + 0.5 + 0.01), { yaw: 0, pitch: 0 }, "back to rest");
  }
  // Still, the head never strays far from the rest direction.
  const { companion, advance } = harness();
  for (let t = 0; t < 60; t += 0.25) { advance(0.25); assert.ok(Math.abs(companion.look().yaw - REST) <= 12); }
});

test("hover makes it attentive and follow the pointer; leaving eases back to the rest direction", () => {
  const { companion, advance } = harness();
  const moods: string[] = [];
  companion.subscribe(() => moods.push(companion.mood()));
  companion.attend({ x: 1, y: 0 });
  assert.equal(companion.mood(), "attentive");
  advance(MOOD_TRANSITION.attentive);
  assert.ok(companion.look().yaw > 10, "looks at a pointer on its right");
  companion.attend({ x: -1, y: 0 });
  advance(0.05);
  const mid = companion.look().yaw;
  assert.ok(mid < 16 && mid > -16, "glides, does not jump");
  advance(0.5);
  assert.ok(companion.look().yaw < -10);
  assert.deepEqual(moods, ["attentive"], "pointer moves do not notify (no re-render per move)");

  companion.release();
  assert.equal(companion.mood(), "neutral");
  const start = companion.look().yaw;
  advance(MOOD_TRANSITION.neutral / 2);
  const half = companion.look().yaw;
  assert.ok(half !== start && half !== rest.yaw, "progressive return");
  advance(MOOD_TRANSITION.neutral / 2 + 0.001);
  assert.ok(Math.abs(companion.look().yaw - rest.yaw) < 1e-6, "exactly back to neutral");
  assert.ok(Math.abs(companion.look().pitch - rest.pitch) < 1e-6);
});

test("a press reacts at once and then settles: attentive while still hovered, rest otherwise", () => {
  const { companion, advance } = harness();
  companion.press();
  assert.equal(companion.mood(), "pleased", "immediate");
  advance(0.7);
  assert.equal(companion.mood(), "neutral");
  companion.attend({ x: 0, y: 0 });
  companion.press();
  companion.release(); // the pointer leaves during the reaction
  advance(0.7);
  assert.equal(companion.mood(), "neutral");
  companion.attend(null); // keyboard focus
  companion.press();
  advance(0.7);
  assert.equal(companion.mood(), "attentive");
});

test("without interaction it calms down, then dozes off; any interaction wakes it up", () => {
  const { companion, advance } = harness({ calmAfterMs: 30_000, dormantAfterMs: 90_000 });
  advance(29.9);
  assert.equal(companion.mood(), "neutral");
  advance(0.2);
  assert.equal(companion.mood(), "calm");
  advance(90);
  assert.equal(companion.mood(), "dormant");
  companion.attend(null);
  assert.equal(companion.mood(), "attentive");
  advance(500);
  assert.equal(companion.mood(), "attentive", "no calming while engaged");
  companion.release();
  advance(29);
  assert.equal(companion.mood(), "neutral", "the inactivity delay restarts");
  advance(2);
  assert.equal(companion.mood(), "calm");
});

test("dispose clears every timer and listener", () => {
  const { companion, advance, pending } = harness();
  let calls = 0;
  companion.subscribe(() => calls++);
  companion.press();
  assert.ok(pending.size > 0);
  companion.dispose();
  assert.equal(pending.size, 0, "no timer left");
  advance(1000);
  companion.attend({ x: 0, y: 0 });
  assert.equal(calls, 1, "no notification after dispose");
});
