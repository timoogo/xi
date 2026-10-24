import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import Database from "better-sqlite3";
import { createAccountStore } from "../src/lib/accounts/store";
import { BUILTIN_PRESETS } from "../src/lib/accounts/types";
import { DEFAULT_BLOUB_CONFIG } from "../src/lib/bloub/config";
import { openVault } from "../src/lib/publications/vault";
import { createTopicStore } from "../src/lib/topics/store";
import type { Topic } from "../src/lib/topics/types";
import type { PoliteFetch } from "../src/lib/watch/net";
import { createSourceStore } from "../src/lib/watch/sources";
import { createDeployments, type DeploymentSpec } from "../src/lib/xiagents/deployments";
import { applySuggestion, draftIssues, newDraft, newTopicKey, type AgentDraft, type DraftField } from "../src/lib/xiagents/draft";
import { exportAgentDraft } from "../src/lib/xiagents/export";
import { defaultSchedule } from "../src/lib/xiagents/schedule";
import { AGENT_YAML_VERSION, MAX_YAML_BYTES, draftToYaml, parseAgentYaml } from "../src/lib/xiagents/yaml";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const topic = (tag: string, name: string, extra: Partial<Topic> = {}): Topic => ({
  id: randomUUID(), tag, name, description: "", scope: `Périmètre ${name}`, parentId: null, relatedIds: [], aliases: [],
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", createdBy: "alice", updatedBy: "alice", revision: randomUUID(), ...extra,
});
const science = topic("science", "Science");
const astro = topic("astronomie", "Astronomie", { aliases: ["astro"] });
const catalog = [science, astro];
const context = { catalog, presets: BUILTIN_PRESETS };
const errors = <T extends { level: string }>(issues: T[]) => issues.filter(issue => issue.level === "error");

const FULL = `xiagent: 1
kind: agent
identity:
  name: Veille exoplanètes
  handle: "@exoplanetes"
  description: Découvertes d’exoplanètes.
topics:
  primary:
    tag: astronomie.exoplanetes
    name: Exoplanètes
    scope: Détection et caractérisation des exoplanètes
    parent: astro
    related: [science]
  secondary: [science]
editorial:
  perimeter: Publications scientifiques.
  charter: |-
    Citer l’étude primaire.
    Distinguer annonces et résultats.
style:
  preset: pedagogue@1
  depth: approfondi
  model: qwen3:8b
sources:
  - url: https://arxiv.example/astro-ph
    type: prépublications
    rationale: Source primaire
    status: approved
  - url: https://blog.example/
    status: excluded
  - https://nasa.example/feed
schedule:
  timeZone: America/New_York
  watch:
    week:
      lundi: ["08:00-20:00"]
      mardi: ["08:00-12:00", "22:00-02:00"]
      dimanche: []
    exceptions:
      "2026-12-25": []
  publish:
    week: [["06:00-07:00"], [], [], [], [], [], ["00:00-24:00"]]
  graceMinutes: 15
  catchUpHours: 24
  majorEvents: true
  retentionDays: 90
publication:
  autoPublish: true
appearance:
  color: bleu
`;

test("yaml: full import resolves topics, preset, sources, calendars and appearance", () => {
  const result = parseAgentYaml(FULL, context);
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  if (!result.ok) return;
  assert.deepEqual(errors(result.issues), []);
  const { patch } = result;
  assert.equal(result.target, "agent");
  assert.equal(patch.name, "Veille exoplanètes"); assert.equal(patch.handle, "exoplanetes");
  assert.equal(patch.topics!.length, 2);
  const [primary, secondary] = patch.topics!;
  assert.equal(primary.type, "new");
  if (primary.type === "new") {
    assert.equal(primary.key, "new-1");
    assert.equal(primary.draft.parentId, astro.id, "parent resolved through an alias");
    assert.deepEqual(primary.draft.relatedIds, [science.id]);
  }
  assert.deepEqual(secondary, { type: "existing", id: science.id });
  assert.equal(patch.presetKey, "pedagogue:1");
  assert.equal(patch.settings!.depth, "approfondi"); assert.equal(patch.settings!.tone, BUILTIN_PRESETS[1].settings.tone);
  assert.equal(patch.modelRef, "qwen3:8b");
  assert.match(patch.charter!, /\nDistinguer/);
  assert.deepEqual(patch.sources!.map(s => [s.domain, s.status, s.origin]), [["arxiv.example", "undecided", "yaml"], ["blog.example", "excluded", "yaml"], ["nasa.example", "undecided", "yaml"]]);
  assert.ok(result.issues.some(issue => issue.level === "warning" && issue.path === "sources" && /réapprouver/.test(issue.message)));
  const schedule = patch.schedule!;
  assert.equal(schedule.timeZone, "America/New_York");
  assert.deepEqual(schedule.watch.week[0], [{ start: 480, end: 1200 }]);
  assert.deepEqual(schedule.watch.week[1], [{ start: 480, end: 720 }, { start: 1320, end: 120 }], "range across midnight");
  assert.deepEqual(schedule.watch.week[2], [], "unlisted day is closed");
  assert.deepEqual(schedule.watch.exceptions, { "2026-12-25": [] });
  assert.deepEqual(schedule.publish.week[6], [{ start: 0, end: 1440 }]);
  assert.equal(schedule.graceMinutes, 15); assert.equal(schedule.majorEvents.enabled, true); assert.equal(schedule.retentionDays, 90);
  assert.equal(patch.autoPublish, true);
  assert.deepEqual(patch.bloub, { ...DEFAULT_BLOUB_CONFIG, color: "bleu" });
  const draft = applySuggestion(newDraft({ presets: BUILTIN_PRESETS, timeZone: "Europe/Paris" }), patch, "yaml");
  assert.deepEqual(draftIssues(draft, catalog, BUILTIN_PRESETS), []);
  assert.equal(draft.sources.every(source => source.status !== "approved"), true, "never approved automatically");
});

test("yaml: partial import only patches the given fields; missing details are completed with warnings", () => {
  const result = parseAgentYaml("xiagent: 1\nidentity:\n  name: Veille\ntopics:\n  primary: { tag: climat.glaciers }\n", context);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.deepEqual(Object.keys(result.patch).sort(), ["name", "topics"]);
  const [pick] = result.patch.topics!;
  assert.equal(pick.type, "new");
  if (pick.type === "new") { assert.equal(pick.draft.name, "Glaciers"); assert.ok(pick.draft.scope.length > 0); }
  assert.ok(result.issues.some(issue => issue.level === "warning" && issue.path === "topics.primary" && /complété/.test(issue.message)));
  const unknownParent = parseAgentYaml("xiagent: 1\ntopics:\n  primary: { tag: x.y, name: Y, scope: S, parent: inconnu }\n", context);
  assert.ok(unknownParent.ok && unknownParent.patch.topics![0].type === "new" && unknownParent.patch.topics![0].draft.parentId === null);
  assert.ok(unknownParent.issues.some(issue => issue.path === "topics.primary.parent" && issue.level === "warning"));
  const topicOnly = parseAgentYaml("xiagent: 1\nkind: topic\ntopics:\n  primary: { tag: science.climat, name: Climat, scope: Climat, parent: science }\nidentity: { name: X }\n", context);
  assert.ok(topicOnly.ok && topicOnly.target === "topic" && !("name" in topicOnly.patch));
  assert.ok(topicOnly.issues.some(issue => issue.path === "identity" && issue.level === "warning"));
});

test("yaml: unknown keys are warnings; invalid fields are located errors", () => {
  const result = parseAgentYaml(`xiagent: 1
extra: 1
identity: { name: A, handle: "Pas Valide", couleur: rouge }
style: { depth: immense }
sources: [{ url: "ftp://x.example/" }, { url: "https://ok.example/", status: maybe }]
schedule:
  timeZone: Europe/Paris
  watch: { week: { lundi: ["25:00-26:00"], funday: [] } }
  graceMinutes: 999
appearance: { shape: inexistante }
publication: { autoPublish: "oui" }
`, context);
  assert.ok(result.ok);
  if (!result.ok) return;
  const paths = (level: string) => result.issues.filter(issue => issue.level === level).map(issue => issue.path);
  assert.deepEqual(paths("warning").sort(), ["extra", "identity.couleur", "schedule.watch.week.funday"]);
  assert.deepEqual(paths("error").sort(), ["appearance.shape", "identity.handle", "publication.autoPublish", "schedule.graceMinutes", "schedule.watch.week.lundi[0]", "sources[0].url", "sources[1].status", "style.depth"].sort());
  assert.ok(result.issues.every(issue => issue.message.length > 5));
  assert.deepEqual(Object.keys(result.patch), ["name"], "invalid fields are left out");
});

test("yaml: refuses syntax errors, versions, types, size, custom tags and alias bombs", () => {
  const fatal = (text: string, pattern: RegExp) => {
    const result = parseAgentYaml(text, context);
    assert.equal(result.ok, false, text.slice(0, 60));
    assert.match(result.issues[0].message, pattern);
  };
  fatal("xiagent: 1\nidentity: [a", /Syntaxe YAML invalide \(ligne/);
  fatal("xiagent: 1\nxiagent: 1\n", /Clé en double/);
  fatal("identity: { name: A }\n", /Version du format absente/);
  fatal("xiagent: 2\n", /Version incompatible/);
  fatal("xiagent: \"1\"\n", /entier attendu/);
  fatal("- a\n- b\n", /configuration/);
  fatal("xiagent: 1\nkind: robot\n", /agent ou topic/);
  fatal(`xiagent: 1\nidentity: { description: "${"a".repeat(MAX_YAML_BYTES)}" }\n`, /trop volumineux/);
  fatal("xiagent: 1\nidentity:\n  name: !!js/function 'function () { return 1 }'\n", /étiquettes YAML personnalisées/);
  fatal("xiagent: 1\nidentity: !custom { name: A }\n", /étiquettes YAML personnalisées/);
  fatal("xiagent: 1\na: &a [x,x,x,x,x,x,x,x,x]\nb: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]\nc: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]\nd: [*c,*c,*c,*c,*c,*c,*c,*c,*c]\n", /alias/);
  fatal("xiagent: 1\nx: [[[[[[[[[[1]]]]]]]]]]\n", /profonde/);
  fatal("", /vide/);
  // Wrong types are field errors, not crashes.
  const types = parseAgentYaml("xiagent: 1\nidentity: texte\ntopics: { primary: [1] }\nsources: { url: x }\nschedule: { watch: { week: [[], []] } }\n", context);
  assert.ok(types.ok);
  assert.deepEqual(errors(types.issues).map(issue => issue.path).sort(), ["identity", "schedule.watch.week", "sources", "topics.primary"]);
  // List limits.
  const many = parseAgentYaml(`xiagent: 1\nsources:\n${Array.from({ length: 51 }, (_, i) => `  - https://s${i}.example/`).join("\n")}\n`, context);
  assert.ok(many.ok && !many.patch.sources && errors(many.issues)[0].path === "sources");
});

function sampleDraft(): AgentDraft {
  let draft = newDraft({ presets: BUILTIN_PRESETS, timeZone: "Europe/Paris" });
  const topics: AgentDraft["topics"] = [];
  topics.push({ type: "new", key: newTopicKey(topics), draft: { tag: "astronomie.exoplanetes", name: "Exoplanètes", description: "Mondes lointains.", scope: "Détection des exoplanètes", parentId: astro.id, relatedIds: [science.id] } });
  topics.push({ type: "existing", id: science.id });
  topics.push({ type: "new", key: newTopicKey(topics), draft: { tag: "astronomie.telescopes", name: "Télescopes", description: "", scope: "Instruments", parentId: astro.id, relatedIds: [] } });
  const schedule = defaultSchedule("Asia/Tokyo");
  schedule.watch.week[5] = [{ start: 1320, end: 120 }, { start: 600, end: 600 }];
  schedule.watch.exceptions = { "2026-12-31": [{ start: 0, end: 1440 }], "2026-01-01": [] };
  schedule.publish.exceptions = { "2027-02-28": [{ start: 60, end: 90 }] };
  schedule.retentionDays = 7; schedule.majorEvents = { enabled: true }; schedule.graceMinutes = 0;
  draft = applySuggestion(draft, {
    name: "Veille : exoplanètes", handle: "exo.planetes", about: "Ligne 1\nLigne 2 « citée »", topics,
    perimeter: "Périmètre: avec deux-points", charter: "#pas un commentaire", presetKey: "historien:1",
    settings: { ...BUILTIN_PRESETS[3].settings, tone: "yes" }, modelRef: "qwen3:8b", autoPublish: true,
    sources: [
      { url: "https://arxiv.example/astro", domain: "arxiv.example", type: "revue", rationale: "Primaire", origin: "ai", status: "excluded" },
      { url: "https://nasa.example/feed.xml", domain: "nasa.example", type: "", rationale: "", origin: "user", status: "excluded" },
    ],
    schedule, bloub: { ...DEFAULT_BLOUB_CONFIG, color: "bleu" },
  }, "rules");
  return draft;
}
const EXPORTED: DraftField[] = ["name", "handle", "about", "topics", "perimeter", "charter", "presetKey", "settings", "modelRef", "autoPublish", "sources", "schedule", "bloub"];

test("yaml: draft → yaml → import → applySuggestion gives an equal draft", () => {
  const draft = sampleDraft();
  const yaml = draftToYaml(draft, catalog);
  assert.ok(yaml.startsWith("# Configuration ΞAgent — format xiagent v1 (docs/xiagent-yaml.md)\n"));
  assert.match(yaml, new RegExp(`^xiagent: ${AGENT_YAML_VERSION}$`, "m"));
  assert.doesNotMatch(yaml, UUID, "no internal identifier");
  assert.match(yaml, /preset: historien@1/);
  assert.match(yaml, /"2026-12-31": \[ 00:00-24:00 \]/, "dates quoted, ranges inline");
  assert.equal(draftToYaml(draft, catalog), yaml, "stable output");
  const result = parseAgentYaml(yaml, context);
  assert.ok(result.ok, JSON.stringify(result.issues));
  if (!result.ok) return;
  assert.deepEqual(result.issues, []);
  const imported = applySuggestion(newDraft({ presets: BUILTIN_PRESETS, timeZone: "Europe/Paris" }), result.patch, "yaml");
  for (const field of EXPORTED) {
    const expected = field === "sources" ? draft.sources.map(source => ({ ...source, origin: "yaml" })) : draft[field];
    assert.deepEqual(imported[field], expected, field);
  }
  assert.deepEqual(imported.schedule.watch.exceptions, draft.schedule.watch.exceptions);
  assert.equal(draftToYaml(imported, catalog), yaml, "export of the import is identical");
  // Approved sources are exported as approved but come back undecided.
  const approved = { ...draft, sources: [{ ...draft.sources[0], status: "approved" as const }] };
  const back = parseAgentYaml(draftToYaml(approved, catalog), context);
  assert.ok(back.ok && back.patch.sources![0].status === "undecided");
  // Topic-only drafts.
  const topicDraft = { ...draft, target: "topic" as const, topics: [draft.topics[0]] };
  const topicYaml = draftToYaml(topicDraft, catalog);
  assert.doesNotMatch(topicYaml, /identity|sources/);
  const topicBack = parseAgentYaml(topicYaml, context);
  assert.ok(topicBack.ok && topicBack.target === "topic");
  assert.deepEqual(topicBack.ok && topicBack.patch.topics, [draft.topics[0]]);
});

// ---------------------------------------------------------------- export through the real stores

const RSS = (title: string) => Buffer.from(`<?xml version="1.0"?><rss version="2.0"><channel><title>${title}</title><link>https://example.org/</link><item><title>Un article</title><link>https://example.org/a</link><pubDate>Mon, 19 Oct 2026 10:00:00 GMT</pubDate><description>Résumé</description></item></channel></rss>`);
async function setup(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "xi-yaml-"));
  const vault = await openVault(root);
  const db = new Database(":memory:");
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  const topics = createTopicStore({ vault, db });
  const accounts = createAccountStore({ vault, db, topics });
  const sources = createSourceStore({ vault, topics });
  const fetch = (async (url: string) => ({ status: 200, url, headers: { "content-type": "application/rss+xml" }, body: RSS(new URL(url).hostname) })) as unknown as PoliteFetch;
  const deployments = createDeployments({ vault, db, accounts, topics, sources, fetch, readiness: () => ({ inference: { configured: false, model: null, error: null }, autoPublish: false, workerLastTickAt: null }) });
  return { topics, accounts, sources, deployments };
}

test("export: a deployed ΞAgent exports to a portable YAML, owner-only", async t => {
  const { topics, accounts, sources, deployments } = await setup(t);
  const existing = (await topics.create("alice", randomUUID(), { tag: "science", name: "Science", description: "", scope: "Recherche scientifique", parentId: null, relatedIds: [] })).topic;
  const schedule = defaultSchedule("Europe/Paris");
  schedule.watch.exceptions = { "2026-12-25": [] };
  const preset = BUILTIN_PRESETS[0];
  const spec: DeploymentSpec = {
    target: "agent",
    newTopics: [{ key: "new-1", draft: { tag: "science.longevite", name: "Longévité", description: "", scope: "Sénescence", parentId: existing.id, relatedIds: [] } }],
    agent: {
      handle: "longevite", name: "Veille longévité", description: "Avancées.", primary: { type: "new", key: "new-1" }, secondary: [{ type: "existing", id: existing.id }],
      presetId: preset.id, presetVersion: preset.version, settings: preset.settings, modelRef: "qwen3:8b",
      profile: { perimeter: "Recherche publiée.", charter: "Citer l’étude primaire." },
      sources: [
        { url: "https://journal.example/", status: "approved", origin: "ai", type: "revue", rationale: "Référence" },
        { url: "https://blog.example/", status: "excluded", origin: "user", type: "blog", rationale: "Promotionnel" },
      ],
      schedule, bloub: { ...DEFAULT_BLOUB_CONFIG, color: "bleu" }, autoPublish: true,
    },
    proposal: { generatedBy: "manual", model: null },
  };
  const id = randomUUID();
  await deployments.create("alice", id, spec);
  const done = await deployments.run("alice", id);
  assert.equal(done.state, "completed", JSON.stringify(done.steps.filter(step => step.error)));
  const agentId = done.ids.agentId!;
  // A source of another topic is not exported.
  const other = (await topics.create("alice", randomUUID(), { tag: "sport", name: "Sport", description: "", scope: "Sport", parentId: null, relatedIds: [] })).topic;
  await sources.propose("alice", { url: "https://sport.example/feed", kind: "feed", site: null, publisher: "Sport", topicIds: [other.id], reliability: { level: "inconnue", reasons: [], estimated: true } }, "alice");

  const draft = await exportAgentDraft({ owner: "alice", agentId, accounts, topics, sources });
  const catalog = await topics.list();
  assert.equal(draft.handle, "longevite"); assert.equal(draft.about, "Avancées.");
  assert.deepEqual(draft.topics, [{ type: "existing", id: done.ids.topics["new-1"] }, { type: "existing", id: existing.id }]);
  assert.equal(draft.charter, "Citer l’étude primaire."); assert.equal(draft.presetKey, `${preset.id}:${preset.version}`); assert.equal(draft.modelRef, "qwen3:8b");
  assert.deepEqual(draft.schedule, schedule);
  assert.equal(draft.autoPublish, true); assert.equal(draft.bloub.color, "bleu");
  assert.deepEqual(draft.sources.map(source => [source.domain, source.status]).sort(), [["blog.example", "excluded"], ["journal.example", "approved"]]);

  const yaml = draftToYaml(draft, catalog);
  assert.doesNotMatch(yaml, UUID);
  assert.doesNotMatch(yaml, /alice|revision|deployment/);
  assert.match(yaml, /primary: science\.longevite/);
  // Duplication = export + import: same configuration, sources to re-approve, new handle needed.
  const imported = parseAgentYaml(yaml, { catalog, presets: BUILTIN_PRESETS });
  assert.ok(imported.ok);
  const copy = applySuggestion(newDraft({ presets: BUILTIN_PRESETS, timeZone: "UTC" }), imported.ok ? imported.patch : {}, "yaml");
  assert.deepEqual(copy.topics, draft.topics); assert.deepEqual(copy.schedule, draft.schedule);
  assert.ok(copy.sources.every(source => source.status !== "approved"));

  await assert.rejects(exportAgentDraft({ owner: "bob", agentId, accounts, topics, sources }), (error: Error & { status?: number }) => error.status === 404 && /introuvable/.test(error.message));
  await assert.rejects(exportAgentDraft({ owner: "alice", agentId: "pas-un-uuid", accounts, topics, sources }), (error: Error & { status?: number }) => error.status === 404);
});
