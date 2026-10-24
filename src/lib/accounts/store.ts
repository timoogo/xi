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
import { ACCOUNT_STEPS, BUILTIN_PRESETS, DEFAULT_WATCH_POLICY, accountDraftSchema, editorialSchema, presetSchema, settingsSchema, storedWatchPolicySchema, watchPolicySchema, type Account, type AccountDraft, type AccountRun, type Preset, type WatchAgent, type WatchSettings } from "./types";

const encode = (data: unknown) => `---\n${stringify(data)}---\n`;
function decode(text: string) { const match = /^---\n([\s\S]*?)\n---\n/.exec(text); if (!match) throw new TopicError("Markdown invalide."); return parse(match[1]); }
type Entry = { account: Account; parsed: ParsedGenerator; path: string };

export function createAccountStore({ vault, db, topics, beforeStep }: { vault: Vault; db: Database.Database; topics: TopicStore; beforeStep?: (step: number) => void }) {
  const directory = join(vault.root, "generators");
  const privateDir = join(vault.root, ".xi-account-runs");
  const presetsPath = join(privateDir, "presets.md");
  const journal = join(privateDir, "pending.md");
  db.exec("CREATE TABLE IF NOT EXISTS editorial_account_index (id TEXT PRIMARY KEY, handle TEXT NOT NULL UNIQUE, data TEXT NOT NULL)");
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
    }] : []));
  }
  return { list, getOwned, update, propose, confirm, savePreset, setWatchPolicy, watchAgents, setAvatar,
    avatar: (owner: string, id: string) => exclusive(async () => bloubOf(await owned(owner, id))),
    watchPolicy: (owner: string, id: string) => exclusive(async () => watchOf(await owned(owner, id))),
    listPresets: (owner: string) => exclusive(async () => (await presets()).filter(p => !p.owner || p.owner === owner)),
    getRun: async (owner: string, id: string) => { await prepare(); return loadRun(owner, id); },
    resume: (owner: string, id: string) => exclusive(async () => { const run = await loadRun(owner, id); return run.state === "completed" || run.state === "waiting" ? run : execute(run); }),
  };
}
export type AccountStore = ReturnType<typeof createAccountStore>;
