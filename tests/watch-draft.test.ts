import { DEFAULT_FORMAT } from "../src/lib/watch/format";
import { TopicError } from "../src/lib/topics/types";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { createAccountStore } from "../src/lib/accounts/store";
import { DEFAULT_WATCH_POLICY } from "../src/lib/accounts/types";
import { createPublicationStore, PublicationError } from "../src/lib/publications/store";
import { openVault, PUBLICATION_ID } from "../src/lib/publications/vault";
import { createTopicStore } from "../src/lib/topics/store";
import { watchDiagnostics } from "../src/lib/watch/diagnostics";
import { checkDraft, checkText, draftHandler, draftId, reviewDraft, type DraftClaim } from "../src/lib/watch/drafting";
import { migrateWatchCandidates } from "../src/lib/watch/evaluate";
import { InferenceUnavailableError, type ChatRequest } from "../src/lib/watch/inference";
import { createJobQueue } from "../src/lib/watch/jobs";
import { createSourceStore } from "../src/lib/watch/sources";
import { recordEntries } from "../src/lib/watch/stories";
import { admit } from "../src/lib/watch/orchestrator";
import { tick, windowHandlers } from "../src/lib/watch/worker";
import { defaultSchedule } from "../src/lib/xiagents/schedule";
import { bindTo } from "./helpers/llm";

const claim = (label: string, text: string, quotes: string[], kind = "fact", status = "corroborated", attribution: string | null = null): DraftClaim => ({ label, text, kind, status, attribution, quotes: quotes.map(quote => ({ quote, publisher: "Éditeur" })) });

test("draft checks: URLs, figures, quotations, attributions, hedges, artificial threads", () => {
  const adopted = claim("A1", "Le Parlement a adopté la réforme jeudi.", ["Le Parlement a définitivement adopté jeudi la réforme", "un coût de 1 200 millions d’euros"]);
  assert.deepEqual(checkText("Le Parlement a adopté jeudi la réforme, pour un coût de 1200 millions d’euros.", [adopted]), [], "figures normalized");
  const bad = checkText("Le Parlement a adopté la réforme (voir https://exemple.fr), soit 1 500 postes et « une victoire historique pour tous » .\n\n## Sources", [adopted]);
  assert.equal(bad.length, 4);
  assert.match(bad.join(" "), /URL/); assert.match(bad.join(" "), /1500/); assert.match(bad.join(" "), /Citation absente/); assert.match(bad.join(" "), /Sources/);
  assert.deepEqual(checkText("Le Parlement a « définitivement adopté jeudi la réforme ».", [adopted]), [], "exact quotation accepted");
  const statement = claim("A2", "Le ministère affirme que la réforme garantira l'équilibre.", ["garantira l'équilibre du système"], "attributed", "primary", "Ministère du Travail");
  assert.match(checkText("La réforme garantira l'équilibre du système.", [statement]).join(), /sans attribution/, "a statement never becomes an established fact");
  assert.deepEqual(checkText("Selon le ministère du Travail, la réforme garantira l'équilibre du système.", [statement]), []);
  assert.deepEqual(checkText("Le ministère du Travail estime que la réforme garantira l'équilibre.", [statement]), []);
  const view = claim("A3", "Cette adoption marque une victoire politique.", ["une victoire politique"], "interpretation", "qualified");
  assert.match(checkText("C'est une victoire politique.", [view]).join(), /Interprétation présentée comme un fait/);
  assert.deepEqual(checkText("Selon Le Journal, c'est une victoire politique.", [view]), []);
  const claims = [adopted, statement, view];
  const post = { format: "post" as const, summary: "Le Parlement adopte la réforme.", messages: [{ text: "Le Parlement a adopté jeudi la réforme.", claims: ["A1"] }] };
  assert.deepEqual(checkDraft(post, claims), []);
  assert.match(checkDraft({ ...post, messages: [...post.messages, post.messages[0]] }, claims).join(), /seul message/);
  const thread = { format: "thread" as const, summary: "Adoption de la réforme.", messages: [
    { text: "Le Parlement a adopté jeudi la réforme.", claims: ["A1"] },
    { text: "Selon le ministère du Travail, elle garantira l'équilibre du système.", claims: ["A2"] },
    { text: "Selon Le Journal, c'est une victoire politique.", claims: ["A3"] },
  ] };
  assert.deepEqual(checkDraft(thread, claims), []);
  assert.match(checkDraft({ ...thread, messages: [...thread.messages, thread.messages[0]] }, claims).join(), /thread artificiel/);
  assert.match(checkDraft({ ...thread, messages: [thread.messages[0], { text: "Le Parlement a adopté la réforme.", claims: ["A1"] }] }, claims).join(), /aucune affirmation nouvelle/);
  assert.match(checkDraft({ ...post, messages: [{ text: "Le Parlement a adopté jeudi la réforme.", claims: ["A9"] }] }, claims).join(), /inconnue/);
  assert.match(checkDraft({ ...post, messages: [{ text: "Selon Le Journal, c'est une victoire politique.", claims: ["A3"] }] }, claims).join(), /Aucune affirmation établie/);
  assert.match(checkDraft({ ...post, summary: "Un coût de 9 milliards." }, claims).join(), /Résumé : Chiffre/);
  const id = draftId("a", "s", 2);
  assert.equal(id, draftId("a", "s", 2)); assert.notEqual(id, draftId("a", "s", 3)); assert.match(id, PUBLICATION_ID);
});

// ---------------------------------------------------------------- pipeline with a deterministic fake model

type Script = (prompt: string, attempt: number) => unknown;
function fakeModel(draft: Script, consistency: (prompt: string) => unknown = () => ({ messages: [] })) {
  const prompts: string[] = [];
  let down = false;
  return {
    prompts, setDown: (value: boolean) => { down = value; },
    inference: {
      async complete({ prompt }: ChatRequest) {
        if (down) throw new InferenceUnavailableError("Mac mini en veille.");
        prompts.push(prompt);
        const isReview = prompt.startsWith("Vérifie chaque message");
        const answer = isReview ? consistency(prompt) : draft(prompt, prompts.filter(p => !p.startsWith("Vérifie")).length);
        return JSON.stringify(answer);
      },
    },
  };
}

async function world(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "xi-watch-draft-"));
  const db = new Database(join(root, "app.sqlite"));
  db.pragma("journal_mode = WAL"); db.pragma("busy_timeout = 5000");
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  const vault = await openVault(root);
  const topics = createTopicStore({ vault, db });
  const accounts = createAccountStore({ vault, db, topics });
  const sources = createSourceStore({ vault, topics });
  const publications = createPublicationStore({ vault, db });
  const run = await topics.propose("alice", "Politique");
  await topics.confirm("alice", run.id, { tag: "politiks", name: "Politiks", description: "Test", scope: "Vie politique française.", parentId: null, relatedIds: [] }, true);
  const topicId = run.topicId;
  const proposed = await accounts.propose("alice", topicId);
  const ready = await accounts.resume("alice", proposed.id);
  await accounts.confirm("alice", ready.id, { ...ready.draft!, modelRef: "modele-local" }, true);
  const agentId = ready.accountId;
  await accounts.setWatchPolicy("alice", agentId, { revision: null, policy: { ...DEFAULT_WATCH_POLICY, enabled: true } });
  migrateWatchCandidates(db);
  const clock = Date.parse("2026-01-15T12:00:00Z");
  /** A collected story with its verified claims, as evaluation leaves it (fictitious news). */
  function candidate(items: { publisher: string; title: string; summary: string }[], claims: { text: string; kind?: string; status?: string; attribution?: string | null; quotes: [number, string][] }[], lane = "night", status = "accepted", sourceIds: string[] = []) {
    const ids: string[] = [];
    for (const [i, item] of items.entries()) {
      recordEntries(db, { owner: "alice", source: { id: sourceIds[i] ?? `src-${i}-${randomUUID()}`, publisher: item.publisher, ownerGroup: null, topicIds: [topicId] }, entries: [{ url: `https://${item.publisher.toLowerCase().replace(/\W+/g, "")}.example/${randomUUID()}`, guid: null, title: item.title, summary: item.summary, publishedAt: "2026-01-15T09:00:00.000Z", author: null, credits: [], links: [] }], now: clock });
      ids.push((db.prepare("SELECT id FROM watch_item ORDER BY rowid DESC LIMIT 1").get() as { id: string }).id);
    }
    const story = (db.prepare("SELECT story_id FROM watch_item WHERE id = ?").get(ids[0]) as { story_id: string }).story_id;
    const version = (db.prepare("SELECT item_count FROM watch_story WHERE id = ?").get(story) as { item_count: number }).item_count;
    db.prepare("INSERT INTO watch_candidate (agent_id, story_id, owner, story_version, status, stage, lane, topic_id, relevance, novelty, novelty_kind, importance, reason, data, model, prompt_version, created_at, updated_at) VALUES (?, ?, 'alice', ?, ?, 'done', ?, ?, 0.9, 1, 'new', 0.7, 'Vérifié.', ?, 'modele-local', 'veille-3.1', ?, ?)")
      .run(agentId, story, version, status, lane, topicId, JSON.stringify({ title: items[0].title }), clock, clock);
    claims.forEach((c, i) => db.prepare("INSERT INTO watch_claim VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(randomUUID(), agentId, story, i, c.text, c.kind ?? "fact", c.attribution ?? null, c.status ?? "corroborated", "Vérifié.",
      JSON.stringify({ quotes: c.quotes.map(([item, quote]) => ({ itemId: ids[item], label: `I${item + 1}`, publisher: items[item].publisher, quote, lineage: item, official: false, url: "https://x.example" })), rejectedQuotes: 0 }), new Set(c.quotes.map(([item]) => item)).size));
    return { story, version };
  }
  const job = (story: string, version: number) => ({ id: randomUUID(), kind: "draft-candidate", key: "k", payload: { agentId, storyId: story, version }, state: "running" as const, runAfter: 0, attempts: 1, maxAttempts: 3, leaseToken: "t", leaseUntil: 0, lastError: null, result: null, createdAt: 0, updatedAt: 0 });
  const handler = (model: ReturnType<typeof fakeModel>, store = publications) => draftHandler({ db, accounts, topics, publications: store, llm: bindTo(model.inference), now: () => clock });
  const row = (story: string) => db.prepare("SELECT status, reason, data FROM watch_candidate WHERE agent_id = ? AND story_id = ?").get(agentId, story) as { status: string; reason: string; data: string };
  return { root, db, vault, topics, accounts, sources, publications, topicId, agentId, candidate, job, handler, row, clock };
}

const reform = [
  { publisher: "Le Quotidien", title: "Le Parlement adopte la réforme des retraites", summary: "Le Parlement a définitivement adopté jeudi la réforme des retraites, qui fixe l'âge légal à 64 ans." },
  { publisher: "Le Journal", title: "Réforme des retraites : vote définitif", summary: "Les parlementaires ont voté jeudi la réforme des retraites. Le ministère du Travail a déclaré qu'elle garantira l'équilibre du système d'ici 2030. Pour Le Journal, c'est une victoire politique." },
];
const reformClaims = [
  { text: "Le Parlement a définitivement adopté la réforme des retraites jeudi.", quotes: [[0, "Le Parlement a définitivement adopté jeudi la réforme des retraites"], [1, "Les parlementaires ont voté jeudi la réforme des retraites"]] as [number, string][] },
  { text: "L'âge légal est fixé à 64 ans.", quotes: [[0, "qui fixe l'âge légal à 64 ans"]] as [number, string][], status: "single-source" },
  { text: "Le ministère du Travail affirme que la réforme garantira l'équilibre du système d'ici 2030.", kind: "attributed", status: "primary", attribution: "Ministère du Travail", quotes: [[1, "Le ministère du Travail a déclaré qu'elle garantira l'équilibre du système d'ici 2030"]] as [number, string][] },
  { text: "Le Journal y voit une victoire politique.", kind: "interpretation", status: "qualified", quotes: [[1, "Pour Le Journal, c'est une victoire politique"]] as [number, string][] },
];

test("drafting: sourced private post, Markdown on disk, never a fixture, isolation, idempotence and restart", { timeout: 30_000 }, async t => {
  const w = await world(t);
  const { story, version } = w.candidate(reform, reformClaims);
  const model = fakeModel(prompt => {
    assert.ok(!prompt.includes("64 ans"), "single-voice claims are never offered to the writer");
    assert.match(prompt, /Charte : Transparence/); assert.match(prompt, /Style : ton /); assert.match(prompt, /Vie politique française/);
    return { format: "post", summary: "Le Parlement a adopté jeudi la réforme des retraites.", messages: [{ text: "Le Parlement a définitivement adopté **jeudi** la réforme des retraites. Selon le ministère du Travail, elle garantira l'équilibre du système d'ici 2030.", claims: ["A1", "A2"] }] };
  });
  const result = await w.handler(model)(w.job(story, version));
  assert.deepEqual(result, { status: "done", result: { outcome: "drafted", id: draftId(w.agentId, story, version), llm: { model: "modele-local", instance: "Instance de test", instanceSource: "global" } } });
  const id = draftId(w.agentId, story, version);
  const draft = await w.publications.get({ id: "alice" }, id);
  assert.deepEqual([draft.status, draft.visibility, draft.type, draft.authorType, draft.authorId], ["draft", "private", "post", "ai", w.agentId]);
  assert.equal(draft.sources.length, 2);
  assert.deepEqual(draft.sources.map(source => source.publisher).sort(), ["Le Journal", "Le Quotidien"]);
  assert.ok(draft.sources.every(source => source.url?.startsWith("https://") && source.claims!.length > 0));
  assert.match(draft.sources[0].reservations!.join(), /résumé publié dans le flux/);
  assert.match(draft.messages[0].body, /^Le Parlement a définitivement adopté \*\*jeudi\*\*[\s\S]*\n## Sources\n- \[\[posts\/_generators\//);
  // Markdown on disk: a real draft, never labelled as a fixture.
  const path = (w.db.prepare("SELECT path FROM publication WHERE id = ?").get(id) as { path: string }).path;
  const index = await readFile(join(w.root, path, "index.md"), "utf8");
  for (const field of ["status: draft", "visibility: private", "generated_by: watch-draft-v1", "review: pending", `story: ${story}`, "model: modele-local", "prompt_version: redaction-5.0", "importance: 0.7", "lane: night"]) assert.ok(index.includes(field), field);
  assert.ok(!index.includes("test_content") && !(await readFile(join(w.root, path, draft.messages[0].file), "utf8")).includes("Contenu de test fictif"));
  assert.equal((await readdir(join(w.root, path, "_sources"))).length, 2);
  assert.equal(w.row(story).status, "drafted");
  // Drafts are private: not in feeds, unreadable by others.
  assert.ok(!(await w.publications.page({ id: "alice" }, { kind: "home" })).items.some(item => item.id === id));
  await assert.rejects(w.publications.get({ id: "bob" }, id), /introuvable/);
  assert.equal((await w.publications.agentPublications(w.agentId)).length, 0, "a draft is not a publication");
  // Idempotence: the same job again, then a crash between writing and marking the candidate.
  const calls = model.prompts.length;
  assert.deepEqual(await w.handler(model)(w.job(story, version)), { status: "done", result: { outcome: "already-drafted" } });
  w.db.prepare("UPDATE watch_candidate SET status = 'accepted' WHERE story_id = ?").run(story);
  const restarted = createPublicationStore({ vault: w.vault, db: w.db });
  assert.deepEqual(await w.handler(model, restarted)(w.job(story, version)), { status: "done", result: { outcome: "drafted", id, llm: { model: "modele-local", instance: "Instance de test", instanceSource: "global" } } });
  assert.equal(model.prompts.length, calls, "the validated text is reused, the model is not asked again");
  assert.equal((await readdir(join(w.root, "posts", "_generators", w.agentId))).filter(name => !name.startsWith(".")).length, 1);
  // Diagnostics after a restart: owner only.
  const diagnostics = await watchDiagnostics({ db: w.db, accounts: w.accounts, sources: w.sources, publications: restarted, owner: "alice", agentId: w.agentId, autoPublish: false });
  assert.deepEqual(diagnostics.drafts.map(d => [d.id, d.review, d.messages.length, d.sources.length]), [[id, "pending", 1, 2]]);
  assert.match(diagnostics.drafts[0].messages[0].prose, /^Le Parlement/); assert.match(diagnostics.drafts[0].messages[0].sources, /^## Sources/);
  await assert.rejects(watchDiagnostics({ db: w.db, accounts: w.accounts, sources: w.sources, publications: restarted, owner: "bob", agentId: w.agentId, autoPublish: false }), /introuvable/);
});

test("drafting: threads only when justified, hallucinations corrected or held, consistency check, outage", { timeout: 30_000 }, async t => {
  const w = await world(t);
  // A justified thread: three distinct claims, attributions and hedges kept.
  const a = w.candidate(reform, reformClaims);
  const thread = fakeModel(() => ({ format: "thread", summary: "La réforme des retraites est adoptée.", messages: [
    { text: "Le Parlement a définitivement adopté jeudi la réforme des retraites.", claims: ["A1"] },
    { text: "Selon le ministère du Travail, elle garantira l'équilibre du système d'ici 2030.", claims: ["A2"] },
    { text: "Selon Le Journal, c'est une victoire politique.", claims: ["A3"] },
  ] }));
  await w.handler(thread)(w.job(a.story, a.version));
  assert.equal(w.row(a.story).status, "drafted");
  const threadDraft = await w.publications.get({ id: "alice" }, draftId(w.agentId, a.story, a.version));
  assert.deepEqual([threadDraft.type, threadDraft.messages.length], ["thread", 3]);
  const conversation = await w.publications.conversation({ id: "alice" }, `${threadDraft.id}/3`);
  assert.deepEqual(conversation.thread.map(entry => entry.ref), [1, 2, 3].map(n => `${threadDraft.id}/${n}`));
  assert.deepEqual([conversation.ancestors.length, conversation.children.length], [0, 0]);

  // Hallucinated figure, invented quotation and URL: refused, corrected on the second attempt.
  const b = w.candidate([{ publisher: "La Gazette", title: "Le Sénat vote la loi sur l'eau", summary: "Le Sénat a adopté mardi la loi sur la gestion de l'eau par 210 voix contre 98." }, { publisher: "Le Soir", title: "Loi sur l'eau adoptée au Sénat", summary: "Les sénateurs ont adopté mardi la loi sur l'eau." }],
    [{ text: "Le Sénat a adopté la loi sur l'eau mardi.", quotes: [[0, "Le Sénat a adopté mardi la loi sur la gestion de l'eau"], [1, "Les sénateurs ont adopté mardi la loi sur l'eau"]] }]);
  const corrected = fakeModel((prompt, attempt) => attempt === 1
    ? { format: "post", summary: "Le Sénat adopte la loi sur l'eau.", messages: [{ text: "Le Sénat a adopté mardi la loi sur l'eau par 250 voix, « une avancée majeure pour le pays » (https://senat.example).", claims: ["A1"] }] }
    : (assert.ok(["Corrige ces problèmes", "250", "Citation absente", "URL"].every(part => prompt.includes(part)), "problems are fed back"), { format: "post", summary: "Le Sénat adopte la loi sur l'eau.", messages: [{ text: "Le Sénat a adopté mardi la loi sur la gestion de l'eau.", claims: ["A1"] }] }));
  await w.handler(corrected)(w.job(b.story, b.version));
  assert.equal(w.row(b.story).status, "drafted");
  assert.equal(JSON.parse(w.row(b.story).data).drafting.attempts.length, 2);
  assert.ok(!(await w.publications.get({ id: "alice" }, draftId(w.agentId, b.story, b.version))).messages[0].body.includes("250"));

  // An artificial thread is refused twice, then a shorter post is imposed.
  const c = w.candidate([{ publisher: "La Gazette", title: "Le gouvernement présente le budget 2027", summary: "Le gouvernement a présenté mercredi le projet de budget pour 2027." }, { publisher: "Le Soir", title: "Budget 2027 présenté", summary: "Le projet de budget pour 2027 a été présenté mercredi en Conseil des ministres." }],
    [{ text: "Le gouvernement a présenté le budget 2027 mercredi.", quotes: [[0, "Le gouvernement a présenté mercredi le projet de budget pour 2027"], [1, "Le projet de budget pour 2027 a été présenté mercredi"]] }]);
  const padded = fakeModel(prompt => prompt.includes("Format imposé : post")
    ? { format: "post", summary: "Le budget 2027 est présenté.", messages: [{ text: "Le gouvernement a présenté mercredi le projet de budget pour 2027.", claims: ["A1"] }] }
    : { format: "thread", summary: "Budget 2027.", messages: [1, 2, 3].map(() => ({ text: "Le gouvernement a présenté mercredi le projet de budget pour 2027.", claims: ["A1"] })) });
  await w.handler(padded)(w.job(c.story, c.version));
  const budget = await w.publications.get({ id: "alice" }, draftId(w.agentId, c.story, c.version));
  assert.deepEqual([budget.type, JSON.parse(w.row(c.story).data).drafting.attempts.map((x: { problems: string[] }) => x.problems.length > 0)], ["post", [true, true, false]]);

  // A statement repeatedly turned into an established fact: held, never written.
  const d = w.candidate([{ publisher: "Le Soir", title: "Le ministre promet le plein emploi", summary: "Le ministre de l'Économie a déclaré que le plein emploi serait atteint en 2027." }, { publisher: "La Gazette", title: "Plein emploi : la promesse du ministre", summary: "Le ministre de l'Économie a déclaré mardi que le plein emploi serait atteint en 2027." }],
    [{ text: "Le ministre affirme que le plein emploi sera atteint en 2027.", kind: "attributed", attribution: "Ministre de l'Économie", quotes: [[0, "Le ministre de l'Économie a déclaré que le plein emploi serait atteint en 2027"], [1, "a déclaré mardi que le plein emploi serait atteint en 2027"]] }]);
  const assertive = fakeModel(() => ({ format: "post", summary: "Plein emploi en 2027.", messages: [{ text: "Le plein emploi sera atteint en 2027.", claims: ["A1"] }] }));
  await w.handler(assertive)(w.job(d.story, d.version));
  assert.deepEqual([w.row(d.story).status, /non conforme[\s\S]*sans attribution/.test(w.row(d.story).reason)], ["held", true]);
  assert.equal((w.db.prepare("SELECT count(*) AS n FROM publication WHERE id = ?").get(draftId(w.agentId, d.story, d.version)) as { n: number }).n, 0);

  // The local consistency check rejects a text the code cannot fault, the next attempt passes.
  const e = w.candidate([{ publisher: "Le Soir", title: "La mairie ferme la piscine", summary: "La mairie de Lille a fermé lundi la piscine municipale pour travaux." }, { publisher: "La Gazette", title: "Lille : piscine fermée", summary: "La piscine municipale de Lille est fermée pour travaux depuis lundi." }],
    [{ text: "La mairie de Lille a fermé la piscine municipale lundi.", quotes: [[0, "La mairie de Lille a fermé lundi la piscine municipale"], [1, "La piscine municipale de Lille est fermée pour travaux"]] }]);
  let reviews = 0;
  const reviewed = fakeModel(() => ({ format: "post", summary: "La piscine de Lille ferme.", messages: [{ text: "La mairie de Lille a fermé lundi la piscine municipale.", claims: ["A1"] }] }),
    () => (++reviews === 1 ? { messages: [{ index: 1, supported: false, problems: ["« définitivement » ajouté"] }] } : { messages: [{ index: 1, supported: true, problems: [] }] }));
  await w.handler(reviewed)(w.job(e.story, e.version));
  assert.deepEqual([w.row(e.story).status, reviews], ["drafted", 2]);
  assert.match(JSON.parse(w.row(e.story).data).drafting.attempts[0].problems.join(), /non soutenu/);

  // Outage during drafting: the job waits, nothing is lost, then it completes.
  const f = w.candidate([{ publisher: "Le Soir", title: "Le Conseil d'État annule un décret", summary: "Le Conseil d'État a annulé vendredi le décret sur les horaires." }, { publisher: "La Gazette", title: "Décret annulé", summary: "Vendredi, le Conseil d'État a annulé le décret sur les horaires." }],
    [{ text: "Le Conseil d'État a annulé le décret vendredi.", quotes: [[0, "Le Conseil d'État a annulé vendredi le décret"], [1, "le Conseil d'État a annulé le décret sur les horaires"]] }]);
  const flaky = fakeModel(() => ({ format: "post", summary: "Le décret est annulé.", messages: [{ text: "Le Conseil d'État a annulé vendredi le décret sur les horaires.", claims: ["A1"] }] }));
  flaky.setDown(true);
  const waited = await w.handler(flaky)(w.job(f.story, f.version));
  assert.equal(waited.status, "wait");
  assert.equal(w.row(f.story).status, "accepted");
  flaky.setDown(false);
  await w.handler(flaky)(w.job(f.story, f.version));
  assert.equal(w.row(f.story).status, "drafted");
});

test("drafting jobs: only accepted night or alert candidates are planned, once", async t => {
  const w = await world(t);
  const accepted = w.candidate(reform, reformClaims);
  const held = w.candidate([{ publisher: "Le Soir", title: "Une rumeur de remaniement", summary: "Un remaniement serait envisagé." }], [{ text: "Un remaniement est envisagé.", kind: "hypothesis", status: "qualified", quotes: [[0, "Un remaniement serait envisagé"]] }], "night", "held");
  const weekly = w.candidate([{ publisher: "La Gazette", title: "Bilan des questions au gouvernement", summary: "Les questions au gouvernement ont porté sur la santé." }], [{ text: "Les questions ont porté sur la santé.", quotes: [[0, "Les questions au gouvernement ont porté sur la santé"]] }], "weekly");
  const model = fakeModel(() => ({ format: "post", summary: "Adoption.", messages: [{ text: "Le Parlement a définitivement adopté jeudi la réforme des retraites.", claims: ["A1"] }] }));
  const handlers = { "draft-candidate": w.handler(model) };
  const run = () => tick({ db: w.db, accounts: w.accounts, handlers, canEvaluate: () => true, now: () => new Date(w.clock) });
  assert.equal((await run()).planned, 1);
  assert.equal(w.row(accepted.story).status, "drafted");
  assert.deepEqual([w.row(held.story).status, w.row(weekly.story).status], ["held", "accepted"]);
  assert.equal((await run()).planned, 0, "drafted candidates are not planned again");
  assert.equal(createJobQueue(w.db).counts().done, 1);
});

test("drafting jobs: a story already too old for its lane is neither planned nor drafted", async t => {
  const w = await world(t);
  const old = w.candidate(reform, reformClaims);
  // Fixture: first published 40 h before the pass (night lane: 36 h at most).
  w.db.prepare("UPDATE watch_story SET first_published_at = ? WHERE id = ?").run(new Date(w.clock - 40 * 3_600_000).toISOString(), old.story);
  const model = fakeModel(() => ({ format: "post", summary: "Adoption.", messages: [{ text: "Le Parlement a définitivement adopté jeudi la réforme des retraites.", claims: ["A1"] }] }));
  assert.equal((await tick({ db: w.db, accounts: w.accounts, handlers: { "draft-candidate": w.handler(model) }, canEvaluate: () => true, now: () => new Date(w.clock) })).planned, 0);
  assert.equal(w.row(old.story).status, "accepted");
  const report = await watchDiagnostics({ db: w.db, accounts: w.accounts, sources: w.sources, owner: "alice", agentId: w.agentId, autoPublish: true, now: new Date(w.clock) });
  assert.match(report.candidates.find(c => c.storyId === old.story)!.blocker.reason, /trop ancienne/);
  // A job queued before it became too old: no model call, the candidate is held with the reason.
  const result = await w.handler(model)(w.job(old.story, old.version));
  assert.deepEqual(result, { status: "done", result: { outcome: "held", reason: "obsolete" } });
  assert.match(w.row(old.story).reason, /trop ancienne pour la voie nocturne \(plus de 36 h\)/);
  assert.equal(model.prompts.length, 0);
});

test("night: a candidate accepted at 23:30, after the watch closes, is drafted overnight and published in the window", { timeout: 30_000 }, async t => {
  const w = await world(t);
  // Calendar: watch 07:00–23:00, publication 03:00–06:00 (Paris), no off-hours major events; autonomous, private.
  await w.accounts.setSchedule("alice", w.agentId, { revision: (await w.accounts.schedule("alice", w.agentId)).revision, schedule: defaultSchedule("Europe/Paris") });
  const current = await w.accounts.watchPolicy("alice", w.agentId);
  await w.accounts.setWatchPolicy("alice", w.agentId, { revision: current.revision, policy: { ...current.policy, enabled: true, autoPublish: true } });
  const clock = { now: Date.parse("2026-01-15T22:30:00Z") }; // 23:30 Paris
  // Catalogue sources approved by the owner: the publisher re-checks trust at the last moment.
  const approved = [];
  for (const { publisher } of reform) {
    const { source } = await w.sources.propose("alice", { url: `https://${publisher.toLowerCase().replace(/\W+/g, "")}.example/rss`, kind: "feed", site: null, publisher, topicIds: [w.topicId], reliability: { level: "inconnue", reasons: [], estimated: true } }, "alice");
    approved.push((await w.sources.decide("alice", source.id, { action: "approve", revision: source.revision })).id);
  }
  const accepted = w.candidate(reform, reformClaims, "night", "accepted", approved);
  const agent = () => w.accounts.watchAgents().then(agents => agents.find(item => item.id === w.agentId)!);
  // The watch itself stays closed: evaluation and collection wait for 07:00.
  assert.deepEqual([admit({ kind: "evaluate-story", payload: {} }, await agent(), new Map(), clock.now).allowed, admit({ kind: "draft-candidate", payload: {} }, await agent(), new Map(), clock.now).allowed], [false, true]);
  // An explicit pause still holds drafting.
  const paused = await agent();
  assert.equal(admit({ kind: "draft-candidate", payload: {} }, { ...paused, watch: { ...paused.watch, policy: { ...paused.watch.policy, paused: true } } }, new Map(), clock.now).allowed, false);

  const model = fakeModel(() => ({ format: "post", summary: "Adoption.", messages: [{ text: "Le Parlement a définitivement adopté jeudi la réforme des retraites.", claims: ["A1"] }] }));
  const publications = createPublicationStore({ vault: w.vault, db: w.db, now: () => new Date(clock.now) });
  const handlers = {
    "draft-candidate": draftHandler({ db: w.db, accounts: w.accounts, topics: w.topics, publications, llm: bindTo(model.inference), now: () => clock.now }),
    ...windowHandlers({ db: w.db, accounts: w.accounts, sources: w.sources, publications, settings: { autoPublish: true, allowPublic: false }, now: () => clock.now }),
  };
  const run = () => tick({ db: w.db, accounts: w.accounts, handlers, canEvaluate: () => true, now: () => new Date(clock.now) });
  await run();
  assert.equal(w.row(accepted.story).status, "drafted", "drafted overnight, outside the watch calendar");
  assert.equal((w.db.prepare("SELECT count(*) AS n FROM watch_decision").get() as { n: number }).n, 0, "nothing published before the window");
  // The publication window (03:00–06:00 Paris) is unchanged: published there, privately, by the agent.
  clock.now = (w.db.prepare("SELECT run_after FROM watch_job WHERE kind = 'publication-window' AND state = 'pending'").get() as { run_after: number }).run_after;
  assert.ok(clock.now >= Date.parse("2026-01-16T02:00:00Z") && clock.now < Date.parse("2026-01-16T05:00:00Z"), "the planned window, 03:00–06:00 Paris");
  await run();
  assert.equal(w.row(accepted.story).status, "published");
  const [published] = publications.agentPublications(w.agentId);
  assert.ok(published && !published.test);
  const full = await publications.get({ id: "alice" }, published.id);
  assert.deepEqual([full.status, full.visibility], ["published", "private"]);
});

test("owner review: edits stay within the sources, rejection, private approval, isolation, stale revisions", { timeout: 30_000 }, async t => {
  const w = await world(t);
  const model = fakeModel(() => ({ format: "post", summary: "Adoption de la réforme.", messages: [{ text: "Le Parlement a définitivement adopté jeudi la réforme des retraites.", claims: ["A1"] }] }));
  const first = w.candidate(reform, reformClaims);
  await w.handler(model)(w.job(first.story, first.version));
  const id = draftId(w.agentId, first.story, first.version);
  const draft = await w.publications.get({ id: "alice" }, id);
  const review = (owner: string, input: unknown, draft = id) => reviewDraft({ db: w.db, publications: w.publications, owner, agentId: w.agentId, draftId: draft, input, format: DEFAULT_FORMAT });
  await assert.rejects(review("alice", { action: "update", revision: draft.revision, messages: ["Le Parlement a adopté la réforme par 300 voix."] }), /Chiffre absent/);
  await assert.rejects(review("alice", { action: "update", revision: draft.revision, messages: ["Voir https://exemple.fr"] }), /URL/);
  await assert.rejects(review("alice", { action: "update", revision: draft.revision, messages: ["Texte\n\n## Sources\n- autre"] }), /Sources|section/);
  await assert.rejects(review("alice", { action: "update", revision: draft.revision, messages: ["Un", "Deux"] }), /conservé/);
  await assert.rejects(review("bob", { action: "approve", revision: draft.revision }), (error: Error) => (error instanceof PublicationError && error.code === "not_found") || (error instanceof TopicError && error.status === 404));
  const edited = await review("alice", { action: "update", revision: draft.revision, messages: ["Jeudi, le Parlement a **définitivement** adopté la réforme des retraites."] });
  assert.match(edited.messages[0].body, /^Jeudi, le Parlement a \*\*définitivement\*\*[\s\S]*\n## Sources\n- \[\[/);
  assert.equal(edited.sources.length, draft.sources.length, "sources untouched");
  await assert.rejects(review("alice", { action: "approve", revision: draft.revision }), /changé/);
  // Approval: published privately, never publicly; it now counts as a real publication.
  const approved = await review("alice", { action: "approve", revision: edited.revision });
  assert.deepEqual([approved.status, approved.visibility], ["published", "private"]);
  await assert.rejects(w.publications.get({ id: "bob" }, id), /introuvable/);
  await w.publications.ensureIndexed();
  assert.deepEqual(w.publications.agentPublications(w.agentId).map(p => [p.id, p.test]), [[id, false]]);
  await assert.rejects(review("alice", { action: "reject", revision: approved.revision }), /plus modifiable/);
  assert.match(w.row(first.story).reason, /publié en privé/);
  // Rejection: kept as a rejected draft, candidate rejected.
  const second = w.candidate([{ publisher: "Le Soir", title: "Le maire de Lyon présente son plan vélo", summary: "Le maire de Lyon a présenté mardi un plan vélo." }, { publisher: "La Gazette", title: "Lyon : plan vélo", summary: "Un plan vélo a été présenté mardi par le maire de Lyon." }],
    [{ text: "Le maire de Lyon a présenté un plan vélo mardi.", quotes: [[0, "Le maire de Lyon a présenté mardi un plan vélo"], [1, "Un plan vélo a été présenté mardi par le maire de Lyon"]] }]);
  await w.handler(fakeModel(() => ({ format: "post", summary: "Plan vélo à Lyon.", messages: [{ text: "Le maire de Lyon a présenté mardi un plan vélo.", claims: ["A1"] }] })))(w.job(second.story, second.version));
  const otherId = draftId(w.agentId, second.story, second.version);
  const rejected = await review("alice", { action: "reject", revision: (await w.publications.get({ id: "alice" }, otherId)).revision }, otherId);
  assert.equal(rejected.status, "draft");
  assert.equal(w.row(second.story).status, "rejected");
  await assert.rejects(review("alice", { action: "approve", revision: rejected.revision }, otherId), /plus modifiable/);
  const index = await readFile(join(w.root, (w.db.prepare("SELECT path FROM publication WHERE id = ?").get(otherId) as { path: string }).path, "index.md"), "utf8");
  assert.match(index, /review: rejected/); assert.match(index, /by: alice/);
});

test("format limits: a too-long answer is rewritten, never truncated; then an explicit failure", { timeout: 30_000 }, async t => {
  const w = await world(t);
  const long = "Le Parlement a définitivement adopté jeudi la réforme des retraites. ".repeat(5).trim();
  const short = "Le Parlement a définitivement adopté jeudi la réforme des retraites.";
  // First answer over 280 characters: the model is asked to rewrite it, with the measured length.
  const first = w.candidate(reform, reformClaims);
  const rewriting = fakeModel((prompt, n) => {
    assert.match(prompt, /un post fait au plus 280 caractères \(idéalement 180 à 250\)/);
    if (n === 2) assert.match(prompt, /Message 1 : \d+ caractères, au-delà de la limite de 280/);
    return { format: "post", summary: "Adoption de la réforme.", messages: [{ text: n === 1 ? long : short, claims: ["A1"] }] };
  });
  assert.equal((await w.handler(rewriting)(w.job(first.story, first.version))).status, "done");
  const draft = await w.publications.get({ id: "alice" }, draftId(w.agentId, first.story, first.version));
  assert.match(draft.messages[0].body, new RegExp(`^${short}\\n\\n## Sources`), "the rewritten text, whole");

  // Always too long: 1 + 2 corrections, then held with the reason; no draft is written.
  const second = w.candidate([{ publisher: "Le Soir", title: "Le maire de Lyon présente son plan vélo", summary: "Le maire de Lyon a présenté mardi un plan vélo." }, { publisher: "La Gazette", title: "Lyon : plan vélo", summary: "Un plan vélo a été présenté mardi par le maire de Lyon." }],
    [{ text: "Le maire de Lyon a présenté un plan vélo mardi.", quotes: [[0, "Le maire de Lyon a présenté mardi un plan vélo"], [1, "Un plan vélo a été présenté mardi par le maire de Lyon"]] }]);
  const stubborn = fakeModel(() => ({ format: "post", summary: "Plan vélo.", messages: [{ text: "Le maire de Lyon a présenté mardi un plan vélo. ".repeat(8), claims: ["A1"] }] }));
  await w.handler(stubborn)(w.job(second.story, second.version));
  assert.equal(stubborn.prompts.filter(p => !p.startsWith("Vérifie")).length, 3);
  assert.equal(w.row(second.story).status, "held");
  assert.match(w.row(second.story).reason, /non conforme après 3 essai\(s\) \(2 correction\(s\) autorisée\(s\)\) : Message 1 : \d+ caractères/);
  await assert.rejects(w.publications.get({ id: "alice" }, draftId(w.agentId, second.story, second.version)), /introuvable/);
  const diagnostics = await watchDiagnostics({ db: w.db, accounts: w.accounts, sources: w.sources, publications: w.publications, owner: "alice", agentId: w.agentId, autoPublish: false });
  assert.deepEqual(diagnostics.draftFailures.map(failure => [failure.storyId, failure.attempts.length]), [[second.story, 3]]);
  assert.deepEqual(diagnostics.format.resolved, { ok: true, format: DEFAULT_FORMAT });
});

test("format limits: agent overrides (threads off, no correction), model's decline, owner review", { timeout: 30_000 }, async t => {
  const w = await world(t);
  const current = await w.accounts.watchPolicy("alice", w.agentId);
  await w.accounts.setWatchPolicy("alice", w.agentId, { revision: current.revision, policy: { ...current.policy, format: { threads: false, correctionAttempts: 0, maxPostChars: 260 } } });
  const thread = { format: "thread", summary: "Réforme.", messages: [
    { text: "Le Parlement a définitivement adopté jeudi la réforme des retraites.", claims: ["A1"] },
    { text: "Selon le ministère du Travail, elle garantira l'équilibre du système d'ici 2030.", claims: ["A2"] },
  ] };
  const a = w.candidate(reform, reformClaims);
  const model = fakeModel(prompt => {
    assert.match(prompt, /Format imposé : post, un seul message/, "threads off: posts only, never a thread");
    assert.match(prompt, /au plus 260 caractères/);
    return thread;
  });
  await w.handler(model)(w.job(a.story, a.version));
  assert.equal(model.prompts.length, 1, "no correction allowed");
  assert.equal(w.row(a.story).status, "held");
  assert.match(w.row(a.story).reason, /1 essai\(s\) \(0 correction/);
  assert.match(w.row(a.story).reason, /threads sont désactivés|Un post était imposé/);

  // The model may decline: no publication, and the verdict is kept (not asked again).
  const b = w.candidate([{ publisher: "Le Soir", title: "Le maire de Lyon présente son plan vélo", summary: "Le maire de Lyon a présenté mardi un plan vélo." }, { publisher: "La Gazette", title: "Lyon : plan vélo", summary: "Un plan vélo a été présenté mardi par le maire de Lyon." }],
    [{ text: "Le maire de Lyon a présenté un plan vélo mardi.", quotes: [[0, "Le maire de Lyon a présenté mardi un plan vélo"], [1, "Un plan vélo a été présenté mardi par le maire de Lyon"]] }]);
  const declining = fakeModel(() => ({ format: "none", reason: "Information redondante." }));
  await w.handler(declining)(w.job(b.story, b.version));
  assert.equal(w.row(b.story).status, "held");
  assert.match(w.row(b.story).reason, /Aucune publication : .*Information redondante/);
  w.db.prepare("UPDATE watch_candidate SET status = 'accepted' WHERE story_id = ?").run(b.story);
  await w.handler(declining)(w.job(b.story, b.version));
  assert.equal(declining.prompts.length, 1);

  // Owner review: an edit or an approval beyond the limits is refused, never truncated.
  const c = w.candidate([{ publisher: "Le Monde", title: "Le Sénat vote le budget", summary: "Le Sénat a voté mardi le budget de la Sécurité sociale." }, { publisher: "Le Figaro", title: "Budget voté", summary: "Les sénateurs ont voté mardi le budget de la Sécurité sociale." }],
    [{ text: "Le Sénat a voté le budget de la Sécurité sociale mardi.", quotes: [[0, "Le Sénat a voté mardi le budget de la Sécurité sociale"], [1, "Les sénateurs ont voté mardi le budget de la Sécurité sociale"]] }]);
  await w.handler(fakeModel(() => ({ format: "post", summary: "Budget voté.", messages: [{ text: "Le Sénat a voté mardi le budget de la Sécurité sociale.", claims: ["A1"] }] })))(w.job(c.story, c.version));
  const id = draftId(w.agentId, c.story, c.version);
  const draft = await w.publications.get({ id: "alice" }, id);
  const limits = { ...DEFAULT_FORMAT, maxPostChars: 260 };
  await assert.rejects(reviewDraft({ db: w.db, publications: w.publications, owner: "alice", agentId: w.agentId, draftId: id, format: limits, input: { action: "update", revision: draft.revision, messages: ["Le Sénat a voté mardi le budget de la Sécurité sociale. ".repeat(6)] } }), (error: TopicError) => error.status === 422 && /Modification refusée : Message 1 : \d+ caractères/.test(error.message));
  await assert.rejects(reviewDraft({ db: w.db, publications: w.publications, owner: "alice", agentId: w.agentId, draftId: id, format: { ...limits, maxPostChars: 50, targetPostMin: 50, targetPostMax: 50 }, input: { action: "approve", revision: draft.revision } }), /Approbation refusée/);
  assert.equal((await w.publications.get({ id: "alice" }, id)).status, "draft");
});
