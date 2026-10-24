import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { assertWithin, writeAtomic, type Vault } from "../publications/vault";
import { deterministicAnalyzer, routeRequest, type TopicAnalyzer } from "./analysis";
import { locked } from "./lock";
import { draftSchema, STEP_NAMES, TopicError, topicSchema, type Run, type Topic } from "./types";

const encode = (value: unknown) => `---\n${stringify(value)}---\n`;
const decode = (text: string) => {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) throw new TopicError("Fichier Markdown invalide.");
  return parse(match[1]);
};
const intentSchema = z.string().trim().min(3).max(2000);
const uuid = (id: string) => z.uuid().parse(id);
export function validateTopics(topics: Topic[]) {
  const tags = new Map<string, string>();
  const ids = new Set(topics.map(t => t.id));
  if (ids.size !== topics.length) throw new TopicError("UUID dupliqué.", 409);
  for (const t of topics) {
    for (const tag of [t.tag, ...t.aliases]) {
      if (tags.has(tag)) throw new TopicError(`Tag ou ancien tag déjà réservé : ${tag}`, 409);
      tags.set(tag, t.id);
    }
    if (new Set(t.relatedIds).size !== t.relatedIds.length || t.relatedIds.some(id => id === t.id || !ids.has(id))) throw new TopicError("Relation transversale invalide.");
    const seen = new Set([t.id]);
    let cursor = t;
    while (cursor.parentId) {
      if (seen.has(cursor.parentId)) throw new TopicError("Cycle hiérarchique interdit.");
      seen.add(cursor.parentId);
      const parent = topics.find(p => p.id === cursor.parentId);
      if (!parent) throw new TopicError("Parent introuvable.");
      cursor = parent;
    }
    const parent = topics.find(p => p.id === t.parentId);
    const prefix = parent ? `${parent.tag}.` : "";
    if (!t.tag.startsWith(prefix) || t.tag.slice(prefix.length).includes(".")) throw new TopicError("Le tag doit spécialiser directement celui du parent.");
  }
}

export function createTopicStore({ vault, db, analyzer = deterministicAnalyzer, beforeStep }: { vault: Vault; db: Database.Database; analyzer?: TopicAnalyzer; beforeStep?: (step: number) => void }) {
  const directory = join(vault.root, "topics");
  const privateDir = join(vault.root, ".xi-topic-runs");
  db.exec(`CREATE TABLE IF NOT EXISTS topic_index (id TEXT PRIMARY KEY, tag TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS topic_tag (tag TEXT PRIMARY KEY, topic_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS topic_routing (parent_id TEXT NOT NULL, child_id TEXT PRIMARY KEY);`);
  async function prepare() {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await mkdir(privateDir, { recursive: true, mode: 0o700 });
    await assertWithin(vault.root, directory);
    await assertWithin(vault.root, privateDir);
  }
  async function read(path: string) { await assertWithin(vault.root, path); return decode(await readFile(path, "utf8")); }
  async function all(): Promise<Topic[]> {
    const names = (await readdir(directory)).filter(name => /^[0-9a-f-]{36}\.md$/.test(name));
    const topics = await Promise.all(names.map(async name => {
      const topic = topicSchema.parse(await read(join(directory, name)));
      if (`${topic.id}.md` !== name) throw new TopicError("UUID et fichier incohérents.");
      return topic;
    }));
    validateTopics(topics);
    return topics.sort((a, b) => a.tag.localeCompare(b.tag));
  }
  const journal = join(directory, ".pending.md");
  async function recover() {
    let pending: Topic[];
    try { pending = z.array(topicSchema).parse(await read(journal)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    validateTopics(pending);
    for (const topic of pending) await writeAtomic(join(directory, `${topic.id}.md`), encode(topic));
    await rm(journal);
  }
  async function exclusive<T>(task: () => Promise<T>) {
    await prepare();
    return locked(directory, async () => { await recover(); return task(); });
  }
  function refreshRouting(topics: Topic[]) {
    db.transaction(() => {
      db.exec("DELETE FROM topic_routing");
      for (const topic of topics) if (topic.parentId) db.prepare("INSERT INTO topic_routing VALUES (?, ?)").run(topic.parentId, topic.id);
    })();
  }
  function index(topics: Topic[], routing = true) {
    validateTopics(topics);
    db.transaction(() => {
      db.exec("DELETE FROM topic_tag; DELETE FROM topic_index;");
      for (const topic of topics) {
        db.prepare("INSERT INTO topic_index VALUES (?, ?, ?)").run(topic.id, topic.tag, JSON.stringify(topic));
        for (const tag of [topic.tag, ...topic.aliases]) db.prepare("INSERT INTO topic_tag VALUES (?, ?)").run(tag, topic.id);
      }
      if (routing) refreshRouting(topics);
    })();
  }
  async function list() { return exclusive(async () => { const topics = await all(); index(topics); return topics; }); }
  async function saveRun(run: Run) { await writeAtomic(join(privateDir, `${run.id}.md`), encode(run)); }
  async function loadRun(owner: string, id: string): Promise<Run> {
    uuid(id);
    let run: Run;
    try { run = await read(join(privateDir, `${id}.md`)) as Run; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new TopicError("Exécution introuvable.", 404); throw error; }
    if (run.owner !== owner) throw new TopicError("Exécution introuvable.", 404);
    return run;
  }
  async function event(run: Run, step: number, status: Run["steps"][number]["status"], result?: unknown, error?: string) {
    const at = Date.now();
    const current = run.steps[step];
    current.status = status;
    if (status === "running") { current.startedAt = at; delete current.finishedAt; delete current.error; }
    if (status === "completed" || status === "failed") current.finishedAt = at;
    if (result !== undefined) current.result = result;
    if (error) current.error = error;
    run.events.push({ id: run.events.length + 1, at, step, status, ...(result === undefined ? {} : { result }), ...(error ? { error } : {}) });
    await saveRun(run);
  }
  async function step(run: Run, n: number, operation: () => Promise<unknown>) {
    await event(run, n, "running");
    try { beforeStep?.(n); await event(run, n, "completed", await operation()); }
    catch (error) {
      run.state = "failed";
      await event(run, n, "failed", undefined, error instanceof TopicError ? error.message : "Opération interrompue. Réessayez ; les écritures confirmées sont conservées.");
      throw error;
    }
  }
  function newRun(owner: string, intent: string, id: string = randomUUID()): Run {
    return { id, owner, intent, state: "running", draft: { tag: "topic", name: "Topic", description: "", scope: intent, parentId: null, relatedIds: [] }, matches: [], topicId: randomUUID(), steps: STEP_NAMES.map(name => ({ name, status: "pending" })), events: [], confirmed: false };
  }
  async function propose(owner: string, intent: string, deferAnalysis = false) {
    intent = intentSchema.parse(intent);
    return exclusive(async () => {
      const topics = await all();
      const run = newRun(owner, intent);
      await saveRun(run);
      if (!deferAnalysis) await analyzeRun(run, topics);
      return run;
    });
  }
  async function analyzeRun(run: Run, topics: Topic[]) {
    run.state = "running";
    const intent = run.intent;
    try {
        await step(run, 0, async () => {
          const proposal = await analyzer.analyze(intent, topics);
          // A manually corrected parent remains the explicit choice of this linked workflow.
          if (run.parentRunId && proposal.missingParents?.length) {
            const parentRun = await loadRun(run.owner, run.parentRunId).catch(error => { if (error instanceof TopicError && error.status === 404) return null; throw error; });
            const parent = parentRun?.state === "completed" ? topics.find(t => t.id === parentRun.topicId) : undefined;
            if (parent) { proposal.draft.parentId = parent.id; proposal.draft.tag = `${parent.tag}.${proposal.draft.tag.split(".").at(-1)}`; proposal.missingParents = []; }
          }
          run.draft = draftSchema.parse(proposal.draft); run.matches = proposal.matches;
          run.subject = proposal.subject; run.missingParents = proposal.missingParents ?? []; run.existingTopicId = proposal.existingTopicId;
          return { method: "Analyse déterministe, sans modèle IA.", subject: run.subject ?? run.draft.name };
        });
        await step(run, 1, async () => run.matches);
        await step(run, 2, async () => ({ parentId: run.draft.parentId, missingParents: run.missingParents }));
        await step(run, 3, async () => run.draft.tag);
        await step(run, 4, async () => run.draft.scope);
        await step(run, 5, async () => run.draft.relatedIds);
        run.state = "waiting";
        await event(run, 6, "waiting", "Validez le contenu public et chaque relation avant création.");
      } catch { /* Failed steps are durable and visible to their owner. */ }
    return run;
  }
  async function proposeParent(owner: string, id: string) {
    return exclusive(async () => {
      const run = await loadRun(owner, id);
      if (run.confirmed || run.state === "cancelled") throw new TopicError("Cette proposition ne peut plus recevoir de parent.", 409);
      await analyzeRun(run, await all());
      const parent = run.missingParents?.at(-1);
      if (run.state !== "waiting" || !parent) return run;
      // Persist the link first: a crash before allocation resumes with the same run UUID.
      run.parentRunId ??= randomUUID();
      await event(run, 2, "waiting", { parentRunId: run.parentRunId, proposedParent: parent, reason: `Le tag ${run.draft.tag} nécessite un parent direct confirmé.` });
      try { return await loadRun(owner, run.parentRunId); }
      catch (error) { if (!(error instanceof TopicError) || error.status !== 404) throw error; }
      const parentRun = newRun(owner, parent.tag, run.parentRunId);
      parentRun.returnRunId = run.id;
      await saveRun(parentRun);
      return analyzeRun(parentRun, await all());
    });
  }
  async function execute(run: Run) {
    run.state = "running";
    await saveRun(run);
    try {
      await step(run, 7, async () => {
        const topics = await all();
        const existing = topics.find(t => t.id === run.topicId);
        if (existing) return existing.id;
        const collision = topics.find(t => t.tag === run.draft.tag || t.aliases.includes(run.draft.tag));
        if (collision) { run.existingTopicId = collision.id; throw new TopicError("Tag déjà réservé : ouvrez le topic existant pour le réutiliser.", 409); }
        const at = new Date().toISOString();
        const topic: Topic = { ...run.draft, id: run.topicId, aliases: [], createdBy: run.owner, updatedBy: run.owner, createdAt: at, updatedAt: at, revision: randomUUID() };
        validateTopics([...topics, topic]);
        await writeAtomic(join(directory, `${topic.id}.md`), encode(topic));
        return topic.id;
      });
      await step(run, 8, async () => { index(await all(), false); return "Index reconstruit depuis Markdown."; });
      await step(run, 9, async () => {
        refreshRouting(await all());
        const children = db.prepare("SELECT child_id FROM topic_routing WHERE parent_id = ?").all(run.draft.parentId) as { child_id: string }[];
        if (run.draft.parentId && !children.some(c => c.child_id === run.topicId)) throw new TopicError("Routage parent incomplet.");
        return { parentId: run.draft.parentId, children: children.map(c => c.child_id), scopeParent: "conservé" };
      });
      await step(run, 10, async () => {
        const topics = await all();
        const saved = topics.find(t => t.id === run.topicId);
        const row = db.prepare("SELECT data FROM topic_index WHERE id = ?").get(run.topicId) as { data: string } | undefined;
        if (!saved || !row || JSON.stringify(saved) !== row.data) throw new TopicError("Index et Markdown incohérents.");
        return { topicId: saved.id, tag: saved.tag };
      });
      run.state = "completed";
      await saveRun(run);
    } catch {
      // A final journal failure must never return a falsely completed run.
      run.state = "failed";
      await saveRun(run);
    }
    return run;
  }
  async function confirm(owner: string, id: string, input: unknown, relationsConfirmed: boolean) {
    const draft = draftSchema.parse(input);
    if (!relationsConfirmed) throw new TopicError("La validation explicite des relations est requise.");
    return exclusive(async () => {
      const run = await loadRun(owner, id);
      if (run.state === "cancelled") throw new TopicError("Proposition annulée.", 409);
      if (run.confirmed) {
        if (JSON.stringify(draft) !== JSON.stringify(run.draft)) throw new TopicError("Cette confirmation possède déjà un contenu différent.", 409);
        return run.state === "completed" ? run : execute(run);
      }
      if (run.state !== "waiting") throw new TopicError("Analyse incomplète : relancez une proposition.", 409);
      if (run.missingParents?.length) throw new TopicError("Confirmez d’abord le parent proposé, puis reprenez ce topic.", 409);
      run.draft = draft; run.confirmed = true; run.state = "running";
      await event(run, 6, "completed", { draft, relationsValidatedBy: owner });
      return execute(run);
    });
  }
  async function resume(owner: string, id: string) {
    return exclusive(async () => {
      const run = await loadRun(owner, id);
      if (run.state === "cancelled") throw new TopicError("Proposition annulée.", 409);
      if (!run.confirmed) return analyzeRun(run, await all());
      if (run.state === "completed") return run;
      run.state = "running"; await saveRun(run);
      return execute(run);
    });
  }
  async function cancel(owner: string, id: string) {
    return exclusive(async () => {
      const run = await loadRun(owner, id);
      if (run.confirmed) throw new TopicError("Création déjà confirmée.", 409);
      run.state = "cancelled"; await saveRun(run); return run;
    });
  }
  async function update(owner: string, id: string, revision: string, input: unknown, relationsConfirmed: boolean) {
    uuid(id);
    const draft = draftSchema.parse(input);
    if (!relationsConfirmed) throw new TopicError("Validez explicitement les relations.");
    return exclusive(async () => {
      const topics = await all();
      const topic = topics.find(t => t.id === id);
      if (!topic) throw new TopicError("Topic introuvable.", 404);
      if (topic.createdBy !== owner) throw new TopicError("Seul le créateur peut modifier ce topic.", 403);
      if (topic.revision !== revision) throw new TopicError("Topic modifié depuis votre lecture. Rechargez la fiche.", 409);
      const old = topic.tag;
      const at = new Date().toISOString();
      Object.assign(topic, draft, { updatedAt: at, updatedBy: owner, revision: randomUUID() });
      if (old !== topic.tag) {
        for (const t of topics) {
          if (t.id !== id && !t.tag.startsWith(`${old}.`)) continue;
          const previous = t.id === id ? old : t.tag;
          if (t.id !== id) t.tag = draft.tag + t.tag.slice(old.length);
          t.aliases = [...new Set([...t.aliases, previous])].filter(alias => alias !== t.tag);
          t.updatedAt = at; t.updatedBy = owner; t.revision = randomUUID();
        }
      }
      validateTopics(topics);
      // Durable roll-forward journal makes a subtree rename recoverable across process failure.
      await writeAtomic(journal, encode(topics));
      await recover(); index(await all()); return topic;
    });
  }
  /**
   * Direct creation with a preallocated UUID, for a confirmed ΞAgent deployment: same validation,
   * Markdown, index and routing as a confirmed run. Idempotent: a retry finds the topic already
   * written by this owner. A tag reserved by another topic is refused with its id.
   */
  async function create(owner: string, id: string, input: unknown) {
    uuid(id);
    const draft = draftSchema.parse(input);
    return exclusive(async () => {
      const topics = await all();
      const existing = topics.find(t => t.id === id);
      if (existing) {
        if (existing.createdBy !== owner) throw new TopicError("Identifiant de topic déjà réservé.", 409);
        return { topic: existing, created: false };
      }
      const collision = topics.find(t => t.tag === draft.tag || t.aliases.includes(draft.tag));
      if (collision) throw new TopicError(`Tag déjà réservé par le topic « ${collision.name} » (${collision.id}) : sélectionnez-le plutôt que de le recréer.`, 409);
      const at = new Date().toISOString();
      const topic: Topic = { ...draft, id, aliases: [], createdBy: owner, updatedBy: owner, createdAt: at, updatedAt: at, revision: randomUUID() };
      validateTopics([...topics, topic]);
      await writeAtomic(join(directory, `${topic.id}.md`), encode(topic));
      const saved = await all();
      index(saved, false);
      refreshRouting(saved);
      return { topic, created: true };
    });
  }
  return { list, reindex: list, propose, proposeParent, confirm, resume, cancel, update, create,
    getRun: async (owner: string, id: string) => { await prepare(); return loadRun(owner, id); },
    route: async (intent: string, correction?: { primaryId: string; secondaryIds: string[] }) => {
      return routeRequest(intentSchema.parse(intent), await list(), correction);
    },
  };
}
export type TopicStore = ReturnType<typeof createTopicStore>;
