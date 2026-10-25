import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import Database from "better-sqlite3";
import { createAccountStore } from "../src/lib/accounts/store";
import { DEFAULT_BLOUB_CONFIG } from "../src/lib/bloub/config";
import { openVault } from "../src/lib/publications/vault";
import { createTopicStore } from "../src/lib/topics/store";
import { TopicError } from "../src/lib/topics/types";
import type { PoliteFetch } from "../src/lib/watch/net";
import { createSourceStore } from "../src/lib/watch/sources";
import { createDeployments, deploymentSpecSchema } from "../src/lib/xiagents/deployments";
import { applySuggestion, conflicts, draftIssues, draftToSpec, editDraft, newDraft, type AgentDraft, type DraftPatch } from "../src/lib/xiagents/draft";
import { exportAgentDraft } from "../src/lib/xiagents/export";
import { scheduleSchema, type Schedule } from "../src/lib/xiagents/schedule";
import { extractConcepts, suggestDraft } from "../src/lib/xiagents/suggest";
import { MAX_YAML_BYTES, draftToYaml, parseAgentYaml } from "../src/lib/xiagents/yaml";

/**
 * Integration of the creation flow without a browser: the three entry modes (rule-based
 * suggestion, YAML import, manual edits) feed one `AgentDraft` (draft.ts), which goes through the
 * real deployment pipeline (createDeployments on a temporary vault and an in-memory database).
 */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const RSS = (title: string) => Buffer.from(`<?xml version="1.0"?><rss version="2.0"><channel><title>${title}</title><link>https://example.org/</link><item><title>Un article</title><link>https://example.org/a</link><pubDate>Mon, 19 Oct 2026 10:00:00 GMT</pubDate><description>Résumé</description></item></channel></rss>`);

async function setup(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "xi-creation-"));
  const vault = await openVault(root);
  const db = new Database(":memory:");
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  const topics = createTopicStore({ vault, db });
  const accounts = createAccountStore({ vault, db, topics });
  const sources = createSourceStore({ vault, topics });
  const fetch = (async (url: string) => ({ status: 200, url, headers: { "content-type": "application/rss+xml" }, body: RSS(new URL(url).hostname) })) as unknown as PoliteFetch;
  const deployments = createDeployments({ vault, db, accounts, topics, sources, fetch, readiness: () => ({ inference: { configured: false, model: null, error: null }, autoPublish: false, workerLastTickAt: null }) });
  const science = (await topics.create("alice", randomUUID(), { tag: "science", name: "Science", description: "", scope: "Recherche scientifique", parentId: null, relatedIds: [] })).topic;
  const presets = await accounts.listPresets("alice");
  const catalog = () => topics.list();
  const fresh = () => newDraft({ presets, timeZone: "Europe/Paris" });
  async function deploy(owner: string, draft: AgentDraft) {
    const id = randomUUID();
    await deployments.create(owner, id, draftToSpec(draft));
    const done = await deployments.run(owner, id);
    assert.equal(done.state, "completed", JSON.stringify(done.steps.filter(step => step.error).map(step => [step.key, step.error])));
    return done;
  }
  return { db, topics, accounts, sources, deployments, science, presets, catalog, fresh, deploy };
}
type Env = Awaited<ReturnType<typeof setup>>;

/** Same composition as the dialog: rule-based suggestion from the owner's words. */
async function fromWords(env: Env, text: string) {
  const suggestion = suggestDraft({ text, catalog: await env.catalog(), presets: env.presets });
  return { suggestion, draft: applySuggestion({ ...env.fresh(), description: text }, suggestion.patch, "rules") };
}
/** Same composition as the dialog's import: fields absent from the file are completed by the rules, then the file's values win. */
async function fromYaml(env: Env, text: string) {
  const catalog = await env.catalog();
  const result = parseAgentYaml(text, { catalog, presets: env.presets });
  assert.ok(result.ok, JSON.stringify(result.issues));
  const words = [result.patch.name, result.patch.about, ...(result.patch.topics ?? []).map(pick => pick.type === "new" ? pick.draft.name : catalog.find(topic => topic.id === pick.id)?.name)].filter(Boolean).join(", ");
  let draft: AgentDraft = { ...env.fresh(), target: result.target, description: words };
  if (words.trim().length >= 2) {
    const completion = suggestDraft({ text: words, catalog, presets: env.presets });
    draft = applySuggestion(draft, Object.fromEntries(Object.entries(completion.patch).filter(([key]) => !(key in result.patch))) as DraftPatch, "rules");
  }
  return { result, draft: applySuggestion(draft, result.patch, "yaml") };
}
const approveAll = (draft: AgentDraft) => editDraft(draft, { sources: draft.sources.map(source => source.status === "undecided" ? { ...source, status: "approved" as const } : source) });
const tags = async (env: Env, draft: AgentDraft) => {
  const catalog = await env.catalog();
  return draft.topics.map(pick => pick.type === "new" ? pick.draft.tag : catalog.find(topic => topic.id === pick.id)?.tag);
};
const COMPARED = ["name", "handle", "about", "topics", "perimeter", "charter", "presetKey", "settings", "llm", "autoPublish", "schedule", "bloub"] as const;
const configOf = (draft: AgentDraft) => Object.fromEntries(COMPARED.map(key => [key, draft[key]]));

const FULL_YAML = `# exporté à la main
xiagent: 1
kind: agent
identity:
  name: Veille cosmologie
  handle: veille-cosmo
  description: Suivi des avancées en cosmologie.
topics:
  primary:
    tag: science.cosmologie
    name: Cosmologie
    scope: Origine, structure et évolution de l’Univers.
    parent: science
  secondary:
    - science
editorial:
  perimeter: Publications scientifiques ; pas de spéculations.
  charter: Citer l’article primaire.
style:
  preset: journaliste@1
  depth: approfondi
  model: modele-test
sources:
  - url: https://journal.example/
    type: revue
    rationale: Revue de référence
    status: approved
  - url: https://blog.example/
    status: excluded
  - https://feed.example/rss
schedule:
  timeZone: America/New_York
  watch:
    week:
      lundi: ["08:00-12:00", "22:00-02:00"]
      mardi: ["08:00-18:00"]
    exceptions:
      "2026-12-25": []
      "2026-12-24": ["10:00-11:00"]
  publish:
    week: [["06:00-07:00"], [], [], [], [], [], ["00:00-24:00"]]
    exceptions:
      "2026-12-31": ["23:00-01:00"]
  graceMinutes: 15
  catchUpHours: 24
  majorEvents: true
  retentionDays: 90
publication:
  autoPublish: true
appearance:
  shape: cercle
  expression: neutre
  color: bleu
`;
const EXPECTED_SCHEDULE: Schedule = {
  version: 1, timeZone: "America/New_York",
  watch: { week: [[{ start: 480, end: 720 }, { start: 1320, end: 120 }], [{ start: 480, end: 1080 }], [], [], [], [], []], exceptions: { "2026-12-25": [], "2026-12-24": [{ start: 600, end: 660 }] } },
  publish: { week: [[{ start: 360, end: 420 }], [], [], [], [], [], [{ start: 0, end: 1440 }]], exceptions: { "2026-12-31": [{ start: 1380, end: 60 }] } },
  graceMinutes: 15, catchUpHours: 24, majorEvents: { enabled: true }, retentionDays: 90,
};
/** Order-insensitive comparison of calendars (exceptions are a record). */
const normalizedSchedule = (schedule: Schedule) => ({ ...scheduleSchema.strip().parse(schedule), watch: { ...schedule.watch, exceptions: Object.fromEntries(Object.entries(schedule.watch.exceptions).sort()) }, publish: { ...schedule.publish, exceptions: Object.fromEntries(Object.entries(schedule.publish.exceptions).sort()) } });

// ---------------------------------------------------------------- 1–4: rule-based suggestion

test("creation 1: a single word gives a complete, valid draft", async t => {
  const env = await setup(t);
  const { suggestion, draft } = await fromWords(env, "Astronomie");
  assert.equal(suggestion.concepts.length, 1);
  assert.ok(draft.name.trim(), "a name is suggested");
  assert.match(draft.handle, /^[a-z0-9][a-z0-9.-]*$/);
  assert.ok(draft.topics.length >= 1);
  assert.ok((await tags(env, draft)).some(tag => tag?.endsWith("astronomie")), JSON.stringify(await tags(env, draft)));
  assert.deepEqual(draftIssues(draft, await env.catalog(), env.presets), []);
  assert.deepEqual(draft.sources, [], "no source is ever invented");
  assert.equal(draft.provenance.name, "rules");
});

test("creation 2: several keywords map to known concepts, without duplicate topics", async t => {
  const env = await setup(t);
  const text = "Astronomie, NASA, JWST, exoplanètes";
  const concepts = extractConcepts(text);
  assert.deepEqual(concepts.map(concept => concept.canonical), ["Astronomie", "NASA", "James Webb Space Telescope", "Exoplanètes"]);
  const { suggestion, draft } = await fromWords(env, text);
  const topicTags = await tags(env, draft);
  assert.equal(new Set(topicTags).size, topicTags.length, "no tag twice");
  assert.ok(topicTags.some(tag => tag?.endsWith("astronomie")) && topicTags.some(tag => tag?.endsWith("espace")) && topicTags.some(tag => tag?.endsWith("exoplanetes")), JSON.stringify(topicTags));
  assert.equal(topicTags.filter(tag => tag?.endsWith("astronomie")).length, 1, "JWST and Astronomie share one topic");
  assert.ok(suggestion.notes.some(note => /JWST/.test(note)));
  assert.match(draft.perimeter, /NASA/);
  assert.deepEqual(draftIssues(draft, await env.catalog(), env.presets), []);
});

test("creation 3: a long description stays bounded and valid", async t => {
  const env = await setup(t);
  const text = "Je voudrais suivre l’actualité de l’intelligence artificielle et de la cybersécurité en Europe, notamment les décisions de l’Union européenne, " +
    "les grands modèles de langage, les vulnérabilités critiques et les incidents majeurs, ainsi que les travaux de recherche publiés par les laboratoires publics. " +
    "Je ne veux pas de contenus promotionnels ni de rumeurs. ".repeat(3) + "Mots rares : zorglub, plimpf, tartempion, quidam, bidule, machin, truc, chose, foo, bar, baz.";
  const { suggestion, draft } = await fromWords(env, text);
  assert.ok(suggestion.concepts.length <= 12, `${suggestion.concepts.length} concepts`);
  assert.ok(suggestion.concepts.some(concept => concept.canonical === "Intelligence artificielle"));
  assert.ok(suggestion.concepts.some(concept => concept.canonical === "Cybersécurité"));
  assert.ok(draft.topics.length >= 1 && draft.topics.length <= 5);
  assert.ok(draft.perimeter.length <= 4000 && draft.about.length <= 4000 && draft.name.length <= 160);
  assert.deepEqual(draftIssues(draft, await env.catalog(), env.presets), []);
});

test("creation 4: rules only (no AI) — suggestion → draftToSpec → real deployment", async t => {
  const env = await setup(t);
  const { draft } = await fromWords(env, "Astronomie, NASA, JWST, exoplanètes");
  assert.deepEqual(draftIssues(draft, await env.catalog(), env.presets), []);
  const spec = draftToSpec(draft);
  assert.deepEqual(spec.proposal, { generatedBy: "rules", model: null });
  assert.ok(deploymentSpecSchema.safeParse(spec).success);
  const done = await env.deploy("alice", draft);
  assert.ok(done.steps.find(step => step.key === "validate")!.logs.some(log => /sans IA/.test(log.message)));
  const agent = (await env.accounts.watchAgents()).find(item => item.id === done.ids.agentId)!;
  assert.equal(agent.handle, draft.handle);
  assert.equal(agent.watch.policy.enabled, true);
  const catalog = await env.catalog();
  for (const pick of draft.topics) if (pick.type === "new") assert.ok(catalog.some(topic => topic.tag === pick.draft.tag), `${pick.draft.tag} created`);
  // Suggesting again for the same words now reuses the created topics instead of proposing duplicates.
  const again = await fromWords(env, "Astronomie, NASA, JWST, exoplanètes");
  assert.ok(again.draft.topics.every(pick => pick.type === "existing"), JSON.stringify(again.draft.topics));
  assert.deepEqual(draftIssues({ ...again.draft, handle: `${again.draft.handle}-bis` }, catalog, env.presets), []);
});

// ---------------------------------------------------------------- 5–8: YAML import, editing

test("creation 5 & 14: full YAML import fills every field, then deploys", async t => {
  const env = await setup(t);
  const { result, draft } = await fromYaml(env, FULL_YAML);
  assert.ok(result.ok);
  assert.equal(result.target, "agent");
  assert.ok(!result.issues.some(issue => issue.level === "error"), JSON.stringify(result.issues));
  assert.ok(result.issues.some(issue => issue.path === "sources" && /réapprouver/.test(issue.message)), "approved sources are announced as needing approval");
  assert.equal(draft.name, "Veille cosmologie"); assert.equal(draft.handle, "veille-cosmo"); assert.equal(draft.about, "Suivi des avancées en cosmologie.");
  assert.deepEqual(await tags(env, draft), ["science.cosmologie", "science"]);
  const primary = draft.topics[0];
  assert.ok(primary.type === "new" && primary.draft.parentId === env.science.id);
  assert.equal(draft.perimeter, "Publications scientifiques ; pas de spéculations."); assert.equal(draft.charter, "Citer l’article primaire.");
  const journaliste = env.presets.find(preset => preset.id === "journaliste")!;
  assert.equal(draft.presetKey, "journaliste:1");
  assert.deepEqual(draft.settings, { ...journaliste.settings, depth: "approfondi" });
  assert.equal(draft.llm.model, "modele-test", "legacy style.model"); assert.equal(draft.autoPublish, true);
  assert.deepEqual(draft.bloub, { ...DEFAULT_BLOUB_CONFIG, color: "bleu" });
  assert.deepEqual(draft.schedule, EXPECTED_SCHEDULE);
  assert.deepEqual(draft.sources.map(source => [source.domain, source.status, source.origin]), [["journal.example", "undecided", "yaml"], ["blog.example", "excluded", "yaml"], ["feed.example", "undecided", "yaml"]]);
  for (const key of ["name", "handle", "topics", "schedule", "settings", "bloub", "sources"] as const) assert.equal(draft.provenance[key], "yaml", key);
  assert.deepEqual(draftIssues(draft, await env.catalog(), env.presets), []);
  assert.deepEqual(draftToSpec(draft).proposal, { generatedBy: "yaml", model: null });
  // 14: deployment after import completes.
  const done = await env.deploy("alice", draft);
  assert.ok(done.steps.find(step => step.key === "validate")!.logs.some(log => /YAML/.test(log.message)));
  const agent = (await env.accounts.watchAgents()).find(item => item.id === done.ids.agentId)!;
  assert.equal(agent.modelRef, null);
  assert.deepEqual(agent.llm?.config, { instanceId: null, model: "modele-test", options: {} }, "the model lives in the llm key");
  assert.equal(agent.watch.policy.autoPublish, true);
  assert.equal(agent.profile!.charter, "Citer l’article primaire.");
  assert.equal((await env.accounts.avatar("alice", agent.id)).config.color, "bleu");
});

test("creation 6: a partial YAML import is completed by the rules and defaults", async t => {
  const env = await setup(t);
  const { result, draft } = await fromYaml(env, "xiagent: 1\ntopics:\n  primary: { tag: science.exoplanetes }\nidentity:\n  name: Mes exoplanètes\n");
  assert.ok(result.ok);
  assert.ok(result.issues.some(issue => issue.level === "warning" && /complété/.test(issue.message)), "auto-completed topic fields are flagged");
  assert.equal(draft.name, "Mes exoplanètes", "the file wins");
  assert.equal(draft.provenance.name, "yaml");
  assert.ok(draft.handle, "the handle comes from the rules");
  assert.equal(draft.provenance.handle, "rules");
  assert.ok(draft.perimeter.trim() && draft.charter.trim());
  assert.equal(draft.provenance.schedule, "default");
  assert.equal(draft.schedule.timeZone, "Europe/Paris");
  assert.deepEqual(await tags(env, draft), ["science.exoplanetes"]);
  assert.deepEqual(draftIssues(draft, await env.catalog(), env.presets), []);
  // A hierarchical tag needs its direct parent (topic store rule): without `parent:` in the file,
  // the parent must be inferred from the tag, or the deployment fails at its "topics" step.
  const primary = draft.topics[0];
  assert.ok(primary.type === "new" && primary.draft.parentId === env.science.id, `parent of science.exoplanetes not inferred: ${JSON.stringify(primary)}`);
  await env.deploy("alice", draft);
});

test("creation 6b: a tag inconsistent with its parent is caught before any deployment record", async t => {
  const env = await setup(t);
  const catalog = await env.catalog();
  const result = parseAgentYaml("xiagent: 1\nidentity:\n  name: Cosmo\n  handle: cosmo\ntopics:\n  primary:\n    tag: cosmologie\n    name: Cosmologie\n    scope: Univers\n    parent: science\n", { catalog, presets: env.presets });
  const refusedAtImport = !result.ok || result.issues.some(issue => issue.level === "error" && issue.path.startsWith("topics.primary"));
  const draft = result.ok ? applySuggestion(env.fresh(), result.patch, "yaml") : env.fresh();
  const refusedByDraft = result.ok && draftIssues(draft, catalog, env.presets).some(issue => issue.section === "topics");
  const refusedByPreflight = result.ok && (await env.deployments.preflight("alice", deploymentSpecSchema.parse(draftToSpec(draft)))).length > 0;
  assert.ok(refusedAtImport || refusedByDraft || refusedByPreflight, "tag « cosmologie » under parent « science » only fails at the deployment's topics step");
});

test("creation 7: invalid or hostile YAML gives clear errors, never a draft", async t => {
  const env = await setup(t);
  const options = { catalog: await env.catalog(), presets: env.presets };
  const refused = (text: string, pattern: RegExp) => {
    const result = parseAgentYaml(text, options);
    assert.equal(result.ok, false, text.slice(0, 80));
    assert.ok(result.issues.some(issue => issue.level === "error" && pattern.test(issue.message)), `${text.slice(0, 80)} → ${JSON.stringify(result.issues)}`);
  };
  refused("", /vide/);
  refused("xiagent: 1\nidentity: [unterminated", /Syntaxe YAML invalide \(ligne/);
  refused("identity:\n  name: x\n", /Version du format absente/);
  refused("xiagent: 2\n", /Version incompatible/);
  refused("xiagent: 1\nkind: robot\n", /agent ou topic/);
  refused("xiagent: 1\nxiagent: 1\n", /Clé en double/);
  refused("xiagent: 1\n---\nxiagent: 1\n", /Un seul document/);
  refused("xiagent: 1\nidentity: !!js/function 'function(){}'\n", /interdites/);
  refused("xiagent: 1\nidentity: !custom {name: x}\n", /interdites/);
  refused(`xiagent: 1\nidentity:\n  description: "${"a".repeat(MAX_YAML_BYTES)}"\n`, /trop volumineux/);
  // Billion laughs: alias expansion is bounded.
  const bomb = ["xiagent: 1", "a: &a [x, x, x, x, x, x, x, x, x, x]", ...Array.from({ length: 8 }, (_, i) => `${String.fromCharCode(98 + i)}: &${String.fromCharCode(98 + i)} [${Array(10).fill(`*${String.fromCharCode(97 + i)}`).join(", ")}]`)].join("\n");
  refused(bomb, /alias|structure/i);
  refused(`xiagent: 1\nidentity: ${"[".repeat(12)}x${"]".repeat(12)}\n`, /profonde/);
  // Field-level errors are located by path and block the import.
  const fieldErrors = (text: string, path: string) => {
    const result = parseAgentYaml(text, options);
    assert.ok(result.issues.some(issue => issue.level === "error" && issue.path === path), `${path}: ${JSON.stringify(result.issues)}`);
  };
  fieldErrors("xiagent: 1\nidentity:\n  handle: Pas Valide!\n", "identity.handle");
  fieldErrors("xiagent: 1\nsources:\n  - javascript:alert(1)\n", "sources[0].url");
  fieldErrors("xiagent: 1\nsources:\n  - https://user:secret@example.org/feed\n", "sources[0].url");
  fieldErrors("xiagent: 1\nschedule:\n  timeZone: Mars/Olympus\n", "schedule.timeZone");
  fieldErrors("xiagent: 1\nschedule:\n  timeZone: Europe/Paris\n  watch:\n    week:\n      lundi: [\"25:00-26:00\"]\n", "schedule.watch.week.lundi[0]");
  fieldErrors("xiagent: 1\nschedule:\n  timeZone: Europe/Paris\n  watch:\n    exceptions:\n      \"2026-02-30\": []\n", "schedule.watch.exceptions.2026-02-30");
  fieldErrors("xiagent: 1\nappearance:\n  color: <script>\n", "appearance.color");
  fieldErrors("xiagent: 1\ntopics:\n  primary: Pas Un Tag\n", "topics.primary.tag");
  // Prototype keys are plain data.
  const proto = parseAgentYaml("xiagent: 1\n__proto__:\n  polluted: true\nidentity:\n  __proto__: { name: x }\n  name: Ok\n", options);
  assert.equal(({} as Record<string, unknown>).polluted, undefined, "no prototype pollution");
  assert.ok(proto.ok);
  assert.equal(proto.patch.name, "Ok");
});

test("creation 8: an edit after import survives a later suggestion", async t => {
  const env = await setup(t);
  const imported = (await fromYaml(env, FULL_YAML)).draft;
  const edited = editDraft(imported, { name: "Cosmos, édition perso", perimeter: "Cosmologie observationnelle uniquement." });
  assert.equal(edited.provenance.name, "manual");
  const suggestion = suggestDraft({ text: "Astronomie, NASA", catalog: await env.catalog(), presets: env.presets });
  assert.deepEqual(conflicts(edited, suggestion.patch).sort(), ["name", "perimeter"]);
  const after = applySuggestion(edited, suggestion.patch, "rules");
  assert.equal(after.name, "Cosmos, édition perso");
  assert.equal(after.perimeter, "Cosmologie observationnelle uniquement.");
  assert.equal(after.provenance.name, "manual");
  // Fields not edited by the owner (imported ones included) are replaced by the new suggestion.
  assert.equal(after.handle, suggestion.patch.handle);
  // A later YAML suggestion (re-import) does not undo the edit either.
  const file = parseAgentYaml(FULL_YAML, { catalog: await env.catalog(), presets: env.presets });
  assert.ok(file.ok);
  const reimported = applySuggestion(after, file.patch, "yaml");
  assert.equal(reimported.name, "Cosmos, édition perso");
  // Sources decisions are kept on merge: an approved row stays approved, not re-decided.
  const approved = approveAll(imported);
  const merged = applySuggestion(approved, { sources: [{ url: "https://journal.example/autre", domain: "journal.example", type: "", rationale: "", origin: "ai", status: "undecided" }] }, "ai", "m");
  assert.equal(merged.sources.find(source => source.domain === "journal.example")!.status, "approved");
});

// ---------------------------------------------------------------- 9–10: export

test("creation 9 & 10: export of a modified draft is portable and reimports identically", async t => {
  const env = await setup(t);
  const imported = (await fromYaml(env, FULL_YAML)).draft;
  const edited = approveAll(editDraft(imported, { name: "Cosmos modifié", autoPublish: false, bloub: { ...DEFAULT_BLOUB_CONFIG, color: "vert" } }));
  const catalog = await env.catalog();
  const yaml = draftToYaml(edited, catalog);
  assert.match(yaml, /name: Cosmos modifié/);
  assert.match(yaml, /color: vert/);
  assert.match(yaml, /autoPublish: false/);
  assert.match(yaml, /parent: science/);
  assert.doesNotMatch(yaml, UUID, "no internal identifier in the export");
  // 10: reimport → same configuration; approved sources come back undecided (re-approval required).
  const back = parseAgentYaml(yaml, { catalog, presets: env.presets });
  assert.ok(back.ok, JSON.stringify(back.issues));
  assert.ok(!back.issues.some(issue => issue.level === "error"));
  const again = applySuggestion(env.fresh(), back.patch, "yaml");
  assert.deepEqual(configOf(again), configOf(edited));
  assert.deepEqual(again.sources.map(source => [source.url, source.status]), edited.sources.map(source => [source.url, source.status === "approved" ? "undecided" : source.status]));
  assert.equal(draftToYaml(again, catalog), draftToYaml({ ...edited, sources: again.sources }, catalog), "export is stable");
});

test("creation 10b & 12: deployed agent → exportAgentDraft → YAML → reimport keeps calendars and exceptions", async t => {
  const env = await setup(t);
  const draft = approveAll((await fromYaml(env, FULL_YAML)).draft);
  const done = await env.deploy("alice", draft);
  const agentId = done.ids.agentId!;
  // 12: calendars, exceptions included, are stored as deployed.
  const stored = await env.accounts.schedule("alice", agentId);
  assert.equal(stored.explicit, true); assert.equal(stored.valid, true);
  assert.deepEqual(normalizedSchedule(stored), normalizedSchedule(EXPECTED_SCHEDULE));
  assert.ok(done.steps.find(step => step.key === "calendars")!.logs.some(log => /3 exception\(s\)/.test(log.message)));
  // Export of the deployed agent: topics now existing, sources as decided, no history.
  const exported = await exportAgentDraft({ owner: "alice", agentId, accounts: env.accounts, topics: env.topics, sources: env.sources });
  const catalog = await env.catalog();
  assert.deepEqual(await tags(env, exported), ["science.cosmologie", "science"]);
  assert.deepEqual(normalizedSchedule(exported.schedule), normalizedSchedule(EXPECTED_SCHEDULE));
  for (const key of ["name", "handle", "about", "perimeter", "charter", "presetKey", "settings", "llm", "autoPublish", "bloub"] as const) assert.deepEqual(exported[key], draft[key], key);
  assert.deepEqual(exported.sources.map(source => [source.domain, source.status]).sort(), [["blog.example", "excluded"], ["feed.example", "approved"], ["journal.example", "approved"]]);
  const yaml = draftToYaml(exported, catalog);
  assert.doesNotMatch(yaml, UUID, "no topic, agent or source identifier leaks");
  assert.ok(!yaml.includes(agentId) && !yaml.includes(done.id));
  const back = parseAgentYaml(yaml, { catalog, presets: env.presets });
  assert.ok(back.ok, JSON.stringify(back.issues));
  const reimported = applySuggestion(env.fresh(), back.patch, "yaml");
  assert.deepEqual(normalizedSchedule(reimported.schedule), normalizedSchedule(EXPECTED_SCHEDULE));
  assert.deepEqual(configOf({ ...reimported, schedule: exported.schedule }), configOf(exported));
  // Duplicating = export + import: the handle is taken, the copy must be renamed.
  assert.ok((await env.deployments.preflight("alice", deploymentSpecSchema.parse(draftToSpec(reimported)))).some(problem => /@veille-cosmo est déjà réservé/.test(problem)));
  const copy = await env.deploy("alice", editDraft(reimported, { handle: "veille-cosmo-2" }));
  assert.deepEqual(normalizedSchedule(await env.accounts.schedule("alice", copy.ids.agentId!)), normalizedSchedule(EXPECTED_SCHEDULE));
});

// ---------------------------------------------------------------- 11, 13, 15: safety

test("creation 11: a taken handle is a preflight problem and a 422 at creation", async t => {
  const env = await setup(t);
  const first = (await fromWords(env, "Astronomie")).draft;
  await env.deploy("alice", first);
  const second = editDraft((await fromWords(env, "Climat")).draft, { handle: first.handle });
  assert.deepEqual(draftIssues(second, await env.catalog(), env.presets), [], "availability is a server check");
  const spec = deploymentSpecSchema.parse(draftToSpec(second));
  assert.ok((await env.deployments.preflight("bob", spec)).some(problem => problem.includes(`@${first.handle} est déjà réservé`)), "handles are global, across owners");
  await assert.rejects(env.deployments.create("bob", randomUUID(), draftToSpec(second)), (error: unknown) => error instanceof TopicError && error.status === 422 && /déjà réservé/.test(error.message));
  assert.deepEqual(await env.deployments.list("bob"), [], "nothing written");
});

test("creation 13: imported approved sources are undecided and never deployed unless approved", async t => {
  const env = await setup(t);
  const { draft } = await fromYaml(env, FULL_YAML);
  const spec = draftToSpec(draft);
  assert.deepEqual(spec.agent!.sources.map(source => [new URL(source.url).hostname, source.status]), [["blog.example", "excluded"]], "only explicit decisions are deployed");
  const done = await env.deploy("alice", draft);
  const owned = (await env.sources.list("alice", { includeDeleted: true })).sources;
  assert.ok(!owned.some(source => source.status === "approved"), JSON.stringify(owned.map(source => [source.url, source.status])));
  assert.ok(!owned.some(source => /journal\.example|feed\.example/.test(source.url)), "undecided sources are not even proposed");
  assert.ok(done.steps.find(step => step.key === "sources")!.logs.length > 0);
  // Explicit approval of one row: only that one is deployed as approved.
  const second = editDraft(draft, { handle: "veille-cosmo-2", topics: [{ type: "existing", id: env.science.id }], sources: draft.sources.map(source => source.domain === "journal.example" ? { ...source, status: "approved" as const } : source) });
  await env.deploy("alice", second);
  const after = (await env.sources.list("alice", { includeDeleted: true })).sources;
  assert.deepEqual(after.filter(source => source.status === "approved").map(source => new URL(source.url).hostname), ["journal.example"]);
  assert.ok(!after.some(source => source.url.includes("feed.example")));
});

test("creation 15: owner isolation for deployments and export", async t => {
  const env = await setup(t);
  const draft = (await fromWords(env, "Astronomie")).draft;
  const done = await env.deploy("alice", draft);
  const notFound = (error: unknown) => error instanceof TopicError && error.status === 404;
  await assert.rejects(env.deployments.get("bob", done.id), notFound);
  await assert.rejects(env.deployments.run("bob", done.id), notFound);
  assert.deepEqual(await env.deployments.list("bob"), []);
  // Reusing alice's deployment id does not reveal nor overwrite it.
  await assert.rejects(env.deployments.create("bob", done.id, { ...draftToSpec(draft), agent: { ...draftToSpec(draft).agent!, handle: "autre-handle" } }), (error: unknown) => error instanceof TopicError && error.status === 409);
  assert.equal((await env.deployments.get("alice", done.id)).owner, "alice");
  await assert.rejects(exportAgentDraft({ owner: "bob", agentId: done.ids.agentId!, accounts: env.accounts, topics: env.topics, sources: env.sources }), notFound);
  await assert.rejects(exportAgentDraft({ owner: "bob", agentId: "not-a-uuid", accounts: env.accounts, topics: env.topics, sources: env.sources }), notFound);
  const own = await exportAgentDraft({ owner: "alice", agentId: done.ids.agentId!, accounts: env.accounts, topics: env.topics, sources: env.sources });
  assert.equal(own.handle, draft.handle);
  // Bob's export of his own agent does not include alice's sources on the same topics.
  const aliceWithSource = editDraft((await fromWords(env, "Climat")).draft, { sources: [{ url: "https://alice-only.example/rss", domain: "alice-only.example", type: "", rationale: "", origin: "user", status: "approved" }] });
  const aliceDone = await env.deploy("alice", aliceWithSource);
  const sharedTopic = (await env.accounts.watchAgents()).find(agent => agent.id === aliceDone.ids.agentId)!.primaryTopicId;
  const bobDraft = editDraft(aliceWithSource, { handle: "bob-climat", topics: [{ type: "existing", id: sharedTopic }], sources: [] });
  const bobDone = await env.deploy("bob", bobDraft);
  const bobExport = await exportAgentDraft({ owner: "bob", agentId: bobDone.ids.agentId!, accounts: env.accounts, topics: env.topics, sources: env.sources });
  assert.deepEqual(bobExport.sources, []);
});

// ---------------------------------------------------------------- compatibility

test("compatibility: specs and records of the previous format still validate", async t => {
  const env = await setup(t);
  for (const generatedBy of ["manual", "ai"] as const) {
    const spec = { target: "topic", newTopics: [{ key: "new-1", draft: { tag: `science.compat-${generatedBy}`, name: "Compat", description: "", scope: "Compatibilité", parentId: env.science.id, relatedIds: [] } }], agent: null, proposal: { generatedBy, model: generatedBy === "ai" ? "m" : null } };
    assert.ok(deploymentSpecSchema.safeParse(spec).success, generatedBy);
    const id = randomUUID();
    await env.deployments.create("alice", id, spec);
    assert.equal((await env.deployments.run("alice", id)).state, "completed");
  }
  assert.equal(deploymentSpecSchema.safeParse({ target: "topic", newTopics: [], agent: null, proposal: { generatedBy: "robot", model: null } }).success, false, "unknown origins stay refused");
  // A draft with only default provenance (no suggestion, nothing edited) is labelled manual.
  const manual = editDraft(env.fresh(), { name: "Manuel", handle: "manuel", topics: [{ type: "existing", id: env.science.id }] });
  assert.deepEqual(draftToSpec(manual).proposal, { generatedBy: "manual", model: null });
});
