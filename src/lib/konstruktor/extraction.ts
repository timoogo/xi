// Konstruktor's knowledge extraction: what the local model is asked, and the deterministic screening of its answer.
// The model only names concepts and the words linking them; quotes are found in the text by code, so provenance never
// depends on the model copying a sentence, and nothing absent from the publication can pass.

import { z } from "zod";
import { conceptKey, searchTerms } from "../search/text";
import { TOPIC_RELATION_TYPES, type TopicRelationType } from "../topics/relations";

export const MAX_CONCEPTS = 10;
export const MAX_RELATIONS = 8;

export const KNOWLEDGE_SYSTEM = `Tu extrais d’un texte d’actualité les connaissances réutilisables : entités, notions, et les relations que le texte affirme entre elles. Fiable plutôt qu’exhaustif.
Réponds uniquement en JSON : {"concepts":[{"name":"…","kind":"…"}],"relations":[{"from":"…","link":"…","to":"…","type":"…","confidence":0.0}]}
Concepts (au plus ${MAX_CONCEPTS}) :
- name : le nom tel qu’écrit dans le texte, sans article, le plus court qui reste précis : « NASA », « Perseverance », « X-59 », « Mike Lippert », « vol supersonique ».
- kind : organisation, personne, lieu, mission, engin, technologie, notion ou evenement. Un accord ou un événement seulement s’il est précis.
- Jamais : un morceau de phrase, un verbe (« moderniser les données »), une date, une formule vague (« idées risquées »), une fonction collée au nom (« NASA test pilot Mike Lippert » → « Mike Lippert »).
Relations (au plus ${MAX_RELATIONS} ; aucune si le texte n’en affirme pas) :
- from, to : deux concepts de ta liste ; link : les mots exacts du texte entre les deux (« a capturé une image de », « completed a flight of »).
- type : part_of (from fait partie de to), influences (from agit sur to), similar_to, opposes, sinon related_to.
- « selon », « d’après », « according to » citent une source : ce n’est pas une relation.
Exemple : « Le rover Perseverance explore le cratère Jezero, selon la NASA. » → {"concepts":[{"name":"Perseverance","kind":"engin"},{"name":"cratère Jezero","kind":"lieu"},{"name":"NASA","kind":"organisation"}],"relations":[{"from":"Perseverance","link":"explore","to":"cratère Jezero","type":"related_to","confidence":0.9}]}`;

const label = z.string().trim().min(1).max(160);
export const knowledgeAnswerSchema = z.object({
  concepts: z.array(z.object({ name: label, kind: z.string().trim().max(40).optional() })).max(40),
  relations: z.array(z.object({
    from: label, to: label, link: z.string().trim().max(200).default(""),
    type: z.string().trim().max(40).default("related_to"), confidence: z.number().min(0).max(1).optional(),
  })).max(20),
}).strip();
export type KnowledgeAnswer = z.infer<typeof knowledgeAnswerSchema>;

export type ScreenedConcept = { name: string; key: string; quote: string };
export type ScreenedRelation = { from: string; to: string; type: TopicRelationType; link: string; quote: string; confidence: number; note: string | null };
export type Screened = { concepts: ScreenedConcept[]; relations: ScreenedRelation[]; rejected: { item: string; reason: string }[] };

/** Normalized words (accents, case, punctuation, plurals folded) for matching a name inside a sentence. */
const terms = (text: string) => searchTerms(text).join(" ");
/** Position of a phrase's words in a sentence's words, or -1. */
const within = (sentence: string, phrase: string) => { const wanted = terms(phrase); return wanted ? ` ${terms(sentence)} `.indexOf(` ${wanted} `) : -1; };
const has = (sentence: string, phrase: string) => within(sentence, phrase) >= 0;

/** Sentences, without splitting abbreviations or dates (« Oct. 21 »): a break needs a capital or a quote after it. */
export function sentences(text: string) {
  return [...new Set(text.split(/\n+|(?<=[.!?…])\s+(?=[A-ZÀ-ÖØ-Þ«"“'])/u).map(item => item.trim()).filter(Boolean))];
}
const ARTICLE = /^(?:l['’]\s*|(?:le|la|les|un|une|des|du|de la|the|a|an)\s+)/iu;
const DATE_WORDS = new Set(["jan", "janv", "janvier", "feb", "fev", "fevrier", "mar", "mars", "march", "apr", "avr", "avril", "april", "may", "mai", "jun", "juin", "june", "jul", "juil", "juillet", "july", "aug", "aou", "aout", "august", "sep", "sept", "septembre", "september", "oct", "octobre", "october", "nov", "novembre", "november", "dec", "decembre", "december"]);
const DETERMINERS = new Set(["le", "la", "les", "l", "des", "du", "un", "une", "de", "d", "son", "sa", "ses", "leur", "leurs", "ce", "cette", "ces", "notre", "nos"]);
const ATTRIBUTION = /^(?:selon|d apres|according to|said|says|a declare|declare|rapporte|reports?)\b/;
const fold = (text: string) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Why a name is not a reusable concept, or null. Fragments are caught here whatever the model says. */
function conceptFault(name: string, kind: string | undefined) {
  const words = fold(name).split(" ").filter(Boolean);
  if (!words.length) return "nom vide";
  if (words.length > 6) return "fragment de phrase (plus de six mots)";
  if (/^(date|heure|nombre|chiffre|number)$/.test(fold(kind ?? ""))) return "date ou nombre, pas un concept";
  // « Oct. 21, 2026 » is a date; « Mars » (the planet) or « Mars 2020 » (a mission) are not.
  const named = /^(mission|engin|lieu|organisation|personne|person|technologie|programme)$/.test(fold(kind ?? ""));
  if (!named && words.some(word => /^\d+$/.test(word)) && words.every(word => /^\d+$/.test(word) || DATE_WORDS.has(word))) return "date ou nombre, pas un concept";
  // The model itself says so: « explorer », kind « verbe ».
  if (/^(verbe|verb|action|adjectif|adjective)$/.test(fold(kind ?? ""))) return "verbe ou qualificatif, pas un concept";
  // « moderniser les données », « explorer des idées » : an infinitive followed by its object is an action, not a concept.
  if (/(er|ir|re|oir)$/.test(words[0]) && words.length > 1 && DETERMINERS.has(words[1])) return "action (verbe et complément), pas un concept";
  if (words[0] === "to" && words.length > 1) return "action (verbe et complément), pas un concept";
  return null;
}

/**
 * Keeps what the publication supports. A concept must be named in a sentence of the text; a relation needs two kept
 * concepts named in one sentence with the model's linking words between them, which are not an attribution. An oriented
 * type is kept only when the sentence reads from → link → to and carries its cue; otherwise it is recorded as
 * « related_to » rather than as a direction or nature the text does not state.
 */
export function screenKnowledge(text: string, answer: KnowledgeAnswer, typeCue: (type: TopicRelationType, sentence: string) => boolean): Screened {
  const lines = sentences(text);
  const rejected: Screened["rejected"] = [];
  const concepts = new Map<string, ScreenedConcept>();
  for (const item of answer.concepts) {
    const name = item.name.replace(/^["'«“\s]+|["'»”\s.,;:]+$/gu, "").replace(ARTICLE, "").trim();
    const fault = conceptFault(name, item.kind);
    if (fault) { rejected.push({ item: item.name, reason: fault }); continue; }
    const key = terms(name);
    if (concepts.has(key)) continue;
    const quote = lines.find(line => has(line, name));
    if (!quote) { rejected.push({ item: item.name, reason: "absent du texte" }); continue; }
    if (concepts.size >= MAX_CONCEPTS) { rejected.push({ item: name, reason: "au-delà de la limite de concepts" }); continue; }
    concepts.set(key, { name, key, quote });
  }
  const relations: ScreenedRelation[] = [];
  const pairs = new Set<string>();
  for (const item of answer.relations) {
    const label = `${item.from} → ${item.to}`;
    const from = concepts.get(terms(item.from.replace(ARTICLE, ""))), to = concepts.get(terms(item.to.replace(ARTICLE, "")));
    if (!from || !to || from.key === to.key) { rejected.push({ item: label, reason: "extrémité absente des concepts retenus" }); continue; }
    const link = fold(item.link);
    // « et », « de » alone link nothing: the linking words need a meaningful term.
    if (!link || link.split(" ").length > 8 || !conceptKey(item.link)) { rejected.push({ item: label, reason: "aucun mot du texte ne relie les deux concepts" }); continue; }
    if (ATTRIBUTION.test(link)) { rejected.push({ item: label, reason: "attribution d’une source, pas une relation" }); continue; }
    // The linking words must stand between the two concepts in one sentence: « L’accord entre NASA et l’USDA vise à… »
    // does not say that NASA « vise » the USDA.
    // A conjunction between them outside the linking words is a coordination (« les données agricoles et explorer des
    // idées »), not a link.
    const between = (line: string) => {
      const a = within(line, from.name), l = within(line, item.link), b = within(line, to.name);
      if (a < 0 || b < 0 || l <= Math.min(a, b) || l >= Math.max(a, b)) return false;
      const words = ` ${terms(line)} `, first = a < b ? from.name : to.name;
      const gap = words.slice(Math.min(a, b) + terms(first).length + 1, Math.max(a, b)).replace(` ${terms(item.link)} `, " ");
      return !/ (et|and|ou|or) /.test(` ${gap} `);
    };
    const quote = lines.find(between);
    if (!quote) { rejected.push({ item: label, reason: "aucune phrase ne relie les deux concepts par ces mots" }); continue; }
    if (relations.length >= MAX_RELATIONS) { rejected.push({ item: label, reason: "au-delà de la limite de relations" }); continue; }
    const asked = (TOPIC_RELATION_TYPES as readonly string[]).includes(item.type) ? item.type as TopicRelationType : "related_to";
    const a = within(quote, from.name), b = within(quote, to.name);
    const oriented = asked === "part_of" || asked === "influences";
    const cue = asked === "related_to" || typeCue(asked, `${item.link} ${quote}`);
    // An oriented relation reads from → link → to in the sentence. When the sentence reads the other way round with the
    // type's cue (« Perseverance … fait partie de … Mars 2020 »), the text gives the direction: the ends are swapped.
    const reversed = oriented && cue && b < a;
    const type = cue ? asked : "related_to";
    const [source, target] = reversed ? [to, from] : [from, to];
    const pair = `${type}:${oriented && type !== "related_to" ? `${source.key}>${target.key}` : [source.key, target.key].sort().join("|")}`;
    if (pairs.has(pair)) continue;
    pairs.add(pair);
    const note = !cue ? `type « ${item.type} » non établi par la phrase : enregistrée comme related_to` : reversed ? "sens inversé pour suivre la phrase" : null;
    relations.push({ from: source.name, to: target.name, type, link: item.link.trim(), quote, confidence: item.confidence ?? 0.5, note });
  }
  return { concepts: [...concepts.values()], relations, rejected };
}
