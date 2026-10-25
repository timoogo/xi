import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { Document, parse, stringify } from "yaml";
import { z } from "zod";
import { parseGenerator, serializeGenerator, type ParsedGenerator } from "../graph/format";
import { assertWithin, inside, listDir, writeAtomic, type Vault } from "../publications/vault";
import { locked } from "../topics/lock";
import { TopicError } from "../topics/types";
import type { TopicStore } from "../topics/store";
import { bloubConfigSchema } from "../bloub/config";
import { readAgentBloub, type AgentBloubSettings } from "../xiagents/avatar";
import { agentPins, migrateAgentPins, setAgentPin } from "../xiagents/pins";
import { agentLLMConfigSchema, INHERIT_LLM, storedAgentLLMSchema, type AgentLLMSettings } from "../llm/types";
import { pauseSchema, readSchedule, scheduleSchema, type Pause, type ResolvedSchedule } from "../xiagents/schedule";
import { ACCOUNT_STEPS, BUILTIN_PRESETS, DEFAULT_WATCH_POLICY, accountDraftSchema, editorialSchema, presetSchema, profileSchema, settingsSchema, storedWatchPolicySchema, watchPolicySchema, type Account, type AccountDraft, type AccountRun, type Preset, type Profile, type WatchAgent, type WatchSettings } from "./types";

const encode = (data: unknown) => `---\n${stringify(data)}---\n`;
function decode(text: string) { const match = /^---\n([\s\S]*?)\n---\n/.exec(text); if (!match) throw new TopicError("Markdown invalide."); return parse(match[1]); }
type Entry = { account: Account; parsed: ParsedGenerator; path: string };

export function createAccountStore({ vault, db, topics, beforeStep }: { vault: Vault; db: Database.Database; topics: TopicStore; beforeStep?: (step: number) => void }) {
  const directory = join(vault.root, "generators");
  const privateDir = join(vault.root, ".xi-account-runs");
  const presetsPath = join(privateDir, "presets.md");
  const journal = join(privateDir, "pending.md");
  db.exec("CREATE TABLE IF NOT EXISTS editorial_account_index (id TEXT PRIMARY KEY, handle TEXT NOT NULL UNIQUE, data TEXT NOT NULL)");
  migrateAgentPins(db);
  async function safe(path: string) { if (await assertWithin(vault.root, path) !== path) throw new TopicError("Lien symbolique interdit."); }
  async function read(path: string) { await safe(path); return readFile(path, "utf8"); }
  async function prepare() {
    for (const dir of [directory, privateDir]) { await mkdir(dir, { recursive: true, mode: 0o700 }); await safe(dir); }
  }
  async function writeGenerator(handle: string, content: string) {
    const dir = inside(directory, accountDraftSchema.shape.handle.parse(handle));
    await mkdir(dir, { recursive: true, mode: 0o700 }); await safe(dir);
    await writeAtomic(join(dir, "index.md"), content);
  }
  async function recover() {
    let pending: { oldHandle: string; handle: string; content: string };
    try { pending = z.object({ oldHandle: accountDraftSchema.shape.handle, handle: accountDraftSchema.shape.handle, content: z.string() }).parse(decode(await read(journal))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    await writeGenerator(pending.handle, pending.content);
    if (pending.oldHandle !== pending.handle) { const old = inside(directory, pending.oldHandle); await safe(old); await rm(join(old, "index.md"), { force: true }); }
    await rm(journal);
  }
  async function exclusive<T>(task: () => Promise<T>) { await prepare(); return locked(directory, async () => { await recover(); return task(); }); }
  async function all(): Promise<Entry[]> {
    const entries: Entry[] = [];
    for (const dir of await listDir(directory)) {
      if (dir.name.startsWith(".")) continue;
      if (dir.isSymbolicLink()) throw new TopicError("Lien symbolique de générateur interdit.");
      if (!dir.isDirectory()) continue;
      const path = inside(directory, dir.name, "index.md");
      let content: string;
      try { content = await read(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      const parsed = parseGenerator(content);
      if (!parsed || parsed.generator.slug !== dir.name) throw new TopicError("Générateur invalide : " + dir.name);
      const g = parsed.generator;
      const editorial = parsed.doc.has("editorial") ? editorialSchema.parse(parsed.doc.toJS().editorial) : null;
      if (entries.some(e => e.account.id === g.id || e.account.handle === g.slug)) throw new TopicError("Identifiant ou handle dupliqué.", 409);
      entries.push({ path, parsed, account: { id: g.id, handle: g.slug, name: g.title, description: parsed.description, owner: g.ownerId, createdAt: g.createdAt, editorial } });
    }
    return entries;
  }
  function index(entries: Entry[]) {
    db.transaction(() => {
      db.exec("DELETE FROM editorial_account_index");
      const insert = db.prepare("INSERT INTO editorial_account_index VALUES (?, ?, ?)");
      for (const { account } of entries) insert.run(account.id, account.handle, JSON.stringify(account));
    })();
  }
  async function presets(): Promise<Preset[]> {
    let custom: Preset[] = [];
    try { custom = z.array(presetSchema).parse(decode(await read(presetsPath))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return [...BUILTIN_PRESETS, ...custom];
  }
  async function validate(draft: AccountDraft, owner: string) {
    const catalog = await topics.list();
    const ids = [draft.primaryTopicId, ...draft.secondaryTopicIds];
    if (new Set(ids).size !== ids.length || ids.some(id => !catalog.some(t => t.id === id))) throw new TopicError("Topics absents ou dupliqués.");
    const preset = (await presets()).find(p => p.id === draft.presetId && p.version === draft.presetVersion && (!p.owner || p.owner === owner));
    if (!preset) throw new TopicError("Version de preset introuvable.");
  }
  async function list(owner: string) { return exclusive(async () => { const entries = await all(); index(entries); return entries.filter(e => e.parsed.generator.visibility === "public" || e.account.owner === owner).map(e => e.account); }); }
  async function getOwned(owner: string, id: string) {
    if (!z.uuid().safeParse(id).success) throw new TopicError("ΞAgent introuvable.", 404);
    const account = (await list(owner)).find(account => account.id === id && account.owner === owner);
    if (!account) throw new TopicError("ΞAgent introuvable.", 404);
    return account;
  }
  async function savePreset(owner: string, input: unknown) {
    const data = z.object({ id: z.string().max(100).optional(), expectedVersion: z.number().int().nonnegative(), name: z.string().trim().min(1).max(160), settings: settingsSchema }).strict().parse(input);
    return exclusive(async () => {
      const catalog = await presets();
      const previous = catalog.filter(p => p.id === data.id).sort((a,b) => b.version-a.version)[0];
      if (data.id && (!previous || previous.owner !== owner)) throw new TopicError("Preset non modifiable.", 403);
      if ((previous?.version ?? 0) !== data.expectedVersion) throw new TopicError("Version de preset périmée. Rechargez.", 409);
      const preset: Preset = { id: previous?.id ?? randomUUID(), version: data.expectedVersion + 1, name: data.name, settings: data.settings, owner, createdAt: new Date().toISOString() };
      await writeAtomic(presetsPath, encode([...catalog.filter(p => p.owner !== null), preset]));
      return preset;
    });
  }
  async function save(owner: string, id: string, draft: AccountDraft, existing?: Entry) {
    await validate(draft, owner);
    const entries = await all();
    if (entries.some(e => e.account.handle === draft.handle && e.account.id !== id)) throw new TopicError("Handle déjà réservé.", 409);
    // Even an empty directory may belong to another legacy generator; never overwrite its files.
    if (draft.handle !== existing?.account.handle && (await listDir(directory)).some(e => e.name === draft.handle)) throw new TopicError("Dossier du handle déjà réservé.", 409);
    const now = new Date().toISOString();
    const { handle, name, description, ...config } = draft;
    const doc = existing?.parsed.doc ?? new Document({});
    doc.set("editorial", { ...config, updatedAt: now, updatedBy: owner, revision: randomUUID() });
    const content = serializeGenerator({ id, slug: handle, title: name, ownerId: owner, visibility: existing?.parsed.generator.visibility ?? "public", createdAt: existing?.account.createdAt ?? now }, description, doc);
    await writeAtomic(journal, encode({ oldHandle: existing?.account.handle ?? handle, handle, content }));
    await recover();
  }
  async function update(owner: string, id: string, revision: string | null, input: unknown) {
    z.uuid().parse(id); const draft = accountDraftSchema.parse(input);
    return exclusive(async () => {
      const existing = (await all()).find(e => e.account.id === id);
      if (!existing) throw new TopicError("Compte introuvable.", 404);
      if (existing.account.owner !== owner) throw new TopicError("Seul le propriétaire peut modifier ce compte.", 403);
      if ((existing.account.editorial?.revision ?? null) !== revision) throw new TopicError("Compte modifié depuis votre lecture. Rechargez.", 409);
      await save(owner, id, draft, existing); const entries = await all(); index(entries); return entries.find(e => e.account.id === id)!.account;
    });
  }
  async function saveRun(run: AccountRun) { await writeAtomic(join(privateDir, `${run.id}.md`), encode(run)); }
  async function loadRun(owner: string, id: string): Promise<AccountRun> {
    z.uuid().parse(id);
    let run: AccountRun;
    try { run = decode(await read(join(privateDir, `${id}.md`))) as AccountRun; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new TopicError("Exécution introuvable.", 404); throw error; }
    if (run.owner !== owner) throw new TopicError("Exécution introuvable.", 404);
    return run;
  }
  async function event(run: AccountRun, n: number, status: AccountRun["steps"][number]["status"], result?: unknown, error?: string) {
    const at = Date.now(); run.steps[n] = { name: ACCOUNT_STEPS[n], status, ...(result === undefined ? {} : { result }), ...(error ? { error } : {}) };
    run.events.push({ id: run.events.length + 1, step: n, status, at, ...(result === undefined ? {} : { result }), ...(error ? { error } : {}) }); await saveRun(run);
  }
  async function step(run: AccountRun, n: number, operation: () => Promise<unknown>) {
    await event(run, n, "running");
    try { beforeStep?.(n); await event(run, n, "completed", await operation()); }
    catch (error) { run.state = "failed"; await event(run, n, "failed", undefined, error instanceof TopicError ? error.message : "Opération interrompue. Reprenez le parcours."); throw error; }
  }
  async function execute(run: AccountRun) {
    run.state = "running"; await saveRun(run);
    try {
      if (!run.confirmed) {
        const catalog = await topics.list();
        const topic = catalog.find(t => t.id === run.topicId);
        await step(run, 0, async () => { if (!topic) throw new TopicError("Topic introuvable."); return topic.id; });
        await step(run, 1, async () => ({ topicId: topic!.id, revision: topic!.revision, scope: topic!.scope }));
        let handle = topic!.tag;
        await step(run, 2, async () => { const entries = await all(); const dirs = await listDir(directory); let suffix = 2; while (entries.some(e => e.account.handle === handle) || dirs.some(d => d.name === handle)) handle = `${topic!.tag.slice(0, 168)}-${suffix++}`; return handle; });
        await step(run, 3, async () => { const preset = BUILTIN_PRESETS[0]; run.draft = { handle, name: topic!.name, description: topic!.description, primaryTopicId: topic!.id, secondaryTopicIds: [], presetId: preset.id, presetVersion: preset.version, settings: preset.settings, active: true, modelRef: null, validationMode: "human" }; return "Proposition déterministe, sans modèle IA."; });
        await event(run, 4, "waiting", "Choisissez un preset et ajustez ses paramètres.");
        run.state = "waiting"; await event(run, 5, "waiting", "Confirmation humaine obligatoire.");
      } else {
        await step(run, 6, async () => { const existing = (await all()).find(e => e.account.id === run.accountId); if (!existing) await save(run.owner, run.accountId, run.draft!); else if (existing.account.owner !== run.owner) throw new TopicError("Identifiant déjà réservé.", 409); return run.accountId; });
        await step(run, 7, async () => { index(await all()); return "Index reconstruit depuis Markdown."; });
        await step(run, 8, async () => { const saved = (await all()).find(e => e.account.id === run.accountId)?.account; const row = db.prepare("SELECT data FROM editorial_account_index WHERE id = ?").get(run.accountId) as { data: string } | undefined; if (!saved || row?.data !== JSON.stringify(saved)) throw new TopicError("Index incohérent."); await validate(run.draft!, run.owner); return saved.id; });
        run.state = "completed"; await saveRun(run);
      }
    } catch { run.state = "failed"; await saveRun(run); }
    return run;
  }
  async function propose(owner: string, topicId: string) {
    z.uuid().parse(topicId);
    return exclusive(async () => {
      const run: AccountRun = { id: randomUUID(), owner, topicId, accountId: randomUUID(), state: "running", confirmed: false, draft: null, steps: ACCOUNT_STEPS.map(name => ({ name, status: "pending" })), events: [] };
      await saveRun(run); return run;
    });
  }
  async function confirm(owner: string, id: string, input: unknown, confirmed: boolean) {
    if (!confirmed) throw new TopicError("Confirmation humaine explicite requise.");
    const draft = accountDraftSchema.parse(input);
    return exclusive(async () => {
      const run = await loadRun(owner, id);
      if (run.confirmed) { if (JSON.stringify(draft) !== JSON.stringify(run.draft)) throw new TopicError("Confirmation différente de celle déjà enregistrée.", 409); return run.state === "completed" ? run : execute(run); }
      if (run.state !== "waiting") throw new TopicError("Proposition incomplète : reprenez le parcours.", 409);
      await validate(draft, owner);
      run.draft = draft; run.confirmed = true;
      await event(run, 4, "completed", { presetId: draft.presetId, version: draft.presetVersion });
      await event(run, 5, "completed", { confirmedBy: owner }); return execute(run);
    });
  }
  function watchOf(entry: Entry): WatchSettings {
    const raw = (entry.parsed.doc.toJS() as Record<string, unknown>).watch;
    if (raw === undefined) return { policy: DEFAULT_WATCH_POLICY, revision: null, valid: true, publicConfirmedAt: null };
    const parsed = storedWatchPolicySchema.safeParse(raw);
    if (!parsed.success) return { policy: DEFAULT_WATCH_POLICY, revision: null, valid: false, publicConfirmedAt: null };
    // A public visibility without its recorded confirmation is never honoured.
    const policy = watchPolicySchema.strip().parse(parsed.data);
    return { policy, revision: parsed.data.revision, valid: true, publicConfirmedAt: policy.visibility === "public" ? parsed.data.publicConfirmedAt : null };
  }
  async function owned(owner: string, id: string) {
    if (!z.uuid().safeParse(id).success) throw new TopicError("ΞAgent introuvable.", 404);
    const entry = (await all()).find(e => e.account.id === id && e.account.owner === owner);
    if (!entry) throw new TopicError("ΞAgent introuvable.", 404);
    return entry;
  }
  async function setWatchPolicy(owner: string, id: string, input: unknown): Promise<WatchSettings> {
    const data = z.object({ revision: z.uuid().nullable(), policy: watchPolicySchema, confirmPublic: z.literal(true).optional() }).strict().parse(input);
    if (data.policy.nightThreshold >= data.policy.alertThreshold) throw new TopicError("Le seuil d’alerte doit dépasser le seuil de la fenêtre nocturne.");
    return exclusive(async () => {
      const entry = await owned(owner, id);
      const current = watchOf(entry);
      if (current.revision !== data.revision) throw new TopicError("La veille a été modifiée depuis votre lecture. Rechargez.", 409);
      // Switching to public needs its own explicit confirmation, recorded here (never supplied by the client).
      const at = new Date().toISOString();
      const kept = current.publicConfirmedAt ? { at: current.publicConfirmedAt, by: (entry.parsed.doc.toJS() as { watch?: { publicConfirmedBy?: string } }).watch?.publicConfirmedBy ?? owner } : null;
      let confirmation: { at: string; by: string } | null = null;
      if (data.policy.visibility === "public") {
        confirmation = kept ?? (data.confirmPublic ? { at, by: owner } : null);
        if (!confirmation) throw new TopicError("Confirmez explicitement la publication publique automatique.");
      }
      const revision = randomUUID();
      entry.parsed.doc.set("watch", { ...data.policy, revision, updatedAt: at, updatedBy: owner, publicConfirmedAt: confirmation?.at ?? null, publicConfirmedBy: confirmation?.by ?? null });
      await writeAtomic(entry.path, serializeGenerator(entry.parsed.generator, entry.parsed.description, entry.parsed.doc));
      return { policy: data.policy, revision, valid: true, publicConfirmedAt: confirmation?.at ?? null };
    });
  }
  const bloubOf = (entry: Entry) => readAgentBloub((entry.parsed.doc.toJS() as Record<string, unknown>).bloub);
  /** Owner-only avatar appearance, optimistic on `revision` (null until first saved). */
  async function setAvatar(owner: string, id: string, input: unknown): Promise<AgentBloubSettings> {
    const data = z.object({ revision: z.uuid().nullable(), config: bloubConfigSchema }).strict().parse(input);
    return exclusive(async () => {
      const entry = await owned(owner, id);
      if (bloubOf(entry).revision !== data.revision) throw new TopicError("L’avatar a été modifié depuis votre lecture. Rechargez.", 409);
      const revision = randomUUID();
      entry.parsed.doc.set("bloub", { config: data.config, revision, updatedAt: new Date().toISOString(), updatedBy: owner });
      await writeAtomic(entry.path, serializeGenerator(entry.parsed.generator, entry.parsed.description, entry.parsed.doc));
      return { config: data.config, revision };
    });
  }
  /** Worker only: every configured agent, whatever its visibility. Never exposed through an API. */
  async function watchAgents(): Promise<WatchAgent[]> {
    return exclusive(async () => (await all()).flatMap(entry => entry.account.editorial ? [{
      id: entry.account.id, handle: entry.account.handle, owner: entry.account.owner, active: entry.account.editorial.active,
      primaryTopicId: entry.account.editorial.primaryTopicId, secondaryTopicIds: entry.account.editorial.secondaryTopicIds, modelRef: entry.account.editorial.modelRef, watch: watchOf(entry),
      schedule: scheduleOf(entry), pause: pauseOf(entry), profile: profileOf(entry), createdAt: entry.account.createdAt, llm: llmOf(entry),
    }] : []));
  }

  const raw = (entry: Entry) => entry.parsed.doc.toJS() as Record<string, unknown>;
  const persist = (entry: Entry) => writeAtomic(entry.path, serializeGenerator(entry.parsed.generator, entry.parsed.description, entry.parsed.doc));
  const scheduleOf = (entry: Entry): ResolvedSchedule => readSchedule(raw(entry).schedule);
  /** Pause details only matter while the watch is paused (older writers toggle `watch.paused` alone). */
  function pauseOf(entry: Entry): Pause | null {
    if (!watchOf(entry).policy.paused) return null;
    const parsed = pauseSchema.safeParse(raw(entry).pause);
    return parsed.success ? parsed.data : null;
  }
  function profileOf(entry: Entry): Profile | null {
    const parsed = profileSchema.strip().safeParse(raw(entry).profile);
    return parsed.success ? parsed.data : null;
  }
  /**
   * LLM selection: top-level `llm` key. Without it, a legacy `editorial.modelRef` acts as a model
   * override on the global instance; an unreadable key is reported (`valid: false`), never guessed.
   */
  function llmOf(entry: Entry): AgentLLMSettings {
    const stored = raw(entry).llm;
    if (stored === undefined) {
      const modelRef = entry.account.editorial?.modelRef ?? null;
      return { config: { ...INHERIT_LLM, model: modelRef }, revision: null, valid: true, legacy: modelRef !== null };
    }
    const parsed = storedAgentLLMSchema.safeParse(stored);
    if (!parsed.success) return { config: INHERIT_LLM, revision: null, valid: false, legacy: false };
    const { instanceId, model, options, revision } = parsed.data;
    return { config: { instanceId, model, options }, revision, valid: true, legacy: false };
  }
  const writeLLM = (entry: Entry, owner: string, config: AgentLLMSettings["config"]) =>
    entry.parsed.doc.set("llm", { ...agentLLMConfigSchema.parse(config), revision: randomUUID(), updatedAt: new Date().toISOString(), updatedBy: owner });
  /** Writes the watch key with a new revision, keeping the public confirmation as recorded. */
  function setWatch(entry: Entry, owner: string, patch: Partial<WatchSettings["policy"]>) {
    const current = watchOf(entry);
    if (!current.valid) throw new TopicError("Configuration de veille illisible : réenregistrez-la depuis la page du ΞAgent.", 409);
    const stored = (raw(entry).watch ?? {}) as { publicConfirmedBy?: string | null };
    const revision = randomUUID();
    entry.parsed.doc.set("watch", { ...current.policy, ...patch, revision, updatedAt: new Date().toISOString(), updatedBy: owner, publicConfirmedAt: current.publicConfirmedAt, publicConfirmedBy: current.publicConfirmedAt ? stored.publicConfirmedBy ?? owner : null });
    return revision;
  }

  /**
   * Creation with a preallocated id (deployments): idempotent. A retry finds the agent and only
   * completes what an interruption left missing; another owner's id or a different handle is refused.
   */
  async function createAgent(owner: string, id: string, input: unknown) {
    z.uuid().parse(id);
    const data = z.object({ draft: accountDraftSchema, profile: profileSchema, bloub: bloubConfigSchema, llm: agentLLMConfigSchema.optional() }).strict().parse(input);
    return exclusive(async () => {
      let entry = (await all()).find(e => e.account.id === id);
      if (entry && (entry.account.owner !== owner || entry.account.handle !== data.draft.handle)) throw new TopicError("Identifiant déjà réservé.", 409);
      const created = !entry;
      if (!entry) { await save(owner, id, data.draft); entry = (await all()).find(e => e.account.id === id)!; }
      const at = new Date().toISOString();
      let changed = false;
      if (!profileOf(entry)) { entry.parsed.doc.set("profile", { ...data.profile, revision: randomUUID(), updatedAt: at, updatedBy: owner }); changed = true; }
      if (bloubOf(entry).revision === null) { entry.parsed.doc.set("bloub", { config: data.bloub, revision: randomUUID(), updatedAt: at, updatedBy: owner }); changed = true; }
      if (data.llm && raw(entry).llm === undefined) { writeLLM(entry, owner, data.llm); changed = true; }
      if (changed) await persist(entry);
      index(await all());
      return { account: entry.account, created };
    });
  }

  /** Owner-only schedule, optimistic on `revision` (null while the agent follows the legacy behaviour). */
  async function setSchedule(owner: string, id: string, input: unknown): Promise<ResolvedSchedule> {
    const data = z.object({ revision: z.uuid().nullable(), schedule: scheduleSchema }).strict().parse(input);
    return exclusive(async () => {
      const entry = await owned(owner, id);
      const current = scheduleOf(entry);
      if (current.revision !== data.revision) throw new TopicError("Les calendriers ont été modifiés depuis votre lecture. Rechargez.", 409);
      entry.parsed.doc.set("schedule", { ...data.schedule, revision: randomUUID(), updatedAt: new Date().toISOString(), updatedBy: owner });
      await persist(entry);
      return scheduleOf(entry);
    });
  }
  async function setProfile(owner: string, id: string, input: unknown): Promise<Profile> {
    const profile = profileSchema.parse(input);
    return exclusive(async () => {
      const entry = await owned(owner, id);
      entry.parsed.doc.set("profile", { ...profile, revision: randomUUID(), updatedAt: new Date().toISOString(), updatedBy: owner });
      await persist(entry);
      return profile;
    });
  }

  /** Owner-only LLM selection, optimistic on `revision` (null while the key is absent or unreadable). */
  async function setLLM(owner: string, id: string, input: unknown): Promise<AgentLLMSettings> {
    const data = z.object({ revision: z.uuid().nullable(), config: agentLLMConfigSchema }).strict().parse(input);
    return exclusive(async () => {
      const entry = await owned(owner, id);
      if (llmOf(entry).revision !== data.revision) throw new TopicError("La configuration IA a été modifiée depuis votre lecture. Rechargez.", 409);
      writeLLM(entry, owner, data.config);
      await persist(entry);
      return llmOf(entry);
    });
  }
  /**
   * Agents of `owner` explicitly bound to instance `from` move to instance `to` (null: back to the
   * global configuration). Their model choice belonged to the old instance and is dropped (the
   * target's default model applies); their options are kept. Returns the ids changed.
   */
  async function reassignLLM(owner: string, from: string, to: string | null) {
    return exclusive(async () => {
      const changed: string[] = [];
      for (const entry of await all()) {
        if (entry.account.owner !== owner) continue;
        const current = llmOf(entry);
        if (!current.valid || current.config.instanceId !== from) continue;
        writeLLM(entry, owner, { ...current.config, instanceId: to, model: null });
        await persist(entry);
        changed.push(entry.account.id);
      }
      return changed;
    });
  }

  /**
   * Pause: `watch.paused` (honoured by every task, major events included) plus its details. The
   * resume choice of a scheduled pause is recorded now. Pausing again replaces the details.
   */
  async function pauseAgent(owner: string, id: string, input: unknown, now = new Date()): Promise<Pause> {
    const data = z.object({ resumeAt: z.iso.datetime().nullable(), resumeWith: z.enum(["now", "catch-up"]) }).strict().parse(input);
    if (data.resumeAt && Date.parse(data.resumeAt) <= now.getTime()) throw new TopicError("La reprise programmée doit être dans le futur.");
    return exclusive(async () => {
      const entry = await owned(owner, id);
      const details: Pause = { since: pauseOf(entry)?.since ?? now.toISOString(), ...data };
      setWatch(entry, owner, { paused: true });
      entry.parsed.doc.set("pause", details);
      await persist(entry);
      return details;
    });
  }
  /** Ends a pause; returns its details (null when not paused) so the caller can plan a catch-up. */
  async function resumeEntry(entry: Entry, by: string) {
    if (!watchOf(entry).policy.paused) return null;
    const details = pauseOf(entry);
    setWatch(entry, by, { paused: false });
    entry.parsed.doc.delete("pause");
    await persist(entry);
    return details;
  }
  async function resumeAgent(owner: string, id: string, input: unknown) {
    const { resumeWith } = z.object({ resumeWith: z.enum(["now", "catch-up"]) }).strict().parse(input);
    return exclusive(async () => {
      const details = await resumeEntry(await owned(owner, id), owner);
      return details ? { ...details, resumeWith } : null;
    });
  }
  /** Worker: scheduled pauses whose time has come, with the choice recorded when pausing. */
  async function resumeDue(now: Date) {
    return exclusive(async () => {
      const resumed: { agentId: string; owner: string; pause: Pause }[] = [];
      for (const entry of await all()) {
        const details = pauseOf(entry);
        if (!details?.resumeAt || Date.parse(details.resumeAt) > now.getTime()) continue;
        await resumeEntry(entry, "scheduler");
        resumed.push({ agentId: entry.account.id, owner: entry.account.owner, pause: details });
      }
      return resumed;
    });
  }
  /** Handles are unique across every owner, legacy directories included; `exceptId` keeps an agent's own handle. */
  async function handleAvailable(handle: string, exceptId: string | null = null) {
    // Compare the normalised handle (trimmed, without "@"), as it would be saved.
    const parsed = accountDraftSchema.shape.handle.safeParse(handle);
    if (!parsed.success) return false;
    const wanted = parsed.data;
    return exclusive(async () => {
      const owner = (await all()).find(e => e.account.handle === wanted);
      if (owner) return owner.account.id === exceptId;
      return !(await listDir(directory)).some(e => e.name === wanted);
    });
  }
  return { list, getOwned, update, propose, confirm, savePreset, setWatchPolicy, watchAgents, setAvatar, createAgent, setSchedule, setProfile, setLLM, reassignLLM, pauseAgent, resumeAgent, resumeDue, handleAvailable,
    llm: (owner: string, id: string) => exclusive(async () => llmOf(await owned(owner, id))),
    schedule: (owner: string, id: string) => exclusive(async () => scheduleOf(await owned(owner, id))),
    profile: (owner: string, id: string) => exclusive(async () => profileOf(await owned(owner, id))),
    pauseState: (owner: string, id: string) => exclusive(async () => pauseOf(await owned(owner, id))),
    avatar: (owner: string, id: string) => exclusive(async () => bloubOf(await owned(owner, id))),
    watchPolicy: (owner: string, id: string) => exclusive(async () => watchOf(await owned(owner, id))),
    /** The owner's pins (agent id → pin time); only the owner's own agents can be pinned. */
    pins: (owner: string) => agentPins(db, owner),
    setPin: (owner: string, id: string, input: unknown) => exclusive(async () => {
      const { pinned } = z.object({ pinned: z.boolean() }).strict().parse(input);
      await owned(owner, id);
      setAgentPin(db, owner, id, pinned);
    }),
    listPresets: (owner: string) => exclusive(async () => (await presets()).filter(p => !p.owner || p.owner === owner)),
    getRun: async (owner: string, id: string) => { await prepare(); return loadRun(owner, id); },
    resume: (owner: string, id: string) => exclusive(async () => { const run = await loadRun(owner, id); return run.state === "completed" || run.state === "waiting" ? run : execute(run); }),
  };
}
export type AccountStore = ReturnType<typeof createAccountStore>;
