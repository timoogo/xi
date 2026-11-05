import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import Database from "better-sqlite3";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { XiAgentsWidget, widgetAgents } from "../src/components/widgets/xiagents";
import { DEFAULT_BLOUB_CONFIG } from "../src/lib/bloub/config";
import { BLOUB_ACTIVITIES, type BloubActivity } from "../src/lib/bloub/types";
import { parseCategory, xiAgentHref, xiAgentsHref, type XiAgentCategory, type XiAgentSummary } from "../src/lib/xiagents/summary";
import { openVault } from "../src/lib/publications/vault";
import { createAccountStore } from "../src/lib/accounts/store";
import { createTopicStore } from "../src/lib/topics/store";

const agent = (n: number, pinnedAt: number | null = null, activity: BloubActivity = "idle"): XiAgentSummary =>
  ({ id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, name: `Agent ${String.fromCharCode(64 + n)}`, handle: `agent${n}`, category: "editorial", pinnedAt, bloub: { config: DEFAULT_BLOUB_CONFIG, activity } });
const names = (list: XiAgentSummary[]) => list.map(a => a.name);
const router = { push() {}, replace() {}, refresh() {}, prefetch() {}, back() {}, forward() {} } as unknown as AppRouterInstance;
const render = (initial: XiAgentSummary[] | null, system: XiAgentSummary[] | null = null, category: XiAgentCategory = "editorial") => renderToStaticMarkup(<AppRouterContext.Provider value={router}><XiAgentsWidget initial={initial} initialSystem={system} initialCategory={category} /></AppRouterContext.Provider>);

test("widget selection: five by default, pinned first, every pinned agent kept, stable order", () => {
  const eight = Array.from({ length: 8 }, (_, i) => agent(i + 1));
  assert.deepEqual(names(widgetAgents(eight)), ["Agent A", "Agent B", "Agent C", "Agent D", "Agent E"]);
  assert.deepEqual(names(widgetAgents([...eight].reverse())), names(widgetAgents(eight)), "input order does not matter");
  // 2 pinned → 2 pinned (oldest pin first) + 3 others.
  const two = eight.map((a, i) => i === 6 ? { ...a, pinnedAt: 20 } : i === 7 ? { ...a, pinnedAt: 10 } : a);
  assert.deepEqual(names(widgetAgents(two)), ["Agent H", "Agent G", "Agent A", "Agent B", "Agent C"]);
  // 5 pinned → exactly those five.
  const five = eight.map((a, i) => i >= 3 ? { ...a, pinnedAt: i } : a);
  assert.deepEqual(names(widgetAgents(five)), ["Agent D", "Agent E", "Agent F", "Agent G", "Agent H"]);
  // 7 pinned → all seven, none other, whatever their state.
  const seven = eight.map((a, i) => i ? { ...a, pinnedAt: 100 - i, bloub: { ...a.bloub, activity: BLOUB_ACTIVITIES[i % 4] } } : a);
  const shown = widgetAgents(seven);
  assert.equal(shown.length, 7);
  assert.ok(shown.every(a => a.pinnedAt !== null));
  assert.ok(shown.some(a => a.bloub.activity === "unavailable") && shown.some(a => a.bloub.activity === "sleeping"), "sleeping or unavailable pinned agents stay visible");
  // Equal pin times and equal names break ties on id.
  const ties = [{ ...agent(2, 5), name: "Même" }, { ...agent(1, 5), name: "Même" }, { ...agent(4), name: "Zoé" }, { ...agent(3), name: "zoe" }];
  assert.deepEqual(widgetAgents(ties).map(a => a.handle), ["agent1", "agent2", "agent3", "agent4"]);
});

test("widget rendering: real activities, links, pin toggles, see-all and empty states", () => {
  const html = render(BLOUB_ACTIVITIES.map((activity, i) => agent(i + 1, i === 2 ? 1 : null, activity)));
  for (const activity of BLOUB_ACTIVITIES) assert.match(html, new RegExp(`data-activity="${activity}"`), activity);
  for (const label of ["En veille", "Disponible", "Au travail", "Indisponible"]) assert.ok(html.includes(label), label);
  assert.equal((html.match(/data-animating="false"/g) ?? []).length, 4, "server rendering is a still frame");
  assert.equal((html.match(/data-activity="idle"/g) ?? []).length, 1, "not neutralised like identity avatars");
  assert.ok(html.indexOf("Agent C") < html.indexOf("Agent A"), "pinned agent first");
  assert.match(html, new RegExp(`href="/dashboard/xiagents/${agent(1).id}"`));
  assert.equal((html.match(/aria-pressed="true"/g) ?? []).length, 1);
  assert.equal((html.match(/aria-pressed="false"/g) ?? []).length, 3);
  assert.match(html, /aria-label="Épingler Agent C"/);
  assert.match(html, /<h2[^>]*>ΞAgents<\/h2>/);
  assert.match(html, /href="\/dashboard\/xiagents"[^>]*>Voir tous</);
  const empty = render([]);
  assert.match(empty, /aucun ΞAgent/); assert.match(empty, />Créer un ΞAgent</); assert.doesNotMatch(empty, /<li/);
  assert.match(render(null), /Chargement des ΞAgents/);
});

test("widget categories: selector, system agents linked to their card, see-all keeps the category", () => {
  const system = (n: number, pinnedAt: number | null = null): XiAgentSummary => ({ ...agent(n, pinnedAt), handle: `system${n}`, category: "system" });
  const editorial = render([agent(1)], [system(2)]);
  assert.match(editorial, /aria-label="Catégorie de ΞAgents"/);
  assert.ok(editorial.includes("Agents éditoriaux") && editorial.includes("Agent A") && !editorial.includes("Agent B"), "only the selected category");
  const seven = Array.from({ length: 7 }, (_, i) => system(i + 1, i === 6 ? 1 : null));
  const html = render(null, seven, "system");
  assert.ok(html.includes("Agents systèmes"));
  assert.equal((html.match(/<li/g) ?? []).length, 5, "five at most, also for system agents");
  assert.ok(html.indexOf("Agent G") < html.indexOf("Agent A"), "pinned system agent first");
  assert.match(html, /href="\/dashboard\/xiagents\?category=system#agent-system7"/);
  assert.match(html, /href="\/dashboard\/xiagents\?category=system"[^>]*>Voir tous</);
  assert.match(render(null, [], "system"), /Aucun agent système disponible/);
  assert.doesNotMatch(render(null, [], "system"), /Créer un ΞAgent/);
  assert.match(render([agent(1)], null, "system"), /Chargement des ΞAgents/, "a category never loaded is fetched");

  assert.deepEqual([undefined, null, "", "editorial", "system", "autre", "System"].map(parseCategory), ["editorial", "editorial", "editorial", "editorial", "system", null, null]);
  assert.equal(xiAgentsHref("editorial"), "/dashboard/xiagents");
  assert.equal(xiAgentHref(agent(1)), `/dashboard/xiagents/${agent(1).id}`);
});

test("pins: owner-only, persisted per user, idempotent, independent of activation", async t => {
  const root = await mkdtemp(join(tmpdir(), "xi-pins-"));
  const dbPath = join(root, "app.sqlite");
  let db = new Database(dbPath);
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  await mkdir(join(root, "vault"));
  const vault = await openVault(join(root, "vault"));
  const topics = createTopicStore({ vault, db });
  let accounts = createAccountStore({ vault, db, topics });
  const run = await topics.propose("alice", "Un jardin fictif");
  await topics.confirm("alice", run.id, { tag: "jardin", name: "Jardin", description: "Test", scope: "Simulation fictive", parentId: null, relatedIds: [] }, true);
  const proposed = await accounts.propose("alice", run.topicId);
  const ready = await accounts.resume("alice", proposed.id);
  await accounts.confirm("alice", ready.id, ready.draft, true);
  const id = ready.accountId!;
  const before = await accounts.getOwned("alice", id);

  assert.equal(accounts.pins("alice").size, 0);
  await accounts.setPin("alice", id, { pinned: true });
  const at = accounts.pins("alice").get(id)!;
  assert.ok(at > 0);
  await accounts.setPin("alice", id, { pinned: true });
  assert.equal(accounts.pins("alice").get(id), at, "pinning again keeps the pin time");
  assert.deepEqual(await accounts.getOwned("alice", id), before, "pinning never changes the agent");

  // Another user can neither pin nor unpin someone else's agent, and never sees their pins.
  await assert.rejects(accounts.setPin("bob", id, { pinned: true }), /introuvable/);
  await assert.rejects(accounts.setPin("bob", id, { pinned: false }), /introuvable/);
  assert.equal(accounts.pins("bob").size, 0);
  assert.equal(accounts.pins("alice").get(id), at);
  for (const input of [{ pinned: "yes" }, { pinned: true, userId: "bob" }, {}]) await assert.rejects(accounts.setPin("alice", id, input));
  await assert.rejects(accounts.setPin("alice", "not-a-uuid", { pinned: true }), /introuvable/);

  // Survives a restart (new connection and store on the same database).
  db.close(); db = new Database(dbPath);
  accounts = createAccountStore({ vault, db, topics: createTopicStore({ vault, db }) });
  assert.equal(accounts.pins("alice").get(id), at);
  await accounts.setPin("alice", id, { pinned: false });
  assert.equal(accounts.pins("alice").size, 0);
});
