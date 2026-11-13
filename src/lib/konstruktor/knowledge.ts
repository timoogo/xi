import type Database from "better-sqlite3";
import { z } from "zod";
import { normalizeTag } from "../search/query";
import { conceptKey } from "../search/text";
import { askJson } from "../watch/inference";
import type { SystemTask } from "../system-agents/tasks";
import { assess, DISCOVERY_SYSTEM, explicitConcepts, modelSchema, topicKeys } from "../topics/discovery";
import type { PublicationStore } from "../publications/store";
import type { TopicStore } from "../topics/store";

/** Private provenance index; concepts and relations themselves remain in the existing topic stores. */
export function migrateAgentKnowledge(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS xi_agent_knowledge (owner TEXT NOT NULL, agent TEXT NOT NULL, publication TEXT NOT NULL, revision TEXT NOT NULL, topic TEXT NOT NULL, excerpt TEXT NOT NULL, PRIMARY KEY (owner, agent, publication, topic));
    CREATE INDEX IF NOT EXISTS xi_agent_knowledge_owner ON xi_agent_knowledge(owner, agent, publication)`);
}
const schema = z.object({ publication: z.uuid(), agent: z.uuid(), revision: z.string().min(1).max(200) }).strict();
// Verb stems with Unicode boundaries: `\b` is ASCII-only and would miss « capturé », « observé » or « lié ».
const relationCue = /(?<!\p{L})(?:appartien|fait partie|compos|compren|contien|li[eé](?:e|s|es|nt)?(?!\p{L})|utilis|produi|captur|observ|influen|caus|oppos|similaire|concern)/iu;
export const KNOWLEDGE_TASK: SystemTask<z.infer<typeof schema>> = {
  input: schema, internal: true,
  async run({ owner, input, services, llm, log }) {
    if (!services.publications || !services.relations) throw new Error("Services de connaissances indisponibles.");
    const agent = (await services.accounts.watchAgents()).find(item => item.id === input.agent && item.owner === owner);
    if (!agent) throw new Error("ΞAgent indisponible.");
    log("info", `Analyse de la publication ${input.publication} (révision ${input.revision}).`);
    const publication = await services.publications.get({ id: owner }, input.publication);
    if (publication.status !== "published" || publication.authorId !== agent.id || publication.revision !== input.revision) {
      log("warn", "Publication modifiée ou retirée depuis la planification : ignorée.");
      return { outcome: "obsolete" };
    }
    const text = [publication.summary, ...publication.messages.filter(item => !item.deleted).map(item => item.body)].join("\n").slice(0, 8000);
    const binding = services.agentLLM ? services.agentLLM(agent) : llm(); if (!binding.ok) throw new Error(binding.message);
    log("info", `Extraction par le modèle local ${binding.resolved.model}.`);
    const answer = await askJson(binding.inference, { model: binding.resolved.model, system: DISCOVERY_SYSTEM, prompt: `Texte :\n${text}` }, modelSchema, 1);
    log("info", `Concepts proposés : ${answer.concepts.length} ; relations proposées : ${answer.relations.length}.`);
    const catalog = await services.topics.visible(owner);
    const keys = topicKeys([...catalog.personal, ...catalog.shared]);
    const resolved = new Map<string, { id: string; label: string; quote: string }>();
    // Recheck access and revision after inference, before persisting anything derived from it.
    const current = await services.publications.get({ id: owner }, input.publication);
    if (current.status !== "published" || current.revision !== input.revision) {
      log("warn", "Publication modifiée pendant l’analyse : rien n’est enregistré.");
      return { outcome: "obsolete" };
    }
    let created = 0, reused = 0, ignored = 0, proposed = 0, kept = 0;
    for (const item of answer.concepts) {
      const key = conceptKey(item.label), tag = normalizeTag(item.label);
      if (resolved.has(key)) continue;
      if (!key || !tag || !text.includes(item.quote) || !item.quote.toLocaleLowerCase().includes(item.label.toLocaleLowerCase())) { ignored++; log("warn", `Concept « ${item.label} » ignoré : citation absente du texte.`); continue; }
      const known = keys.get(key)?.topic;
      const topic = known ?? (await services.topics.openPersonal(owner, tag)).topic;
      if (known) reused++; else created++;
      log("info", `Concept « ${item.label} » : topic #${topic.tag} ${known ? "réutilisé" : "personnel créé ou retrouvé"}.`);
      resolved.set(key, { id: topic.id, label: item.label, quote: item.quote });
    }
    for (const item of answer.relations) {
      const a = resolved.get(conceptKey(item.from)), b = resolved.get(conceptKey(item.to));
      const label = `${item.from} → ${item.to} (${item.type})`;
      if (!a || !b || a.id === b.id || !text.includes(item.quote) || !item.quote.toLocaleLowerCase().includes(item.from.toLocaleLowerCase()) || !item.quote.toLocaleLowerCase().includes(item.to.toLocaleLowerCase()) || !relationCue.test(item.quote)) { log("info", `Relation ${label} ignorée : pas d’affirmation explicite dans une citation.`); continue; }
      const score = assess({ quote: item.quote, fromSource: false, sourceCount: publication.sources.filter(source => source.url).length, keys: [[item.from], [item.to]], type: item.type, modelConfidence: item.confidence });
      // The model's proposal remains unverified and requires a substantive citation and human review.
      if (score.assessment.evidence < 1 || score.assessment.type < 0.7 || item.justification.length < 20) { log("info", `Relation ${label} ignorée : preuve insuffisante.`); continue; }
      const relation = await services.relations.proposePersonal(owner, { source: a.id, target: b.id, type: item.type, origin: "inference", createdBy: `local-model:${binding.resolved.model}`.slice(0, 64), confidence: score.confidence, assessment: score.assessment, justification: item.justification, evidence: [{ kind: "publication", ref: `publication:${publication.id}`, publication: publication.id, excerpt: item.quote }], acceptable: false });
      if (relation.status === "excluded" || relation.type !== item.type) { kept++; log("info", `Relation ${label} non reproposée : exclue ou corrigée par une décision humaine.`); }
      else { proposed++; log("info", `Relation ${label} ${relation.status === "accepted" ? "déjà acceptée : preuve conservée" : "proposée, à examiner"}.`); }
    }
    migrateAgentKnowledge(services.db);
    services.db.transaction(() => {
      services.db.prepare("DELETE FROM xi_agent_knowledge WHERE owner = ? AND agent = ? AND publication = ?").run(owner, agent.id, publication.id);
      const insert = services.db.prepare("INSERT OR IGNORE INTO xi_agent_knowledge VALUES (?, ?, ?, ?, ?, ?)");
      for (const item of resolved.values()) insert.run(owner, agent.id, publication.id, publication.revision, item.id, item.quote);
    })();
    log("info", `Terminé : ${resolved.size} concepts (${reused} réutilisés, ${created} créés, ${ignored} ignorés), ${proposed} relations proposées, ${kept} décisions conservées.`);
    return { outcome: "done", concepts: resolved.size, reused, created, ignored, relations: proposed, kept };
  },
};

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
