import assert from "node:assert/strict";
import { test } from "node:test";
import { createCommandEngine, createCommandRegistry, type CommandRegistry } from "@cmdly/core";
import { xiCommands, type XiCommandRuntime } from "../src/lib/commands/registry";
import { publicationCommands, type PublicationCommandRuntime, type PublicationListScope } from "../src/lib/publications/commands";
import { publicationLabel } from "../src/lib/publications/commands/find-publication";
import type { PublicationSnapshot } from "../src/lib/publications/types";
import { xiAgentCommands } from "../src/lib/xiagents/commands";
import type { XiAgentCategory, XiAgentSummary } from "../src/lib/xiagents/summary";

// The real registries with in-memory services: no React, no Next.js, no HTTP.
const publication = (id: string, summary: string, status: "draft" | "published" = "published") =>
  ({ id, summary, status, messages: [] }) as unknown as PublicationSnapshot;
const agent = (id: string, name: string, category: XiAgentCategory = "editorial") =>
  ({ id, name, handle: name.toLowerCase(), category }) as XiAgentSummary;

function fakeRuntime(overrides: Partial<{ pathname: string; publications: Record<PublicationListScope, () => Promise<PublicationSnapshot[]>>; agents: Partial<Record<XiAgentCategory, XiAgentSummary[]>> }> = {}) {
  const visits: string[] = [], listed: string[] = [];
  const lists = overrides.publications ?? {
    own: async () => [publication("p-own", "Mon brouillon", "draft")],
    feed: async () => [publication("p-feed-1", "Élections municipales"), publication("p-feed-2", "Canicule")],
  };
  const runtime: XiCommandRuntime = {
    pathname: overrides.pathname ?? "/dashboard",
    navigate: href => { visits.push(href); },
    publications: { list: scope => { listed.push(scope); return lists[scope](); } },
    agents: { list: async category => { listed.push(category); return overrides.agents?.[category] ?? []; } },
  };
  return { runtime, visits, listed };
}

function engineFor<TRuntime>(registry: CommandRegistry<undefined, TRuntime, true>, runtime: TRuntime) {
  const engine = createCommandEngine({ registry, runtime: () => runtime as never });
  const labels = () => engine.getSnapshot().items.map(item => item.label);
  const choose = (label: string) => {
    const index = labels().indexOf(label);
    assert.notEqual(index, -1, `"${label}" is offered (got ${JSON.stringify(labels())})`);
    engine.select(index);
  };
  type Snapshot = ReturnType<typeof engine.getSnapshot>;
  const settled = () => new Promise<Snapshot>(resolve => {
    const check = () => { const snapshot = engine.getSnapshot(); if (!snapshot.loading && !snapshot.running) { stop(); resolve(snapshot); } };
    const stop = engine.subscribe(check);
    queueMicrotask(check);
  });
  return { engine, labels, choose, settled };
}

test("composition: each module's commands are discovered under its namespace, without collisions", () => {
  const ids = xiCommands.list().map(command => command.id);
  assert.deepEqual(ids.filter(id => !id.endsWith("test-cmdly")), ["publications.go-to", "publications.find", "xiagents.find", "xiagents.create-publication"]);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(xiCommands.resolve("xiagents.find")?.runtimeRequired, true);
  // Collisions are refused by Cmdly itself: a namespace taken twice, an id registered twice.
  const root = createCommandRegistry<undefined, XiCommandRuntime>({ shared: undefined, runtimeRequired: true });
  root.mount("publications", publicationCommands);
  assert.throws(() => root.mount("publications", xiAgentCommands), /Duplicate registry entry: publications/);
  const child = createCommandRegistry<undefined, PublicationCommandRuntime>({ shared: undefined, runtimeRequired: true });
  child.register({ id: "find", label: "A", run: () => {} });
  assert.throws(() => child.register({ id: "find", label: "B", run: () => {} }), /Duplicate registry entry: find/);
});

test("a module registry runs on its own, with only the runtime it declares", async () => {
  const visits: string[] = [];
  const runtime: PublicationCommandRuntime = { pathname: "/dashboard", navigate: href => { visits.push(href); }, publications: { list: async () => [publication("solo", "Seule")] } };
  const { choose, settled } = engineFor(publicationCommands, runtime);
  choose("Rechercher une publication");
  choose("Fil récent");
  await settled();
  choose("Seule");
  await settled();
  assert.deepEqual(visits, ["/dashboard/publications/solo"]);
});

test("simple command: navigates and closes; hidden on its own page", async () => {
  const { runtime, visits } = fakeRuntime();
  const { engine, choose, settled } = engineFor(xiCommands, runtime);
  engine.setQuery("aller aux");
  choose("Aller aux publications");
  await settled();
  assert.deepEqual(visits, ["/dashboard/publications"]);
  assert.equal(engine.getSnapshot().closed, true);

  const there = engineFor(xiCommands, fakeRuntime({ pathname: "/dashboard/publications" }).runtime);
  assert.ok(!there.labels().includes("Aller aux publications"));
  assert.ok(there.labels().includes("Rechercher une publication"));
});

test("multi-step workflow: scope, then publications loaded for that scope, then the chosen one opens", async () => {
  const { runtime, visits, listed } = fakeRuntime();
  const { engine, labels, choose, settled } = engineFor(xiCommands, runtime);
  choose("Rechercher une publication");
  let state = engine.getSnapshot();
  assert.equal(state.step?.label, "Où chercher ?");
  assert.deepEqual(state.progress && [state.progress.current, state.progress.total], [0, 2]);
  choose("Mes publications et brouillons");
  assert.equal(engine.getSnapshot().loading, true);
  state = await settled();
  assert.equal(state.step?.label, "Publication");
  assert.deepEqual(state.answers, { scope: "own" }, "the first answer is kept for the next step");
  assert.deepEqual(labels(), ["Brouillon · Mon brouillon"]);
  assert.deepEqual(listed, ["own"]);

  // Back to the first step, another scope: the second step reloads for it.
  engine.back();
  assert.equal(engine.getSnapshot().step?.label, "Où chercher ?");
  choose("Fil récent");
  await settled();
  assert.deepEqual(listed, ["own", "feed"]);
  assert.deepEqual(engine.getSnapshot().answers, { scope: "feed" });
  engine.setQuery("canic");
  assert.deepEqual(labels(), ["Canicule"]);
  choose("Canicule");
  await settled();
  assert.deepEqual(visits, ["/dashboard/publications/p-feed-2"]);
  assert.equal(engine.getSnapshot().closed, true);
});

test("back to the menu, cancel during a load: nothing runs and the late result is ignored", async () => {
  let release!: (items: PublicationSnapshot[]) => void;
  const pending = new Promise<PublicationSnapshot[]>(resolve => { release = resolve; });
  const { runtime, visits } = fakeRuntime({ publications: { own: () => pending, feed: () => pending } });
  const { engine, choose } = engineFor(xiCommands, runtime);
  choose("Rechercher une publication");
  engine.back();
  assert.equal(engine.getSnapshot().phase, "menu");
  assert.equal(engine.getSnapshot().canBack, false);
  choose("Rechercher une publication");
  choose("Fil récent");
  engine.close();
  release([publication("late", "Trop tard")]);
  await new Promise(resolve => setTimeout(resolve, 0));
  const state = engine.getSnapshot();
  assert.equal(state.closed, true);
  assert.deepEqual(state.items, []);
  assert.deepEqual(visits, []);
});

test("load errors are shown and retried; an empty result is not an error", async () => {
  let fail = true;
  const { runtime } = fakeRuntime({ publications: {
    own: async () => [],
    feed: async () => { if (fail) throw new Error("Publications indisponibles. Réessayez."); return [publication("p", "Revenue")]; },
  } });
  const { engine, labels, choose, settled } = engineFor(xiCommands, runtime);
  choose("Rechercher une publication");
  choose("Fil récent");
  let state = await settled();
  assert.equal(state.loadFailed, true);
  assert.equal((state.error as Error).message, "Publications indisponibles. Réessayez.");
  fail = false;
  engine.retry();
  state = await settled();
  assert.equal(state.loadFailed, false);
  assert.deepEqual(labels(), ["Revenue"]);

  engine.back();
  choose("Mes publications et brouillons");
  state = await settled();
  assert.deepEqual([state.items.length, state.loadFailed, state.error], [0, false, null]);
});

test("ΞAgents: search lists both categories; creating a publication offers own editorial agents and opens their generator", async () => {
  const agents = { editorial: [agent("a1", "Politique")], system: [agent("s1", "Arbitre", "system")] };
  const { runtime, visits, listed } = fakeRuntime({ agents });
  const find = engineFor(xiCommands, runtime);
  find.choose("Rechercher un ΞAgent");
  await find.settled();
  assert.deepEqual(find.labels(), ["Politique · @politique", "Arbitre · @arbitre (système)"]);
  find.choose("Arbitre · @arbitre (système)");
  await find.settled();

  const create = engineFor(xiCommands, runtime);
  create.choose("Créer une publication pour un ΞAgent");
  await create.settled();
  assert.deepEqual(create.labels(), ["Politique · @politique"]);
  create.choose("Politique · @politique");
  await create.settled();
  assert.deepEqual(visits, ["/dashboard/xiagents?category=system#agent-arbitre", "/dashboard/xiagents/a1#publication-generator"]);
  assert.deepEqual(listed, ["editorial", "system", "editorial"]);
});

test("publication labels: summary, else first live message, drafts marked", () => {
  assert.equal(publicationLabel({ summary: "", status: "published", messages: [{ file: "1", body: "", deleted: false }, { file: "2", body: "## Titre\n\n**gras**" }] }), "Titre gras");
  assert.equal(publicationLabel({ summary: "", status: "draft", messages: [] }), "Brouillon · Sans titre");
  assert.equal(publicationLabel({ summary: "x".repeat(200), status: "published", messages: [] }).length, 90);
});


test("tags and global provenance survive unique display in an active registry", () => {
  assert.ok(xiCommands.listByTag("search").some(command => command.id === "publications.find"));
  assert.equal(xiCommands.resolve("xiagents.find")?.sourceRegistry, "xiagents");
  assert.equal(xiCommands.resolve("publications.test-cmdly")?.isGlobal, true);
  const engine = createCommandEngine({ registry: xiCommands, runtime: () => fakeRuntime().runtime, globalDisplay: "unique", activeRegistry: "publications" });
  assert.equal(engine.getSnapshot().items.filter(item => item.label === "🧪 Test Cmdly global").length, 1);
  engine.destroy();
  const registry = createCommandRegistry({ tags: { search: { label: "Recherche" } } });
  registry.register({ id: "find", label: "Find", tags: ["search"], tagOverrides: { search: { label: "Locale" } }, run: () => {} });
  assert.equal(registry.resolveTagDefinition("search", registry.get("find")).label, "Locale");
  // @ts-expect-error unknown tags must be rejected
  if (false) registry.register({ id: "invalid", label: "Invalid", tags: ["unknown"], run: () => {} });
});
