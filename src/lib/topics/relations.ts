import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { readablePublicationSql } from "../publications/index-db";
import { assertWithin, PUBLICATION_ID, USER_ID, writeAtomic, type Vault } from "../publications/vault";
import { locked } from "./lock";
import type { TopicStore } from "./store";
import { isPersonal, TopicError, type Topic } from "./types";

// Durable Topic ↔ Topic relations (docs/topic-relations.md). Markdown is the source of truth:
//   topic-relations/<uuid>.md                              shared relations, between shared topics only
//   .xi-personal-topics/<user>/relations/<uuid>.md          a user's own relations (any topic they can see)
//   .xi-personal-topics/<user>/relation-exclusions.md       a user's personal exclusions, kept with their history
// SQLite `topic_relation` is a disposable projection of shared relations only. Parent/child links and the
// `relatedIds` declared in topic files stay where they are and are shown as relations, never copied.
// Message ↔ message relations (src/lib/graph/relations.ts) are a separate system with their own rules.

export const TOPIC_RELATION_TYPES = ["related_to", "similar_to", "part_of", "influences", "opposes"] as const;
export type TopicRelationType = (typeof TOPIC_RELATION_TYPES)[number];
/** Symmetric types are stored with source < target, so A–B and B–A are the same relation. */
const SYMMETRIC = new Set<TopicRelationType>(["related_to", "similar_to", "opposes"]);
export const isSymmetric = (type: TopicRelationType) => SYMMETRIC.has(type);

/** Substantive evidence can establish an automatic relation; mere indices never can on their own. */
export const SUBSTANTIVE_EVIDENCE = ["publication", "source", "claim"] as const;
export const INDEX_EVIDENCE = ["cooccurrence", "shared_word", "shared_agent"] as const;
/** Automatic relations at or above this confidence (with sufficient evidence) are accepted; below, only proposed. */
export const AUTO_ACCEPT_CONFIDENCE = 0.8;
const MIN_AUTOMATIC_JUSTIFICATION = 20;

const iso = z.iso.datetime();
const actor = z.string().min(1).max(64);
const evidenceSchema = z.object({
  kind: z.enum([...SUBSTANTIVE_EVIDENCE, ...INDEX_EVIDENCE]),
  ref: z.string().trim().min(1).max(300),
  excerpt: z.string().trim().min(1).max(600).optional(),
  /** The publication this evidence was taken from: its excerpt is shown only to those who can read it now. */
  publication: z.string().regex(PUBLICATION_ID).optional(),
}).strict();
const historySchema = z.object({
  at: iso, by: actor,
  action: z.enum(["created", "type_changed", "accepted", "excluded", "restored", "reproposed"]),
  from: z.string().max(40).optional(), to: z.string().max(40).optional(), reason: z.string().max(1000).optional(),
}).strict();
const unit = z.number().min(0).max(1);
const assessmentSchema = z.object({ sources: unit, evidence: unit, inference: unit, type: unit }).strict();
export type Assessment = z.infer<typeof assessmentSchema>;
export const topicRelationSchema = z.object({
  id: z.uuid(), type: z.enum(TOPIC_RELATION_TYPES), source: z.uuid(), target: z.uuid(),
  status: z.enum(["proposed", "accepted", "excluded"]),
  origin: z.enum(["human", "agent", "inference"]),
  /** Human: user id. Agent: ΞAgent UUID. Inference: identifier of the local model/pipeline. */
  createdBy: actor,
  confidence: z.number().min(0).max(1).nullable(),
  justification: z.string().trim().min(1).max(2000),
  evidence: z.array(evidenceSchema).max(20),
  createdAt: iso, updatedAt: iso,
  history: z.array(historySchema).max(500),
  /** Automatic relations: the separately assessed components of `confidence` (topics/discovery.ts). */
  assessment: assessmentSchema.optional(),
  /** Present only on personal relations: the only user who can ever read them. */
  owner: z.string().regex(USER_ID).optional(),
}).strict().refine(r => r.source !== r.target, "Une relation relie deux topics distincts.")
  .refine(r => !SYMMETRIC.has(r.type) || r.source < r.target, "Relation symétrique non normalisée.");
export type TopicRelation = z.infer<typeof topicRelationSchema>;
export type Evidence = z.infer<typeof evidenceSchema>;

const exclusionSchema = z.object({ relation: z.string().min(1).max(120), at: iso, reason: z.string().max(1000).optional(), restoredAt: iso.optional() }).strict();
const exclusionsSchema = z.object({ exclusions: z.array(exclusionSchema).max(5000) }).strict();
type Exclusion = z.infer<typeof exclusionSchema>;

/** Read model for one topic page. `kind` separates hierarchy, legacy declarations and recorded relations. */
export type RelationView = {
  id: string;
  kind: "hierarchy" | "declared" | "recorded";
  scope: "shared" | "personal";
  type: TopicRelationType | "parent";
  /** Relative to the page's topic: outgoing (topic → other), incoming, or symmetric. */
  direction: "outgoing" | "incoming" | "symmetric";
  other: Topic;
  status: TopicRelation["status"];
  origin: TopicRelation["origin"] | "declared" | "hierarchy";
  createdBy: string | null;
  confidence: number | null;
  justification: string;
  /** Withheld evidence keeps its kind only: its publication is not (or no longer) readable by the viewer. */
  evidence: (Evidence & { withheld?: true })[];
  /** Justification and evidence withheld because they rest on publications the viewer cannot read. */
  withheld: boolean;
  history: TopicRelation["history"];
  assessment: Assessment | null;
  /** Global correction/exclusion allowed: creator of an endpoint (shared) or owner (personal). */
  canManage: boolean;
  /** Personal exclusion allowed: any visible relation except the hierarchy. */
  canHide: boolean;
};
/** One edge of the topic network: structure and provenance only, never a justification nor an excerpt. */
export type NetworkEdge = {
  id: string; kind: "hierarchy" | "declared" | "recorded"; type: TopicRelationType | "parent";
  /** Hierarchy: child → parent. Symmetric types: normalized order. */
  source: string; target: string;
  status: "accepted" | "proposed"; origin: TopicRelation["origin"] | "declared" | "hierarchy";
  scope: "shared" | "personal"; byViewer: boolean; confidence: number | null;
};
export type TopicRelations = { visible: RelationView[]; hidden: RelationView[]; excluded: RelationView[]; proposed: RelationView[] };

const encode = (value: unknown) => `---\n${stringify(value)}---\n`;
const decode = (text: string) => {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  return match ? parse(match[1]) : null;
};
const declaredId = (a: string, b: string) => `declared:${a < b ? `${a}:${b}` : `${b}:${a}`}`;
const normalize = (type: TopicRelationType, source: string, target: string) =>
  SYMMETRIC.has(type) && source > target ? { source: target, target: source } : { source, target };
const samePair = (r: TopicRelation, a: string, b: string) => (r.source === a && r.target === b) || (r.source === b && r.target === a);

const humanSchema = z.object({
  source: z.uuid(), target: z.uuid(), type: z.enum(TOPIC_RELATION_TYPES), justification: z.string().trim().min(3).max(2000),
}).strict();
const automaticSchema = z.object({
  source: z.uuid(), target: z.uuid(), type: z.enum(TOPIC_RELATION_TYPES),
  origin: z.enum(["agent", "inference"]), createdBy: actor, confidence: z.number().min(0).max(1),
  justification: z.string().trim().min(1).max(2000), evidence: z.array(evidenceSchema).min(1).max(20),
  assessment: assessmentSchema.optional(),
  /** False keeps the relation proposed whatever its confidence (uncalibrated scores). */
  acceptable: z.boolean().default(true),
}).strict();
const correctionSchema = z.object({
  type: z.enum(TOPIC_RELATION_TYPES).optional(), status: z.enum(["accepted", "excluded"]).optional(), reason: z.string().trim().max(1000).optional(),
}).strict().refine(c => c.type || c.status, "Aucune correction demandée.");

/** Why an automatic proposal is insufficient, or null when its provenance and justification can stand. */
export function automaticInsufficiency(input: Pick<z.infer<typeof automaticSchema>, "justification" | "evidence">) {
  if (input.justification.length < MIN_AUTOMATIC_JUSTIFICATION) return "Justification trop courte.";
  // Co-occurrence, a shared word or a shared ΞAgent are indices, never proof of a semantic relation.
  if (!input.evidence.some(e => (SUBSTANTIVE_EVIDENCE as readonly string[]).includes(e.kind) && e.excerpt)) return "Aucune preuve substantielle citée (publication, source ou affirmation avec extrait).";
  return null;
}

/** Publications an evidence item rests on: its own, else (older automatic evidence) every publication of the relation. */
export function relationBasis(relation: Pick<TopicRelation, "evidence" | "origin">) {
  const own = (e: Evidence) => e.publication ?? (e.ref.startsWith("publication:") && PUBLICATION_ID.test(e.ref.slice(12)) ? e.ref.slice(12) : null);
  const all = [...new Set(relation.evidence.map(own).filter((id): id is string => !!id))];
  const automatic = relation.origin !== "human";
  return { all, of: (e: Evidence) => { const id = own(e); return id ? [id] : automatic ? all : []; } };
}
export const WITHHELD_JUSTIFICATION = "Justification masquée : elle s’appuie sur une publication qui ne vous est pas, ou plus, accessible.";

export function createTopicRelationStore({ vault, db, topics, readable = async () => new Set(), now = () => new Date() }: {
  vault: Vault; db: Database.Database; topics: TopicStore;
  /** Which of these publications the viewer can read right now (publication permissions); nothing by default. */
  readable?: (viewer: string, publicationIds: string[]) => Promise<Set<string>>;
  now?: () => Date;
}) {
  const sharedDir = join(vault.root, "topic-relations");
  const personalRoot = join(vault.root, ".xi-personal-topics");
  // Disposable projection: structure only (no justification, no excerpt) and the publications each relation rests on,
  // so a graph query can filter by publication permissions. The first version also stored the whole relation.
  if (db.prepare<[], { name: string }>("SELECT name FROM pragma_table_info('topic_relation')").all().some(c => c.name === "data")) db.exec("DROP TABLE topic_relation");
  db.exec(`CREATE TABLE IF NOT EXISTS topic_relation (
    id TEXT PRIMARY KEY, type TEXT NOT NULL, source TEXT NOT NULL, target TEXT NOT NULL, status TEXT NOT NULL,
    origin TEXT NOT NULL, confidence REAL);
    CREATE INDEX IF NOT EXISTS topic_relation_source ON topic_relation (source);
    CREATE INDEX IF NOT EXISTS topic_relation_target ON topic_relation (target);
    CREATE TABLE IF NOT EXISTS topic_relation_basis (relation_id TEXT NOT NULL, publication_id TEXT NOT NULL, PRIMARY KEY (relation_id, publication_id));`);

  const userDir = (user: string) => {
    if (!USER_ID.test(user)) throw new TopicError("Utilisateur invalide.");
    return join(personalRoot, user);
  };
  async function exclusive<T>(task: () => Promise<T>) {
    await mkdir(sharedDir, { recursive: true });
    await assertWithin(vault.root, sharedDir);
    return locked(sharedDir, task);
  }
  /** Invalid files are ignored (never repaired), as for message relations; a foreign owner is ignored too. */
  async function readDir(dir: string, owner?: string): Promise<TopicRelation[]> {
    let names: string[];
    try { names = (await readdir(dir)).filter(name => /^[0-9a-f-]{36}\.md$/.test(name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const relations: TopicRelation[] = [];
    for (const name of names.sort()) {
      const path = join(dir, name);
      await assertWithin(vault.root, path);
      const parsed = topicRelationSchema.safeParse(decode(await readFile(path, "utf8")));
      if (!parsed.success || `${parsed.data.id}.md` !== name || parsed.data.owner !== owner) continue;
      if (relations.some(r => r.id === parsed.data.id)) continue;
      relations.push(parsed.data);
    }
    return relations;
  }
  const sharedRelations = () => readDir(sharedDir);
  const personalRelations = (user: string) => readDir(join(userDir(user), "relations"), user);
  async function save(relation: TopicRelation) {
    const dir = relation.owner ? join(userDir(relation.owner), "relations") : sharedDir;
    await mkdir(dir, { recursive: true, mode: relation.owner ? 0o700 : 0o755 });
    await assertWithin(vault.root, dir);
    await writeAtomic(join(dir, `${relation.id}.md`), encode(topicRelationSchema.parse(relation)));
  }
  function project(shared: TopicRelation[]) {
    db.transaction(() => {
      db.exec("DELETE FROM topic_relation; DELETE FROM topic_relation_basis");
      const insert = db.prepare("INSERT INTO topic_relation VALUES (?, ?, ?, ?, ?, ?, ?)");
      const basis = db.prepare("INSERT INTO topic_relation_basis VALUES (?, ?)");
      for (const r of shared) {
        insert.run(r.id, r.type, r.source, r.target, r.status, r.origin, r.confidence);
        for (const id of relationBasis(r).all) basis.run(r.id, id);
      }
    })();
  }
  async function exclusions(user: string): Promise<Exclusion[]> {
    try {
      const parsed = exclusionsSchema.safeParse(decode(await readFile(join(userDir(user), "relation-exclusions.md"), "utf8")));
      if (!parsed.success) throw new TopicError("Exclusions personnelles illisibles.");
      return parsed.data.exclusions;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }
  async function saveExclusions(user: string, items: Exclusion[]) {
    await mkdir(userDir(user), { recursive: true, mode: 0o700 });
    await writeAtomic(join(userDir(user), "relation-exclusions.md"), encode(exclusionsSchema.parse({ exclusions: items })));
  }

  /** Everything the viewer may see: topics, shared relations between shared topics, their own relations. */
  async function scope(viewer: string) {
    const catalogue = await topics.visible(viewer);
    const visible = new Map<string, Topic>([...catalogue.shared, ...catalogue.personal].map(t => [t.id, t]));
    const sharedIds = new Set(catalogue.shared.map(t => t.id));
    const sharedRels = await sharedRelations();
    project(sharedRels);
    const shared = sharedRels.filter(r => sharedIds.has(r.source) && sharedIds.has(r.target));
    const mine = (await personalRelations(viewer)).filter(r => visible.has(r.source) && visible.has(r.target));
    // Permissions are checked now, not at extraction: a publication made private or trashed stops backing anything.
    const readableIds = await readable(viewer, [...new Set([...shared, ...mine].flatMap(r => relationBasis(r).all))]);
    /** A relation resting only on publications the viewer cannot read would reveal their content: not exposed. */
    const exposed = (r: TopicRelation) => { const { all } = relationBasis(r); return !all.length || all.some(id => readableIds.has(id)); };
    return { visible, sharedIds, shared, mine, readableIds, exposed };
  }
  const authorizedOn = (viewer: string, relation: TopicRelation, visible: Map<string, Topic>) =>
    relation.owner ? relation.owner === viewer : [visible.get(relation.source), visible.get(relation.target)].some(t => t?.createdBy === viewer);

  async function relationsOf(viewer: string, topicId: string): Promise<TopicRelations> {
    const { visible, shared, mine, readableIds, exposed } = await scope(viewer);
    const topic = visible.get(topicId);
    if (!topic) throw new TopicError("Topic introuvable.", 404);
    const hiddenIds = new Set((await exclusions(viewer)).filter(e => !e.restoredAt).map(e => e.relation));
    const views: RelationView[] = [];
    const parent = topic.parentId ? visible.get(topic.parentId) : undefined;
    const hierarchy = (other: Topic, direction: "outgoing" | "incoming"): RelationView => ({
      id: `parent:${direction === "outgoing" ? topic.id : other.id}`, kind: "hierarchy", scope: "shared", type: "parent", direction, other,
      status: "accepted", origin: "hierarchy", createdBy: null, confidence: null, history: [], evidence: [], assessment: null, withheld: false, canManage: false, canHide: false,
      justification: direction === "outgoing" ? `${topic.name} spécialise ${other.name} (tag hiérarchique).` : `${other.name} spécialise ${topic.name} (tag hiérarchique).`,
    });
    if (parent) views.push(hierarchy(parent, "outgoing"));
    for (const child of visible.values()) if (child.parentId === topic.id) views.push(hierarchy(child, "incoming"));
    // Legacy transverse relations declared in topic files: validated by the topic's creator, read in both directions.
    const declared = new Set<string>();
    for (const t of visible.values()) for (const relatedId of t.relatedIds) {
      const otherId = t.id === topic.id ? relatedId : relatedId === topic.id ? t.id : null;
      const other = otherId ? visible.get(otherId) : undefined;
      if (!other || declared.has(declaredId(topic.id, other.id))) continue;
      declared.add(declaredId(topic.id, other.id));
      views.push({
        id: declaredId(topic.id, other.id), kind: "declared", scope: "shared", type: "related_to", direction: "symmetric", other,
        status: "accepted", origin: "declared", createdBy: t.createdBy, confidence: null, evidence: [], history: [], assessment: null, withheld: false,
        justification: `Relation transversale déclarée et validée dans la fiche de « ${t.name} » par son créateur.`,
        canManage: false, canHide: true,
      });
    }
    for (const r of [...shared, ...mine]) {
      if (r.source !== topic.id && r.target !== topic.id) continue;
      const other = visible.get(r.source === topic.id ? r.target : r.source)!;
      const manage = authorizedOn(viewer, r, visible);
      // Unvalidated and excluded relations are only shown to those who can act on them; a relation whose publications
      // all became unreadable is shown only to them too, without its content, so they can still correct or exclude it.
      if ((r.status !== "accepted" || !exposed(r)) && !manage) continue;
      const basis = relationBasis(r);
      const withheld = basis.all.some(id => !readableIds.has(id));
      views.push({
        id: r.id, kind: "recorded", scope: r.owner ? "personal" : "shared", type: r.type, other,
        direction: SYMMETRIC.has(r.type) ? "symmetric" : r.source === topic.id ? "outgoing" : "incoming",
        status: r.status, origin: r.origin, createdBy: r.createdBy, confidence: r.confidence, withheld,
        justification: withheld ? WITHHELD_JUSTIFICATION : r.justification,
        evidence: r.evidence.map(e => basis.of(e).every(id => readableIds.has(id)) ? e : { kind: e.kind, ref: "", withheld: true as const }), history: r.history, assessment: r.assessment ?? null, canManage: manage, canHide: r.status === "accepted",
      });
    }
    return {
      visible: views.filter(v => v.status === "accepted" && !hiddenIds.has(v.id)),
      hidden: views.filter(v => v.status === "accepted" && hiddenIds.has(v.id)),
      proposed: views.filter(v => v.status === "proposed"),
      excluded: views.filter(v => v.status === "excluded"),
    };
  }

  /**
   * Human relation. Between two shared topics, the creator of either endpoint records a shared relation; anyone
   * else (and any relation touching a personal topic) records it in their own private space. Idempotent.
   */
  async function create(viewer: string, input: unknown) {
    const data = humanSchema.parse(input);
    if (data.source === data.target) throw new TopicError("Une relation relie deux topics distincts.");
    return exclusive(async () => {
      const { visible, sharedIds, shared, mine } = await scope(viewer);
      const source = visible.get(data.source), target = visible.get(data.target);
      if (!source || !target) throw new TopicError("Topic introuvable.", 404);
      const isShared = sharedIds.has(source.id) && sharedIds.has(target.id) && (source.createdBy === viewer || target.createdBy === viewer);
      const ends = normalize(data.type, source.id, target.id);
      const pool = isShared ? shared : mine;
      const existing = pool.find(r => r.type === data.type && r.source === ends.source && r.target === ends.target);
      const at = now().toISOString();
      if (existing && existing.status !== "excluded") return existing;
      if (existing) {
        // Re-adding an excluded relation is an explicit human restoration, traced.
        const restored = { ...existing, status: "accepted" as const, updatedAt: at, justification: data.justification, history: [...existing.history, { at, by: viewer, action: "restored" as const, reason: data.justification }] };
        await save(restored);
        return restored;
      }
      const relation: TopicRelation = {
        id: randomUUID(), type: data.type, ...ends, status: "accepted", origin: "human", createdBy: viewer, confidence: null,
        justification: data.justification, evidence: [], createdAt: at, updatedAt: at,
        history: [{ at, by: viewer, action: "created" }], ...(isShared ? {} : { owner: viewer }),
      };
      await save(relation);
      return relation;
    });
  }

  /**
   * Automatic relation from a ΞAgent or local inference, between shared topics only. Refused without sufficient
   * provenance. Accepted only above AUTO_ACCEPT_CONFIDENCE; otherwise proposed for human validation. After an
   * exclusion on the same pair, only new substantive evidence may propose it again, and never as accepted.
   */
  async function propose(input: unknown) {
    const data = automaticSchema.parse(input);
    if (data.source === data.target) throw new TopicError("Une relation relie deux topics distincts.");
    const insufficient = automaticInsufficiency(data);
    if (insufficient) throw new TopicError(insufficient, 422);
    return exclusive(async () => {
      const catalogue = await topics.list();
      const source = catalogue.find(t => t.id === data.source), target = catalogue.find(t => t.id === data.target);
      if (!source || !target || isPersonal(source) || isPersonal(target)) throw new TopicError("Topic commun introuvable.", 404);
      const shared = await sharedRelations();
      const ends = normalize(data.type, source.id, target.id);
      const existing = shared.find(r => r.type === data.type && r.source === ends.source && r.target === ends.target && r.status !== "excluded");
      if (existing) return existing;
      // An exclusion on the pair, or a human correction away from this type, is never undone automatically.
      const excluded = shared.filter(r => samePair(r, source.id, target.id)
        && (r.status === "excluded" || r.history.some(h => h.action === "type_changed" && h.from === data.type)));
      const known = new Set(excluded.flatMap(r => r.evidence.map(e => `${e.kind}:${e.ref}`)));
      const fresh = data.evidence.filter(e => (SUBSTANTIVE_EVIDENCE as readonly string[]).includes(e.kind) && e.excerpt && !known.has(`${e.kind}:${e.ref}`));
      if (excluded.length && !fresh.length) throw new TopicError("Relation exclue ou corrigée : aucune preuve nouvelle ne justifie de la reproposer.", 409);
      const at = now().toISOString();
      const relation: TopicRelation = {
        id: randomUUID(), type: data.type, ...ends, origin: data.origin, createdBy: data.createdBy, confidence: data.confidence,
        status: !excluded.length && data.acceptable && data.confidence >= AUTO_ACCEPT_CONFIDENCE ? "accepted" : "proposed",
        justification: data.justification, evidence: data.evidence, createdAt: at, updatedAt: at, ...(data.assessment ? { assessment: data.assessment } : {}),
        history: [{ at, by: data.createdBy, action: excluded.length ? "reproposed" : "created", ...(excluded.length ? { reason: `Nouvelles preuves après l’exclusion ou la correction de ${excluded.map(r => r.id).join(", ")}.` } : {}) }],
      };
      await save(relation);
      return relation;
    });
  }

  /** Global correction (type) or decision (accept/exclude/restore), traced. Creator of an endpoint, or owner. */
  async function correct(viewer: string, id: string, input: unknown) {
    const change = correctionSchema.parse(input);
    z.uuid().parse(id);
    return exclusive(async () => {
      const { visible, shared, mine, exposed } = await scope(viewer);
      const relation = [...mine, ...shared].find(r => r.id === id);
      if (!relation || (!authorizedOn(viewer, relation, visible) && !exposed(relation))) throw new TopicError("Relation introuvable.", 404);
      if (!authorizedOn(viewer, relation, visible)) throw new TopicError("Seul le créateur d’un des deux topics peut corriger cette relation pour tous. Vous pouvez la masquer pour vous.", 403);
      const at = now().toISOString();
      const next: TopicRelation = { ...relation, history: [...relation.history], updatedAt: at };
      if (change.type && change.type !== relation.type) {
        Object.assign(next, { type: change.type }, normalize(change.type, relation.source, relation.target));
        const pool = relation.owner ? mine : shared;
        if (pool.some(r => r.id !== id && r.status !== "excluded" && r.type === next.type && r.source === next.source && r.target === next.target)) throw new TopicError("Une relation identique existe déjà.", 409);
        next.history.push({ at, by: viewer, action: "type_changed", from: relation.type, to: change.type, ...(change.reason ? { reason: change.reason } : {}) });
      }
      if (change.status && change.status !== relation.status) {
        next.status = change.status;
        next.history.push({ at, by: viewer, action: change.status === "excluded" ? "excluded" : relation.status === "excluded" ? "restored" : "accepted", ...(change.reason ? { reason: change.reason } : {}) });
      }
      if (next.history.length === relation.history.length) return relation;
      await save(next);
      return next;
    });
  }

  /** Personal exclusion: hides a visible relation for the viewer only; restoring keeps the trace. */
  async function hide(viewer: string, relationId: string, hidden: boolean, reason?: string) {
    return exclusive(async () => {
      const views = await visibleRelation(viewer, relationId);
      if (!views) throw new TopicError("Relation introuvable.", 404);
      const items = await exclusions(viewer);
      const active = items.find(e => e.relation === relationId && !e.restoredAt);
      const at = now().toISOString();
      if (hidden && !active) items.push({ relation: relationId, at, ...(reason ? { reason: reason.slice(0, 1000) } : {}) });
      else if (!hidden && active) active.restoredAt = at;
      else return;
      await saveExclusions(viewer, items);
    });
  }
  /** A relation id the viewer may see (recorded or declared), or null. */
  async function visibleRelation(viewer: string, relationId: string) {
    const { visible, shared, mine, exposed } = await scope(viewer);
    if (relationId.startsWith("declared:")) {
      const [, a, b] = relationId.split(":");
      return [...visible.values()].some(t => (t.id === a && t.relatedIds.includes(b)) || (t.id === b && t.relatedIds.includes(a))) ? relationId : null;
    }
    const relation = [...shared, ...mine].find(r => r.id === relationId);
    return relation?.status === "accepted" && exposed(relation) ? relationId : null;
  }

  /** Accepted shared relations whose publications the viewer can read (SQL on the projection), structure only. */
  const structureQuery = (viewer: string) => db.prepare<{ viewer: string }, { id: string; type: TopicRelationType; source: string; target: string; origin: TopicRelation["origin"]; confidence: number | null }>(`
      SELECT r.id, r.type, r.source, r.target, r.origin, r.confidence FROM topic_relation r WHERE r.status = 'accepted'
        AND (NOT EXISTS (SELECT 1 FROM topic_relation_basis b WHERE b.relation_id = r.id)
          OR EXISTS (SELECT 1 FROM topic_relation_basis b JOIN publication p ON p.id = b.publication_id WHERE b.relation_id = r.id AND ${readablePublicationSql("p")}))
      ORDER BY r.id`).all({ viewer });

  /**
   * Accepted shared relations the viewer may see, structure only, filtered in SQL by the permissions of the
   * publications they rest on (for the graph view). Needs the publication index in the same database.
   */
  async function readableStructure(viewer: string) {
    await scope(viewer);
    return structureQuery(viewer);
  }

  /**
   * Every relation edge of the topic network the viewer may see, without justification nor evidence: hierarchy,
   * declared relations, accepted recorded relations (shared ones through readableStructure, the viewer's own), and
   * with `proposed`, the proposals they can validate. Excluded relations and the viewer's personal exclusions never
   * appear. Edges only come from relations: a co-occurrence never makes one.
   */
  async function networkEdges(viewer: string, { proposed = false } = {}): Promise<NetworkEdge[]> {
    const { visible, shared, mine, exposed } = await scope(viewer);
    const hidden = new Set((await exclusions(viewer)).filter(e => !e.restoredAt).map(e => e.relation));
    const readableShared = new Set(structureQuery(viewer).map(r => r.id));
    const edges: NetworkEdge[] = [];
    for (const t of visible.values()) if (t.parentId && visible.has(t.parentId)) {
      edges.push({ id: `parent:${t.id}`, kind: "hierarchy", type: "parent", source: t.id, target: t.parentId, status: "accepted", origin: "hierarchy", scope: "shared", byViewer: false, confidence: null });
    }
    const declared = new Set<string>();
    for (const t of visible.values()) for (const other of t.relatedIds) {
      const id = declaredId(t.id, other);
      if (!visible.has(other) || declared.has(id) || hidden.has(id)) continue;
      declared.add(id);
      edges.push({ id, kind: "declared", type: "related_to", source: t.id < other ? t.id : other, target: t.id < other ? other : t.id, status: "accepted", origin: "declared", scope: "shared", byViewer: t.createdBy === viewer, confidence: null });
    }
    for (const r of [...shared, ...mine]) {
      if (hidden.has(r.id) || r.status === "excluded") continue;
      const accepted = r.status === "accepted" && (r.owner ? exposed(r) : readableShared.has(r.id));
      const proposal = proposed && r.status === "proposed" && authorizedOn(viewer, r, visible) && exposed(r);
      if (!accepted && !proposal) continue;
      edges.push({ id: r.id, kind: "recorded", type: r.type, source: r.source, target: r.target, status: r.status, origin: r.origin, scope: r.owner ? "personal" : "shared", byViewer: r.createdBy === viewer, confidence: r.confidence });
    }
    return edges;
  }

  return { relationsOf, create, propose, correct, hide, readableStructure, networkEdges, reindex: async () => exclusive(async () => { project(await sharedRelations()); }) };
}
export type TopicRelationStore = ReturnType<typeof createTopicRelationStore>;
