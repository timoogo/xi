import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { createAccountStore } from "../src/lib/accounts/store";
import { openVault } from "../src/lib/publications/vault";
import { createTopicStore } from "../src/lib/topics/store";
import type { PoliteFetch } from "../src/lib/watch/net";
import { createSourceStore } from "../src/lib/watch/sources";
import { createDeployments } from "../src/lib/xiagents/deployments";
import { applySuggestion, draftToSpec, editDraft, newDraft } from "../src/lib/xiagents/draft";
import { draftToYaml, parseAgentYaml } from "../src/lib/xiagents/yaml";

/** P3: sources excluded by a YAML file stay excluded, visibly, until the owner explicitly decides otherwise. */
const RSS = Buffer.from(`<?xml version="1.0"?><rss version="2.0"><channel><title>Flux</title><link>https://example.org/</link><item><title>A</title><link>https://example.org/a</link><pubDate>Mon, 19 Oct 2026 10:00:00 GMT</pubDate></item></channel></rss>`);
const YAML = `xiagent: 1
identity: { name: Veille, handle: veille-exclusions }
topics: { primary: science }
sources:
  - { url: "https://promo.example/", status: excluded, rationale: Promotionnel }
  - { url: "https://revue.example/", status: approved }
`;

test("exclusions: kept through edits, suggestions, export and re-import; re-authorised only explicitly; deployed as decided", async t => {
  const root = await mkdtemp(join(tmpdir(), "xi-exclusions-"));
  const vault = await openVault(root);
  const db = new Database(":memory:");
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  const topics = createTopicStore({ vault, db });
  const accounts = createAccountStore({ vault, db, topics });
  const sources = createSourceStore({ vault, topics });
  const fetch = (async (url: string) => ({ status: 200, url, headers: { "content-type": "application/rss+xml" }, body: RSS })) as unknown as PoliteFetch;
  const deployments = createDeployments({ vault, db, accounts, topics, sources, fetch, readiness: () => ({ inference: { configured: false, model: null, error: null }, autoPublish: false, workerLastTickAt: null }) });
  await topics.create("alice", randomUUID(), { tag: "science", name: "Science", description: "", scope: "Recherche", parentId: null, relatedIds: [] });
  const catalog = await topics.list();
  const presets = await accounts.listPresets("alice");
  const context = { catalog, presets };

  const imported = parseAgentYaml(YAML, context);
  assert.ok(imported.ok);
  assert.deepEqual(imported.patch.sources!.map(source => [source.domain, source.status, source.origin]), [["promo.example", "excluded", "yaml"], ["revue.example", "undecided", "yaml"]]);
  let draft = applySuggestion(newDraft({ presets, timeZone: "Europe/Paris" }), imported.patch, "yaml");

  // Other edits and later suggestions (same domain proposed again) never lift the exclusion.
  draft = editDraft(draft, { name: "Veille modifiée" });
  draft = applySuggestion(draft, { sources: [{ url: "https://promo.example/", domain: "promo.example", type: "média", rationale: "", origin: "ai", status: "undecided" }] }, "ai", "m");
  assert.equal(draft.sources.find(source => source.domain === "promo.example")!.status, "excluded");

  // Export → re-import keeps the exclusion (an approval is never carried over automatically).
  const again = parseAgentYaml(draftToYaml(draft, catalog), context);
  assert.ok(again.ok);
  assert.deepEqual(again.patch.sources!.map(source => [source.domain, source.status]), [["promo.example", "excluded"], ["revue.example", "undecided"]]);

  // Deployment without any decision: the exclusion is recorded as a rejected source, nothing approved.
  const first = randomUUID();
  await deployments.create("alice", first, draftToSpec(draft));
  assert.equal((await deployments.run("alice", first)).state, "completed");
  const stored = (await sources.list("alice")).sources;
  assert.deepEqual(stored.map(source => [new URL(source.url).hostname, source.status]), [["promo.example", "rejected"]]);

  // Explicit re-authorisation by the owner, through the ordinary decision of the editor.
  const reauthorised = editDraft(draft, { handle: "veille-exclusions-2", sources: draft.sources.map(source => ({ ...source, status: "approved" as const })) });
  const spec = draftToSpec(reauthorised);
  assert.deepEqual(spec.agent!.sources.map(source => [new URL(source.url).hostname, source.status]), [["promo.example", "approved"], ["revue.example", "approved"]]);
  const second = randomUUID();
  await deployments.create("alice", second, spec);
  assert.equal((await deployments.run("alice", second)).state, "completed");
  assert.ok((await sources.list("alice")).sources.every(source => source.status === "approved"));
});
