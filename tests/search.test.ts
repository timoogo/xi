import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import Database from "better-sqlite3";
import { createAccountStore } from "../src/lib/accounts/store";
import { serializeGenerator } from "../src/lib/graph/format";
import { openVault, writeAtomic } from "../src/lib/publications/vault";
import { normalizeHandle, normalizeTag, parseSearchQuery, searchHref, topicHref } from "../src/lib/search/query";
import { resolveTopic, searchCatalog, topicAgents, type SearchAgent } from "../src/lib/search/resolve";
import { searchData } from "../src/lib/search/server";
import { createTopicStore } from "../src/lib/topics/store";
import type { Topic } from "../src/lib/topics/types";

const at = "2026-10-27T00:00:00.000Z";
function topic(tag: string, extra: Partial<Topic> = {}): Topic {
  return { id: randomUUID(), tag, name: tag, description: "", scope: `Périmètre ${tag}`, parentId: null, relatedIds: [], aliases: [], createdAt: at, updatedAt: at, createdBy: "alice", updatedBy: "alice", revision: randomUUID(), ...extra };
}
const agent = (handle: string, extra: Partial<SearchAgent> = {}): SearchAgent => ({ id: randomUUID(), handle, name: handle, description: "", primaryTopicId: null, secondaryTopicIds: [], ...extra });

test("query syntax: text, #topics and @agents, normalized and deduplicated", () => {
  assert.deepEqual(parseSearchQuery("transport"), { text: "transport", topics: [], agents: [] });
  assert.deepEqual(parseSearchQuery("  #Transport, rail #transport @Science.Bot! #Élections.Françaises "), {
    text: "rail", topics: ["transport", "elections.francaises"], agents: ["science.bot"],
  });
  // Invalid references stay text instead of disappearing.
  assert.deepEqual(parseSearchQuery("# #2026 @ @-"), { text: "# #2026 @ @-", topics: [], agents: [] });
  assert.equal(normalizeTag("#Mobilité douce"), "mobilite-douce");
  assert.equal(normalizeTag("#a..b."), "a.b");
  assert.equal(normalizeTag("#9"), null);
  assert.equal(normalizeHandle("@NASA"), "nasa");
  assert.equal(parseSearchQuery(Array.from({ length: 20 }, (_, i) => `#t${String.fromCharCode(97 + i)}`).join(" ")).topics.length, 10);
  assert.equal(topicHref("politiks.france"), "/dashboard/topics/politiks.france");
  assert.equal(searchHref("#a b"), "/dashboard/explore?q=%23a%20b");
});

test("topic resolution: exact tag, former tag, unique last segment, never an ambiguous guess", () => {
  const politics = topic("politiks");
  const france = topic("politiks.france", { parentId: politics.id, aliases: ["politique-fr"] });
  const sport = topic("sport.france");
  const transport = topic("transport");
  const all = [politics, france, sport, transport];
  assert.deepEqual(resolveTopic(all, "politiks.france"), { topic: france, via: "tag" });
  assert.deepEqual(resolveTopic(all, "politique-fr"), { topic: france, via: "alias" });
  // Last segments are only used by the search, and only when unambiguous.
  assert.equal(resolveTopic(all, "transport", { segments: true })?.via, "tag");
  assert.equal(resolveTopic(all, "france", { segments: true }), null);
  assert.equal(resolveTopic([politics, france], "france"), null);
  assert.deepEqual(resolveTopic([politics, france], "france", { segments: true }), { topic: france, via: "segment" });

  const ambiguous = searchCatalog("#france", all, []);
  assert.equal(ambiguous.redirect, null);
  assert.deepEqual(new Set(ambiguous.topics[0].candidates.map(t => t.id)), new Set([france.id, sport.id]));
  assert.equal(searchCatalog("#politique-fr", all, []).redirect, "/dashboard/topics/politiks.france");
  assert.equal(searchCatalog("#inconnu", all, []).topics[0].match, null);
});

test("crossed search, agents, text matching and direct navigation", () => {
  const climate = topic("climat", { name: "Climat", scope: "Réchauffement climatique et transport" });
  const transport = topic("transport", { name: "Transport", relatedIds: [climate.id] });
  const rail = topic("transport.rail", { name: "Ferroviaire", parentId: transport.id });
  const bot = agent("mobilite", { name: "Mobilité", description: "Veille transport", primaryTopicId: transport.id });
  const other = agent("rail.watch", { secondaryTopicIds: [transport.id] });
  const all = [climate, transport, rail];

  const crossed = searchCatalog("#transport #climat #transport.rail", all, [bot]);
  assert.equal(crossed.redirect, null);
  assert.deepEqual(crossed.links, [
    { from: transport.id, to: climate.id, kind: "related" },
    { from: transport.id, to: rail.id, kind: "parent" },
  ]);
  assert.equal(searchCatalog("@mobilite", all, [bot]).redirect, `/dashboard/profiles/${bot.id}`);
  assert.equal(searchCatalog("@mobilite transport", all, [bot]).redirect, null);
  assert.deepEqual(searchCatalog("@mobil", all, [bot]).agents[0].candidates, [bot]);

  const text = searchCatalog("transport", all, [bot, other]);
  assert.equal(text.redirect, null);
  assert.deepEqual(text.textTopics.map(t => t.id).slice(0, 1), [transport.id]);
  assert.ok(text.textTopics.some(t => t.id === climate.id), "scope matches are included after identity matches");
  assert.deepEqual(text.textAgents, [bot]);
  assert.deepEqual(topicAgents(transport.id, [other, bot]).map(item => [item.agent.handle, item.role]), [["mobilite", "principal"], ["rail.watch", "secondaire"]]);
});

test("search data: shared catalogue, but only the ΞAgents the viewer may see", async (t: TestContext) => {
  const root = await mkdtemp(join(tmpdir(), "xi-search-"));
  const vault = await openVault(root);
  const db = new Database(":memory:");
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  const topics = createTopicStore({ vault, db });
  const accounts = createAccountStore({ vault, db, topics });
  const shared = await topics.create("alice", randomUUID(), { tag: "science", name: "Science", description: "", scope: "Science", parentId: null, relatedIds: [] });
  for (const [slug, visibility] of [["alice-private", "private"], ["alice-public", "public"]] as const) {
    await mkdir(join(root, "generators", slug), { recursive: true });
    await writeAtomic(join(root, "generators", slug, "index.md"), serializeGenerator({ id: randomUUID(), slug, title: slug, ownerId: "alice", visibility, createdAt: at }));
  }
  const forBob = await searchData("bob", { topics, accounts });
  assert.deepEqual(forBob.topics.map(t => t.id), [shared.topic.id]);
  assert.deepEqual(forBob.agents.map(a => a.handle), ["alice-public"]);
  assert.equal(searchCatalog("@alice-private", forBob.topics, forBob.agents).agents[0].agent, null);
  assert.ok(!searchCatalog("@alice-private", forBob.topics, forBob.agents).agents[0].candidates.some(a => a.handle === "alice-private"));
  const forAlice = await searchData("alice", { topics, accounts });
  assert.deepEqual(forAlice.agents.map(a => a.handle).sort(), ["alice-private", "alice-public"]);
});
