import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { normalizeTag } from "../search/query";
import { conceptKey } from "../search/text";
import { askJson } from "../watch/inference";
import type { JobQueue } from "../watch/jobs";
import { enqueueSystemTask } from "../system-agents/queue";
import { systemAgentDefinition } from "../system-agents/registry";
import type { SystemTask } from "../system-agents/tasks";
import { assess, DISCOVERY_SYSTEM, modelSchema, topicKeys } from "../topics/discovery";

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
  async run({ owner, input, services, llm }) {
    if (!services.publications || !services.relations) throw new Error("Services de connaissances indisponibles.");
    const agent = (await services.accounts.watchAgents()).find(item => item.id === input.agent && item.owner === owner);
    if (!agent) throw new Error("ΞAgent indisponible.");
    const publication = await services.publications.get({ id: owner }, input.publication);
    if (publication.status !== "published" || publication.authorId !== agent.id || publication.revision !== input.revision) return { outcome: "obsolete" };
    const text = [publication.summary, ...publication.messages.filter(item => !item.deleted).map(item => item.body)].join("\n").slice(0, 8000);
    const binding = services.agentLLM ? services.agentLLM(agent) : llm(); if (!binding.ok) throw new Error(binding.message);
    const answer = await askJson(binding.inference, { model: binding.resolved.model, system: DISCOVERY_SYSTEM, prompt: `Texte :\n${text}` }, modelSchema, 1);
    const catalog = await services.topics.visible(owner);
    const keys = topicKeys([...catalog.personal, ...catalog.shared]);
    const resolved = new Map<string, { id: string; label: string; quote: string }>();
    // Recheck access and revision after inference, before persisting anything derived from it.
    const current = await services.publications.get({ id: owner }, input.publication);
    if (current.status !== "published" || current.revision !== input.revision) return { outcome: "obsolete" };
    for (const item of answer.concepts) {
      const key = conceptKey(item.label), tag = normalizeTag(item.label);
      if (!key || !tag || !text.includes(item.quote) || !item.quote.toLocaleLowerCase().includes(item.label.toLocaleLowerCase()) || resolved.has(key)) continue;
      const topic = keys.get(key)?.topic ?? (await services.topics.openPersonal(owner, tag)).topic;
      resolved.set(key, { id: topic.id, label: item.label, quote: item.quote });
    }
    for (const item of answer.relations) {
      const a = resolved.get(conceptKey(item.from)), b = resolved.get(conceptKey(item.to));
      if (!a || !b || a.id === b.id || !text.includes(item.quote) || !item.quote.toLocaleLowerCase().includes(item.from.toLocaleLowerCase()) || !item.quote.toLocaleLowerCase().includes(item.to.toLocaleLowerCase()) || !relationCue.test(item.quote)) continue;
      const score = assess({ quote: item.quote, fromSource: false, sourceCount: publication.sources.filter(source => source.url).length, keys: [[item.from], [item.to]], type: item.type, modelConfidence: item.confidence });
      // The model's proposal remains unverified and requires a substantive citation and human review.
      if (score.assessment.evidence < 1 || score.assessment.type < 0.7 || item.justification.length < 20) continue;
      await services.relations.proposePersonal(owner, { source: a.id, target: b.id, type: item.type, origin: "inference", createdBy: `local-model:${binding.resolved.model}`.slice(0, 64), confidence: score.confidence, assessment: score.assessment, justification: item.justification, evidence: [{ kind: "publication", ref: `publication:${publication.id}`, publication: publication.id, excerpt: item.quote }], acceptable: false });
    }
    migrateAgentKnowledge(services.db);
    services.db.transaction(() => {
      services.db.prepare("DELETE FROM xi_agent_knowledge WHERE owner = ? AND agent = ? AND publication = ?").run(owner, agent.id, publication.id);
      const insert = services.db.prepare("INSERT OR IGNORE INTO xi_agent_knowledge VALUES (?, ?, ?, ?, ?, ?)");
      for (const item of resolved.values()) insert.run(owner, agent.id, publication.id, publication.revision, item.id, item.quote);
    })();
    return { outcome: "done", concepts: resolved.size };
  },
};

/** Existing worker queue, keyed by publication revision: retries and concurrent planners stay idempotent. */
export async function planAgentKnowledge(queue: JobQueue, services: NonNullable<Parameters<SystemTask["run"]>[0]["services"]>, at: number) {
  if (!services.publications) return 0;
  await services.publications.ensureIndexed();
  let planned = 0;
  for (const agent of await services.accounts.watchAgents()) {
    for (const item of services.publications.agentPublications(agent.id)) {
      if (item.test) continue;
      const publication = await services.publications.get({ id: agent.owner }, item.id).catch(() => null);
      if (!publication || publication.status !== "published") continue;
      const digest = createHash("sha256").update(`${agent.owner}:${agent.id}:${publication.id}:${publication.revision}`).digest("hex");
      const requestId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
      if (enqueueSystemTask(queue, { agentId: systemAgentDefinition("konstruktor")!.id, kind: "konstruktor", task: "publication-knowledge", owner: agent.owner, requestId, input: { publication: publication.id, agent: agent.id, revision: publication.revision }, trigger: "review" }).created) planned++;
    }
  }
  void at;
  return planned;
}
