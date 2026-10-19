import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeViewRequest } from "../src/lib/graph/client";
import {
  HISTORY_LIMIT, canGoBack, canGoForward, currentEntry, defaultLocalState, goBack, goForward, localStateKey, pushHistory, validateLocalState,
  type MessageHistory,
} from "../src/lib/graph/local-state";

const P1 = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";
const P2 = "9f0c28ba-2fa1-41d2-883f-0016d3cca428";
const G1 = "2c5e28ba-2fa1-41d2-883f-0016d3cca429";
const ref = (n: number, publication = P1) => `${publication}/${n}`;
const empty: MessageHistory = { entries: [], index: -1 };

test("history: push appends and moves to the new entry", () => {
  let history = pushHistory(empty, ref(1));
  assert.deepEqual(history, { entries: [ref(1)], index: 0 });
  history = pushHistory(history, ref(2));
  assert.deepEqual(history, { entries: [ref(1), ref(2)], index: 1 });
  assert.equal(currentEntry(history), ref(2));
  assert.equal(currentEntry(empty), null);
});

test("history: back and forward move within bounds", () => {
  const history = [1, 2, 3].reduce((h, n) => pushHistory(h, ref(n)), empty);
  assert.ok(canGoBack(history));
  assert.ok(!canGoForward(history));
  const back = goBack(goBack(history));
  assert.equal(currentEntry(back), ref(1));
  assert.ok(!canGoBack(back));
  assert.equal(goBack(back), back, "back at the start is a no-op");
  const forward = goForward(back);
  assert.equal(currentEntry(forward), ref(2));
  assert.equal(goForward(history), history, "forward at the end is a no-op");
  assert.ok(!canGoBack(empty) && !canGoForward(empty));
});

test("history: opening a message after going back replaces the forward branch", () => {
  const history = [1, 2, 3].reduce((h, n) => pushHistory(h, ref(n)), empty);
  const replaced = pushHistory(goBack(goBack(history)), ref(9));
  assert.deepEqual(replaced, { entries: [ref(1), ref(9)], index: 1 });
  assert.ok(!canGoForward(replaced));
});

test("history: re-opening the current entry is a no-op and the length is capped", () => {
  const history = pushHistory(empty, ref(1));
  assert.equal(pushHistory(history, ref(1)), history);
  let long = empty;
  for (let n = 1; n <= HISTORY_LIMIT + 10; n++) long = pushHistory(long, ref(n));
  assert.equal(long.entries.length, HISTORY_LIMIT);
  assert.equal(long.index, HISTORY_LIMIT - 1);
  assert.equal(long.entries[0], ref(11));
  assert.equal(currentEntry(long), ref(HISTORY_LIMIT + 10));
});

function sample() {
  return {
    ...defaultLocalState(),
    mode: "hierarchical" as const,
    viewport: { x: 12, y: -40, k: 1.5 },
    expanded: [{ id: "g:unassigned" }, { id: `g:${G1}`, limit: 80 }, { id: `p:${P1}` }],
    lockedLevel: "publication" as const,
    filters: { types: ["supports" as const, "contradicts" as const] },
    selected: `m:${ref(2)}`,
    panel: { open: true, view: "message" as const, connections: { scope: { kind: "between" as const, a: `g:${G1}`, b: `p:${P2}` }, filters: { types: ["expands" as const], from: "2026-01-01" } } },
    history: { entries: [ref(1), ref(2, P2)], index: 1 },
  };
}

test("validator: accepts the default and a full state (round trip through JSON)", () => {
  assert.deepEqual(validateLocalState(defaultLocalState()), defaultLocalState());
  const state = sample();
  assert.deepEqual(validateLocalState(JSON.parse(JSON.stringify(state))), state);
});

test("validator: rejects other versions and malformed values", () => {
  const bad: unknown[] = [
    null, undefined, 42, "state", [],
    { ...sample(), version: 2 },
    { ...sample(), mode: "radial" },
    { ...sample(), viewport: { x: 0, y: 0, k: 0 } },
    { ...sample(), viewport: { x: Number.NaN, y: 0, k: 1 } },
    { ...sample(), expanded: [{ id: "g:../../etc" }] },
    { ...sample(), expanded: [{ id: `m:${ref(1)}` }] },
    { ...sample(), expanded: [{ id: `p:${P1}` }, { id: `p:${P1}` }] },
    { ...sample(), expanded: [{ id: `p:${P1}`, limit: 5000 }] },
    { ...sample(), expanded: Array.from({ length: 61 }, (_, n) => ({ id: `p:${P1.slice(0, -2)}${String(n).padStart(2, "0")}` })) },
    { ...sample(), lockedLevel: "everything" },
    { ...sample(), filters: { types: ["likes"] } },
    { ...sample(), selected: "x:1" },
    { ...sample(), panel: { open: "yes", view: "message", connections: null } },
    { ...sample(), panel: { open: true, view: "message", connections: { scope: { kind: "between", a: `g:${G1}` }, filters: {} } } },
    { ...sample(), panel: { open: true, view: "message", connections: { scope: { kind: "all", node: `g:${G1}` }, filters: { from: "yesterday" } } } },
    { ...sample(), history: { entries: [ref(1)], index: 3 } },
    { ...sample(), history: { entries: [], index: 0 } },
    { ...sample(), history: { entries: ["not-a-ref"], index: 0 } },
  ];
  for (const value of bad) assert.equal(validateLocalState(value), null, JSON.stringify(value)?.slice(0, 120));
});

test("validator: never keeps unknown fields such as message bodies", () => {
  const stored = { ...sample(), body: "secret", history: { entries: [ref(1)], index: 0, excerpt: "secret" } };
  const state = validateLocalState(stored);
  assert.ok(state);
  assert.ok(!JSON.stringify(state).includes("secret"));
});

test("storage key carries the schema version and the user", () => {
  assert.equal(localStateKey("alice"), "v1:alice");
  assert.notEqual(localStateKey("alice"), localStateKey("bob"));
});

test("view requests are normalised: sorted, deduplicated, clamped, capped", () => {
  const normal = normalizeViewRequest({ expanded: [{ id: "p:b", limit: 999 }, { id: "g:a", limit: 40 }, { id: "p:b" }, { id: "g:c", limit: 0.5 }] });
  assert.deepEqual(normal, { expanded: [{ id: "g:a" }, { id: "g:c", limit: 1 }, { id: "p:b", limit: 200 }] });
  const many = normalizeViewRequest({ expanded: Array.from({ length: 80 }, (_, n) => ({ id: `g:${n}` })) });
  assert.equal(many.expanded.length, 60);
});
