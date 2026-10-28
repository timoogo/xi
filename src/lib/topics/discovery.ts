import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import type { PublicationStore } from "../publications/store";
import type { PublicationSnapshot } from "../publications/types";
import { assertWithin, PUBLICATION_ID, USER_ID, writeAtomic, type Vault } from "../publications/vault";
import { conceptKey, searchTerms } from "../search/text";
import { askJson } from "../watch/inference";
import type { Job, JobQueue } from "../watch/jobs";
import type { LLMBinding } from "../watch/llm-binding";
import type { HandlerResult } from "../watch/worker";
import { TOPIC_RELATION_TYPES, type Assessment, type TopicRelationStore, type TopicRelationType } from "./relations";
import type { TopicStore } from "./store";
import { TopicError, type Topic } from "./types";

// Topic discovery (docs/topic-discovery.md): concepts found in public publications and the sources they cite are
// resolved against the shared catalogue, recorded durably in topic-discovery/<publicationId>.md, projected as
// inferred publication ↔ topic associations, and turned into relation proposals through relations.propose().
// Local inference only; without a model, explicit terms are still recognized and nothing semantic is produced.

export const DISCOVERY_JOB = "enrich-publication";
/** Pipeline identifier recorded with every result. */
export const DISCOVERY_PIPELINE = "xi-discovery-v1";
/** A concept becomes a topic candidate once seen in this many public publications by this many authors. */
export const CANDIDATE_PUBLICATIONS = 3;
export const CANDIDATE_AUTHORS = 2;
const MAX_TEXT = 8_000;
const MAX_CONCEPTS = 40;

const iso = z.iso.datetime();
const conceptSchema = z.object({
  key: z.string().min(1).max(200), label: z.string().min(1).max(200),
  topicId: z.uuid().nullable(),
  /** explicit: a tag, alias or name of the topic is written in the text; inferred: the model named it. */
  match: z.enum(["explicit", "inferred"]).nullable(),
  via: z.enum(["hashtag", "tag", "alias", "name", "model"]),
  excerpt: z.string().min(1).max(600), from: z.string().min(1).max(300),
}).strict();
const outcomeSchema = z.object({
  source: z.uuid(), target: z.uuid(), type: z.enum(TOPIC_RELATION_TYPES),
  outcome: z.enum(["accepted", "proposed", "existing", "refused"]), relationId: z.uuid().optional(), reason: z.string().max(300).optional(),
}).strict();
export const discoveryRecordSchema = z.object({
  publication: z.string().regex(PUBLICATION_ID), revision: z.string().max(200), author: z.string().regex(USER_ID),
  analyzedAt: iso, pipeline: z.string().max(60), mode: z.enum(["model", "deterministic"]), model: z.string().max(200).nullable(),
  /** Deterministic pass only, because the model was unavailable: the inference pass remains to be done. */
  pendingInference: z.boolean(),
  concepts: z.array(conceptSchema).max(MAX_CONCEPTS * 2),
  relations: z.array(outcomeSchema).max(50),
}).strict();
export type DiscoveryRecord = z.infer<typeof discoveryRecordSchema>;
export type Concept = z.infer<typeof conceptSchema>;

/** Text of a publication by origin, so evidence says whether it comes from the author or from a cited source. */
type Segment = { text: string; from: string; source: boolean };
function segments(publication: PublicationSnapshot): Segment[] {
  const own = [publication.summary, ...publication.messages.filter(m => !m.deleted).map(m => m.body.split("## Sources")[0])].filter(Boolean);
  return [
    ...own.map(text => ({ text, from: `publication:${publication.id}`, source: false })),
    ...publication.sources.flatMap(s => [s.title, ...(s.excerpts ?? []), ...(s.claims ?? [])].filter(Boolean).map(text => ({ text, from: s.url ?? `publication:${publication.id}`, source: true }))),
  ];
}
const sentences = (text: string) => text.split(/(?<=[.!?…])\s+|\n+/).map(s => s.replace(/[*_>`]/g, "").trim()).filter(Boolean);
const terms = (text: string) => searchTerms(text).join(" ");
/** Whole-term containment on normalized terms: accents, case, plurals and punctuation do not matter. */
const contains = (text: string, phrase: string) => { const wanted = terms(phrase); return wanted !== "" && ` ${terms(text)} `.includes(` ${wanted} `); };

/**
 * Every way a shared topic may be written, by concept key (spelling variants and articles folded), with the
 * written form searched in texts. Personal topics are never part of it.
 */
export function topicKeys(topics: Topic[]) {
  const keys = new Map<string, { topic: Topic; via: "tag" | "alias" | "name"; written: string }>();
  const add = (written: string, topic: Topic, via: "tag" | "alias" | "name") => {
    const key = conceptKey(written);
    if (key.length >= 3 && !keys.has(key)) keys.set(key, { topic, via, written });
  };
  for (const topic of topics) add(topic.tag.replace(/[._-]/g, " "), topic, "tag");
  for (const topic of topics) for (const alias of topic.aliases) add(alias.replace(/[._-]/g, " "), topic, "alias");
  for (const topic of topics) add(topic.name, topic, "name");
  return keys;
}

/** Deterministic pass: hashtags, tags, aliases and names written in the text. Never semantic, never invented. */
export function explicitConcepts(parts: Segment[], topics: Topic[]): Concept[] {
  const keys = topicKeys(topics);
  const byTag = new Map(topics.flatMap(t => [[t.tag, t] as const, ...t.aliases.map(a => [a, t] as const)]));
  const found = new Map<string, Concept>();
  for (const part of parts) for (const sentence of sentences(part.text)) {
    for (const [, tag] of sentence.matchAll(/#([\p{L}\p{N}][\p{L}\p{N}._-]*)/gu)) {
      const topic = byTag.get(tag.toLowerCase());
      if (topic && !found.has(topic.id)) found.set(topic.id, { key: conceptKey(topic.name), label: topic.name, topicId: topic.id, match: "explicit", via: "hashtag", excerpt: sentence.slice(0, 600), from: part.from });
    }
    for (const [key, { topic, via, written }] of keys) {
      if (!found.has(topic.id) && contains(sentence, written)) found.set(topic.id, { key, label: topic.name, topicId: topic.id, match: "explicit", via, excerpt: sentence.slice(0, 600), from: part.from });
    }
  }
  return [...found.values()];
}

const modelSchema = z.object({
  concepts: z.array(z.object({ label: z.string().trim().min(2).max(120), quote: z.string().trim().min(3).max(600) })).max(MAX_CONCEPTS),
  relations: z.array(z.object({
    from: z.string().trim().min(2).max(120), to: z.string().trim().min(2).max(120), type: z.enum(TOPIC_RELATION_TYPES),
    justification: z.string().trim().min(1).max(1000), quote: z.string().trim().min(3).max(600), confidence: z.number().min(0).max(1),
  })).max(20),
});
type ModelAnswer = z.infer<typeof modelSchema>;
const SYSTEM = `Tu identifies les concepts d’un texte d’actualité et les relations que le texte établit explicitement entre eux.
Réponds uniquement en JSON : {"concepts":[{"label":"…","quote":"…"}],"relations":[{"from":"…","to":"…","type":"related_to|similar_to|part_of|influences|opposes","justification":"…","quote":"…","confidence":0.0}]}.
- label : le concept tel qu’il est nommé (groupe nominal court) ; quote : une phrase recopiée mot pour mot du texte.
- Une relation n’existe que si une phrase du texte l’affirme ; deux concepts cités ensemble ne sont pas liés pour autant.
- justification : pourquoi cette phrase établit cette relation ; confidence : ta certitude que le texte l’affirme.
- N’invente rien : aucune relation plutôt qu’une relation douteuse.`;

/** Words that make a relation type plausible in the quoted sentence (type coherence). related_to needs none. */
const TYPE_CUES: Record<TopicRelationType, RegExp | null> = {
  related_to: null,
  similar_to: /\b(comme|similaire|semblable|proche|analogue|equivalent|pareil)/,
  part_of: /\b(fait partie|partie de|composante|parmi|inclu|compren|compos|secteur|branche|sous)/,
  influences: /\b(entrain|provoqu|caus|influenc|impact|condui|redui|augment|favoris|affect|pes|fait (monter|baisser)|effet|consequence|depend)/,
  opposes: /\b(oppos|contre|contrair|conflit|rival|antagon|incompatible|concurren)/,
};
const fold = (text: string) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const round = (value: number) => Math.round(value * 100) / 100;

/**
 * Confidence of an inferred relation, from four separately assessed components; the overall value is their
 * minimum, so one weak component is never compensated by the others. A score, not a guarantee of truth.
 * - sources: what backs the content (cited sources with a URL, and whether the quote comes from one of them);
 * - evidence: whether the verified quote names both topics, one, or neither;
 * - inference: the model's own certainty, capped at 0.9 (self-reported);
 * - type: whether the quote contains wording consistent with the relation type.
 */
export function assess({ quote, fromSource, sourceCount, keys, type, modelConfidence }: {
  quote: string; fromSource: boolean; sourceCount: number; keys: [string[], string[]]; type: TopicRelationType; modelConfidence: number;
}): { assessment: Assessment; confidence: number } {
  const sources = Math.min(0.9, (sourceCount >= 2 ? 0.8 : sourceCount === 1 ? 0.6 : 0.4) + (fromSource ? 0.1 : 0));
  const named = keys.filter(list => list.some(written => contains(quote, written))).length;
  const evidence = named === 2 ? 1 : named === 1 ? 0.6 : 0.3;
  const inference = Math.min(0.9, modelConfidence);
  const cue = TYPE_CUES[type];
  const typeScore = cue === null ? 0.7 : cue.test(fold(quote)) ? 1 : 0.3;
  const assessment = { sources: round(sources), evidence, inference: round(inference), type: typeScore };
  return { assessment, confidence: round(Math.min(sources, evidence, inference, typeScore)) };
}

/** Durable discovery records and what pages read from them; no model involved. */
export function createDiscoveryRecords({ vault, topics, publications }: { vault: Vault; topics: TopicStore; publications: PublicationStore }) {
  const dir = join(vault.root, "topic-discovery");
  const path = (id: string) => join(dir, `${id}.md`);

  async function read(id: string): Promise<DiscoveryRecord | null> {
    if (!PUBLICATION_ID.test(id)) return null;
    try {
      const match = /^---\n([\s\S]*?)\n---\n/.exec(await readFile(path(id), "utf8"));
      const parsed = discoveryRecordSchema.safeParse(match ? parse(match[1]) : null);
      return parsed.success && parsed.data.publication === id ? parsed.data : null;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  async function all(): Promise<DiscoveryRecord[]> {
    let names: string[];
    try { names = await readdir(dir); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const records = await Promise.all(names.filter(n => n.endsWith(".md")).map(n => read(n.slice(0, -3))));
    return records.filter((r): r is DiscoveryRecord => !!r);
  }
  async function write(record: DiscoveryRecord) {
    await mkdir(dir, { recursive: true });
    await assertWithin(vault.root, dir);
    await writeAtomic(path(record.publication), `---\n${stringify(discoveryRecordSchema.parse(record))}---\n`);
  }

  /** Inferred associations of a record: one per topic, explicit before inferred. */
  const associations = (record: DiscoveryRecord) => {
    const byTopic = new Map<string, Concept>();
    for (const c of record.concepts) if (c.topicId && (!byTopic.has(c.topicId) || (c.match === "explicit" && byTopic.get(c.topicId)!.match !== "explicit"))) byTopic.set(c.topicId, c);
    return [...byTopic.values()];
  };
  /** SQLite projection of one record, if it still describes the current public content; else nothing. */
  async function projectOne(record: DiscoveryRecord | null, publicationId: string, current: { revision: string } | undefined, known: Set<string>) {
    const valid = record && current && record.revision === current.revision;
    publications.setInferredTopics(publicationId, valid ? associations(record).filter(c => known.has(c.topicId!)).map(c => ({ topic_id: c.topicId!, score: c.match === "explicit" ? 1 : 0.6 })) : []);
  }
  /**
   * The record of a publication that is no longer public (private, unpublished, trashed, deleted) is removed with its
   * excerpts and its projection: nothing derived from it remains readable. Relations keep their own history; their
   * evidence is filtered by permissions when shown (relations.ts). Republished, the publication is analysed again.
   */
  async function forget(publicationId: string) {
    publications.setInferredTopics(publicationId, []);
    await rm(path(publicationId), { force: true });
  }
  /** Rebuilds every inferred association from the Markdown records (after an index rebuild, or each pass). */
  async function project() {
    const known = new Set((await topics.list()).map(t => t.id));
    const current = new Map((await publications.publicPublications()).map(p => [p.id, p]));
    for (const record of await all()) {
      if (!current.has(record.publication)) await forget(record.publication);
      else await projectOne(record, record.publication, current.get(record.publication), known);
    }
  }

  /** Publications associated by inference with a topic, with their evidence, for public publications only. */
  async function associationsOf(topicId: string) {
    const current = new Map((await publications.publicPublications()).map(p => [p.id, p]));
    return (await all()).filter(r => current.get(r.publication)?.revision === r.revision)
      .flatMap(r => associations(r).filter(c => c.topicId === topicId).map(c => ({ publicationId: r.publication, concept: c, mode: r.mode, model: r.model, analyzedAt: r.analyzedAt })))
      .sort((x, y) => y.analyzedAt.localeCompare(x.analyzedAt));
  }

  /**
   * Concepts without a shared topic, grouped by normalized key (spelling variants merge), re-resolved against the
   * current catalogue. Recurrent and documented ones are candidates for creation; nothing is created here.
   */
  async function candidates() {
    const keys = topicKeys(await topics.list());
    const current = new Map((await publications.publicPublications()).map(p => [p.id, p]));
    const groups = new Map<string, { key: string; labels: Set<string>; evidence: { publicationId: string; author: string; excerpt: string; from: string }[] }>();
    for (const record of await all()) {
      if (current.get(record.publication)?.revision !== record.revision) continue;
      for (const concept of record.concepts) {
        if (concept.topicId || keys.has(concept.key)) continue;
        const group = groups.get(concept.key) ?? { key: concept.key, labels: new Set(), evidence: [] };
        group.labels.add(concept.label);
        if (!group.evidence.some(e => e.publicationId === record.publication)) group.evidence.push({ publicationId: record.publication, author: record.author, excerpt: concept.excerpt, from: concept.from });
        groups.set(concept.key, group);
      }
    }
    return [...groups.values()].map(g => {
      const authors = new Set(g.evidence.map(e => e.author)).size;
      return { key: g.key, labels: [...g.labels].sort(), publications: g.evidence.length, authors, evidence: g.evidence.slice(0, 10),
        status: g.evidence.length >= CANDIDATE_PUBLICATIONS && authors >= CANDIDATE_AUTHORS ? "candidate" as const : "observed" as const };
    }).sort((x, y) => (x.status === y.status ? 0 : x.status === "candidate" ? -1 : 1) || y.publications - x.publications || x.key.localeCompare(y.key));
  }

  return { read, all, write, forget, associations, project, projectOne, associationsOf, candidates };
}
export type DiscoveryRecords = ReturnType<typeof createDiscoveryRecords>;

export function createTopicDiscovery({ vault, topics, relations, publications, llm, ownerOf, autoAccept = false, now = () => new Date() }: {
  vault: Vault; topics: TopicStore; relations: TopicRelationStore; publications: PublicationStore;
  /** The local model of a user (their global configuration); never a cloud provider (llm/server.ts). */
  llm: (owner: string) => LLMBinding;
  /** Whose model analyses a publication: its human author, or the owner of the ΞAgent that wrote it. */
  ownerOf: (publication: { authorId: string; authorType: string }) => Promise<string | null>;
  /**
   * Operator switch (XI_TOPIC_AUTOACCEPT): off, every inferred relation stays proposed whatever its score,
   * because the scores are not calibrated on labelled data yet. On, lot 4's threshold applies.
   */
  autoAccept?: boolean; now?: () => Date;
}) {
  const records = createDiscoveryRecords({ vault, topics, publications });
  const { read, write, forget, project, projectOne } = records;

  /**
   * Plans one job per public publication whose content has no record yet (or changed), and an inference pass for
   * records made without a model once the owner's model is available. Idempotent: keys carry the revision.
   */
  async function plan(queue: JobQueue, at?: number) {
    await project();
    let planned = 0;
    for (const publication of await publications.publicPublications()) {
      const record = await read(publication.id);
      let key: string | null = null;
      if (!record || record.revision !== publication.revision) key = `enrich:${publication.id}:${publication.revision}`;
      else if (record.pendingInference) {
        const owner = await ownerOf(publication);
        if (owner && llm(owner).ok) key = `enrich:${publication.id}:${publication.revision}:model`;
      }
      if (key && queue.enqueue({ kind: DISCOVERY_JOB, key, payload: { publicationId: publication.id, revision: publication.revision }, runAfter: at, maxAttempts: 3 }).created) planned++;
    }
    return planned;
  }

  async function handler(job: Job): Promise<HandlerResult> {
    const { publicationId } = z.object({ publicationId: z.string().regex(PUBLICATION_ID) }).parse(job.payload);
    const publication = await publications.publicContent(publicationId);
    // No longer public: its inferred associations disappear with it, nothing else is read.
    if (!publication) {
      await forget(publicationId);
      return { status: "done", result: { outcome: "not-public" } };
    }
    const previous = await read(publicationId);
    if (previous && previous.revision === publication.revision && previous.mode === "model") return { status: "done", result: { outcome: "already" } };
    const catalogue = await topics.list();
    const parts = segments(publication);
    const explicit = explicitConcepts(parts, catalogue);
    const author = publication.authorId;
    const owner = await ownerOf(publication);
    const binding = owner ? llm(owner) : null;
    const base: DiscoveryRecord = {
      publication: publicationId, revision: publication.revision, author, analyzedAt: now().toISOString(), pipeline: DISCOVERY_PIPELINE,
      mode: "deterministic", model: null, pendingInference: true, concepts: explicit, relations: [],
    };
    const known = new Set(catalogue.map(t => t.id));
    const current = { revision: publication.revision };
    if (!binding?.ok) {
      // No model: explicit terms only, no relation, no justification, no confidence. The inference pass is planned
      // again as soon as the owner's local model is available.
      await write(base);
      await projectOne(base, publicationId, current, known);
      return { status: "done", result: { outcome: "deterministic", concepts: explicit.length, reason: binding ? binding.message : "Aucun propriétaire identifiable." } };
    }

    const text = parts.map(p => p.text).join("\n").slice(0, MAX_TEXT);
    let answer: ModelAnswer;
    try {
      answer = await askJson(binding.inference, { model: binding.resolved.model, system: SYSTEM, prompt: `Texte :\n${text}` }, modelSchema);
    } catch (error) {
      // The explicit matches are kept meanwhile; the job waits for the model (or retries), never a cloud fallback.
      await write(base);
      await projectOne(base, publicationId, current, known);
      throw error;
    }

    // Model concepts count only with a quote found in the text; resolved against the catalogue by normalized key.
    const keys = topicKeys(catalogue);
    // A quote also found in a cited source is attributed to that source (it then backs the claim).
    const quoted = (quote: string) => parts.find(p => p.source && contains(p.text, quote)) ?? parts.find(p => contains(p.text, quote));
    const concepts = [...explicit];
    const resolve = (label: string) => keys.get(conceptKey(label))?.topic ?? null;
    for (const item of answer.concepts) {
      const part = quoted(item.quote);
      const key = conceptKey(item.label);
      if (!part || !key || !contains(item.quote, item.label) || concepts.some(c => c.key === key || (c.topicId && c.topicId === resolve(item.label)?.id))) continue;
      const topic = resolve(item.label);
      concepts.push({ key, label: item.label, topicId: topic?.id ?? null, match: topic ? "inferred" : null, via: "model", excerpt: item.quote, from: part.from });
    }

    // Relations: two distinct shared topics, a quote found in the text, then lot 4's propose() decides.
    const sourceCount = new Set(publication.sources.map(s => s.url).filter(Boolean)).size;
    const outcomes: DiscoveryRecord["relations"] = [];
    const termsOf = (topic: Topic) => [...keys.values()].filter(v => v.topic.id === topic.id).map(v => v.written);
    for (const item of answer.relations) {
      const a = resolve(item.from), b = resolve(item.to);
      const part = quoted(item.quote);
      if (!a || !b || a.id === b.id || !part) continue;
      const { assessment, confidence } = assess({ quote: item.quote, fromSource: part.source, sourceCount, keys: [termsOf(a), termsOf(b)], type: item.type, modelConfidence: item.confidence });
      const evidence = [
        { kind: part.source ? "source" as const : "publication" as const, ref: part.from, excerpt: item.quote, publication: publicationId },
        { kind: "cooccurrence" as const, ref: `publication:${publicationId}` },
      ];
      try {
        const relation = await relations.propose({
          source: a.id, target: b.id, type: item.type, origin: "inference", createdBy: `local-model:${binding.resolved.model}`.slice(0, 64),
            confidence, assessment, justification: item.justification, evidence, acceptable: autoAccept,
        });
        // Ours (now or in an interrupted earlier attempt of this job) when it carries this quote; else a prior relation.
        const created = relation.evidence.some(e => e.ref === part.from && e.excerpt === item.quote);
        outcomes.push({ source: a.id, target: b.id, type: item.type, outcome: created ? relation.status === "accepted" ? "accepted" : "proposed" : "existing", relationId: relation.id });
      } catch (error) {
        if (!(error instanceof TopicError)) throw error;
        outcomes.push({ source: a.id, target: b.id, type: item.type, outcome: "refused", reason: error.message.slice(0, 300) });
      }
    }
    const record: DiscoveryRecord = { ...base, mode: "model", model: binding.resolved.model, pendingInference: false, concepts, relations: outcomes };
    await write(record);
    await projectOne(record, publicationId, current, known);
    return { status: "done", result: { outcome: "model", concepts: concepts.length, relations: outcomes.length } };
  }

  return { ...records, plan, handler };
}
export type TopicDiscovery = ReturnType<typeof createTopicDiscovery>;
