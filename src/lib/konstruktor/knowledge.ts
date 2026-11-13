import type Database from "better-sqlite3";
import { z } from "zod";
import { normalizeTag } from "../search/query";
import { conceptKey } from "../search/text";
import { askJson, InferenceConfigError, InferenceOutputError } from "../watch/inference";
import type { SystemTask } from "../system-agents/tasks";
import { assess, explicitConcepts, topicKeys, typeCue } from "../topics/discovery";
import { KNOWLEDGE_SYSTEM, knowledgeAnswerSchema, screenKnowledge } from "./extraction";
import type { PublicationStore } from "../publications/store";
import type { TopicStore } from "../topics/store";

/** Private provenance index; concepts and relations themselves remain in the existing topic stores. */
export function migrateAgentKnowledge(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS xi_agent_knowledge (owner TEXT NOT NULL, agent TEXT NOT NULL, publication TEXT NOT NULL, revision TEXT NOT NULL, topic TEXT NOT NULL, excerpt TEXT NOT NULL, PRIMARY KEY (owner, agent, publication, topic));
    CREATE INDEX IF NOT EXISTS xi_agent_knowledge_owner ON xi_agent_knowledge(owner, agent, publication)`);
}
const schema = z.object({ publication: z.uuid(), agent: z.uuid(), revision: z.string().min(1).max(200) }).strict();
export const KNOWLEDGE_TASK: SystemTask<z.infer<typeof schema>> = {
  input: schema, internal: true,
  async run({ owner, input, services, llm, log }) {
    if (!services.publications || !services.relations) throw new Error("Services de connaissances indisponibles.");
    const agent = (await services.accounts.watchAgents()).find(item => item.id === input.agent && item.owner === owner);
    if (!agent) throw new Error("ΞAgent indisponible.");
    log("info", `Analyse de la publication ${input.publication} (révision ${input.revision}).`);
    const publication = await services.publications.get({ id: owner }, input.publication);
    if (publication.status !== "published" || publication.authorId !== agent.id || publication.contentRevision !== input.revision) {
      log("warn", "Publication modifiée ou retirée depuis la planification : ignorée.");
      return { outcome: "obsolete" };
    }
    // A one-message publication repeats its summary: the model reads each passage once.
    const text = [...new Set([publication.summary, ...publication.messages.filter(item => !item.deleted).map(item => item.body)].map(item => item.trim()).filter(Boolean))].join("\n").slice(0, 8000);
    const binding = services.agentLLM ? services.agentLLM(agent) : llm(); if (!binding.ok) throw new Error(binding.message);
    log("info", `Extraction par le modèle local ${binding.resolved.model}.`);
    const answer = await askJson(binding.inference, { model: binding.resolved.model, system: KNOWLEDGE_SYSTEM, prompt: `Texte :\n${text}`, stage: "concepts" }, knowledgeAnswerSchema, 1)
      .catch((error: unknown) => {
        // Decoding is deterministic (fixed seed): the same text and budget would be cut at the same place again.
        // Permanent, so the worker does not spend two more identical attempts; « Relancer les échecs » stays available.
        if (error instanceof InferenceOutputError && error.code === "truncated") throw new InferenceConfigError(`${error.message} Réessayer à l’identique échouerait de la même façon : augmenter la limite de génération (maxTokens) de l’ΞAgent, puis relancer les échecs.`, "truncated");
        throw error;
      });
    log("info", `Concepts proposés : ${answer.concepts.length} ; relations proposées : ${answer.relations.length}.`);
    // Deterministic screening: names and linking words must be in the text, fragments and attributions are dropped.
    const screened = screenKnowledge(text, answer, typeCue);
    for (const item of screened.rejected) log("info", `« ${item.item} » ignoré : ${item.reason}.`);
    const catalog = await services.topics.visible(owner);
    const keys = topicKeys([...catalog.personal, ...catalog.shared]);
    const resolved = new Map<string, { id: string; label: string; quote: string }>();
    // Recheck access and revision after inference, before persisting anything derived from it.
    const current = await services.publications.get({ id: owner }, input.publication);
    if (current.status !== "published" || current.contentRevision !== input.revision) {
      log("warn", "Publication modifiée pendant l’analyse : rien n’est enregistré.");
      return { outcome: "obsolete" };
    }
    let created = 0, reused = 0, proposed = 0, kept = 0;
    const ignored = screened.rejected.length;
    for (const item of screened.concepts) {
      const key = conceptKey(item.name), tag = normalizeTag(item.name);
      if (!key || !tag || resolved.has(key)) continue;
      const known = keys.get(key)?.topic;
      const topic = known ?? (await services.topics.openPersonal(owner, tag, item.name)).topic;
      if (known) reused++; else created++;
      log("info", `Concept « ${item.name} » : topic #${topic.tag} ${known ? "réutilisé" : "personnel créé ou retrouvé"}.`);
      resolved.set(key, { id: topic.id, label: item.name, quote: item.quote });
    }
    for (const item of screened.relations) {
      const a = resolved.get(conceptKey(item.from)), b = resolved.get(conceptKey(item.to));
      const label = `${item.from} → ${item.to} (${item.type})`;
      if (!a || !b || a.id === b.id) { log("info", `Relation ${label} ignorée : extrémité non retenue.`); continue; }
      if (item.note) log("info", `Relation ${label} : ${item.note}.`);
      const score = assess({ quote: item.quote, fromSource: false, sourceCount: publication.sources.filter(source => source.url).length, keys: [[item.from], [item.to]], type: item.type, modelConfidence: item.confidence });
      // The model's proposal remains unverified and requires a substantive citation and human review.
      if (score.assessment.evidence < 1 || score.assessment.type < 0.7) { log("info", `Relation ${label} ignorée : preuve insuffisante.`); continue; }
      // Grounded justification: the linking words the text uses, never a free paraphrase by the model.
      const justification = knowledgeJustification(item.from, item.to, item.link);
      const relation = await services.relations.proposePersonal(owner, { source: a.id, target: b.id, type: item.type, origin: "inference", createdBy: `local-model:${binding.resolved.model}`.slice(0, 64), confidence: score.confidence, assessment: score.assessment, justification, evidence: [{ kind: "publication", ref: `publication:${publication.id}`, publication: publication.id, excerpt: item.quote.slice(0, 600), label: item.link.slice(0, 200), subject: a.id }], acceptable: false });
      if (relation.status === "excluded" || relation.type !== item.type) { kept++; log("info", `Relation ${label} non reproposée : exclue ou corrigée par une décision humaine.`); }
      else { proposed++; log("info", `Relation ${label} ${relation.status === "accepted" ? "déjà acceptée : preuve conservée" : "proposée, à examiner"}.`); }
    }
    migrateAgentKnowledge(services.db);
    services.db.transaction(() => {
      services.db.prepare("DELETE FROM xi_agent_knowledge WHERE owner = ? AND agent = ? AND publication = ?").run(owner, agent.id, publication.id);
      const insert = services.db.prepare("INSERT OR IGNORE INTO xi_agent_knowledge VALUES (?, ?, ?, ?, ?, ?)");
      for (const item of resolved.values()) insert.run(owner, agent.id, publication.id, publication.contentRevision, item.id, item.quote);
    })();
    log("info", `Terminé : ${resolved.size} concepts (${reused} réutilisés, ${created} créés, ${ignored} ignorés), ${proposed} relations proposées, ${kept} décisions conservées.`);
    return { outcome: "done", concepts: resolved.size, reused, created, ignored, relations: proposed, kept };
  },
};

/** Konstruktor's justification of a relation: the linking words of the evidence it was proposed with. */
export const knowledgeJustification = (from: string, to: string, link: string) => `La publication relie « ${from} » à « ${to} » par « ${link} ».`;
/** The reverse, for evidence recorded before linking words were stored with it. */
export function justificationLink(text: string) {
  const match = /^La publication relie « ([^«»]+) » à « ([^«»]+) » par « ([^«»]+) »\.$/.exec(text);
  return match ? { from: match[1], to: match[2], link: match[3] } : null;
}

export const MEMORY_LIMIT = 20;
export type Memory = { publication: string; excerpt: string };
/**
 * Excerpts of the agent's knowledge whose concepts the conversation names (tags, aliases, names: no embeddings).
 * Access is decided by the store query before any prompt exists; the caller decides who may recall at all.
 */
export async function recallAgentKnowledge(stores: { publications: Pick<PublicationStore, "agentMemory">; topics: Pick<TopicStore, "visible"> }, owner: string, agent: string, audience: "private" | "public", conversation: string): Promise<Memory[]> {
  const rows = await stores.publications.agentMemory(owner, agent, audience);
  if (!rows.length) return [];
  const learned = new Set(rows.map(row => row.topic));
  const catalog = await stores.topics.visible(owner);
  const candidates = [...catalog.personal, ...catalog.shared].filter(topic => learned.has(topic.id));
  const named = new Set(explicitConcepts([{ text: conversation, from: "conversation", source: false }], candidates).map(concept => concept.topicId));
  const recalled = new Map<string, Memory>();
  for (const row of rows) {
    if (recalled.size === MEMORY_LIMIT) break;
    if (named.has(row.topic)) recalled.set(`${row.publication}\n${row.excerpt}`, { publication: row.publication, excerpt: row.excerpt });
  }
  return [...recalled.values()];
}
