import { TopicError, type Draft, type Topic } from "./types";
import { extractSubject, knownSubject, normalizeSubject, type SubjectDefinition } from "./subjects";

const normalize = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const synonyms: Record<string, string> = { politique: "politiks", politiques: "politiks", francaise: "france", francais: "france", allemande: "allemagne", allemand: "allemagne", europeenne: "europe", europeen: "europe", elections: "election" };
export const words = (value: string) => normalize(value).split(/[^a-z0-9]+/).filter(w => w.length > 2 && !["les", "des", "une", "sur", "pour", "dans", "topic", "creer", "veux"].includes(w)).map(w => synonyms[w] ?? w);
export const slug = (value: string) => normalize(value).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "topic";
export function ranked(intent: string, topics: Topic[]) {
  const tokens = new Set(words(intent));
  return topics.map(topic => {
    const identity = new Set(words(`${topic.tag} ${topic.name} ${topic.aliases.join(" ")}`));
    const scope = new Set(words(topic.scope));
    const hits = [...tokens].filter(w => identity.has(w));
    const score = hits.length * 10 + [...tokens].filter(w => scope.has(w)).length;
    return { topic, score, hits };
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.topic.tag.split(".").length - b.topic.tag.split(".").length || a.topic.tag.localeCompare(b.topic.tag));
}

export type TopicProposal = { draft: Draft; matches: string[]; subject?: string; missingParents?: SubjectDefinition[]; existingTopicId?: string };
/** Replacement seam for a future agent; all proposals still pass human confirmation and storage validation. */
export interface TopicAnalyzer { analyze(intent: string, topics: Topic[]): Promise<TopicProposal> }
export const deterministicAnalyzer: TopicAnalyzer = {
  async analyze(intent, topics) {
    const subject = extractSubject(intent);
    if (!subject) throw new TopicError("Précisez le sujet à traiter après votre intention.");
    const candidates = ranked(subject, topics);
    const matches = candidates.slice(0, 8).map(item => item.topic.id);
    const chain = knownSubject(subject);
    const lookup = (tag: string) => topics.find(t => t.tag === tag || t.aliases.includes(tag));
    if (chain) {
      const target = chain.at(-1)!;
      const existing = lookup(target.tag);
      if (existing) return { draft: existing, matches: [...new Set([existing.id, ...matches])], subject: target.name, existingTopicId: existing.id };
      const parentDefinition = chain.at(-2);
      const parent = parentDefinition ? lookup(parentDefinition.tag) : undefined;
      return {
        draft: { ...target, tag: parent ? `${parent.tag}.${target.tag.split(".").at(-1)}` : target.tag, description: "", parentId: parent?.id ?? null, relatedIds: [] },
        matches, subject: target.name,
        missingParents: parent ? [] : chain.slice(0, -1).filter(item => !lookup(item.tag)),
      };
    }
    const name = subject.charAt(0).toLocaleUpperCase("fr-FR") + subject.slice(1);
    const segment = slug(subject);
    const tag = /^[a-z]/.test(segment) ? segment : `topic-${segment}`;
    const existing = topics.find(t => normalizeSubject(t.name) === normalizeSubject(name) || t.tag === tag || t.aliases.includes(tag));
    return {
      draft: existing ?? { tag, name: name.slice(0, 160), description: "", scope: `Informations et connaissances relatives au sujet « ${name.slice(0, 500)} ». Périmètre à préciser avant confirmation.`, parentId: null, relatedIds: [] },
      matches: existing ? [...new Set([existing.id, ...matches])] : matches,
      subject: name, existingTopicId: existing?.id,
    };
  },
};
export function routeRequest(intent: string, topics: Topic[], correction?: { primaryId: string; secondaryIds: string[] }) {
  if (correction) {
    const ids = [correction.primaryId, ...correction.secondaryIds];
    if (new Set(ids).size !== ids.length || ids.some(id => !topics.some(t => t.id === id))) throw new TopicError("Topics de routage invalides.");
    return { ...correction, explanation: "Responsabilité et contexte corrigés par l’utilisateur." };
  }
  const candidates = ranked(intent, topics);
  const primary = candidates[0];
  return { primaryId: primary?.topic.id ?? null, secondaryIds: candidates.slice(1, 4).map(c => c.topic.id), explanation: primary ? `Correspondance déterministe avec ${primary.topic.tag} : ${primary.hits.join(", ") || "scope"}. Les autres topics apportent uniquement du contexte.` : "Aucune correspondance : choisissez un topic responsable." };
}
