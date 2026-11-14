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
- from : le concept qui fait l’action (le sujet de la phrase), to : celui qui la reçoit ; link : tous les mots exacts du texte entre les deux, auxiliaire compris (« a capturé une image de la région », « successfully completed a flight of », « est un »).
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
/**
 * `subject`: the concept the sentence names first (the text's own reading order, whatever the model said).
 * `explicit`: the sentence states this relation explicitly (see `explicitLink`), with the exact words linking the two
 * concepts; null when it is only plausible (kept as a proposal), `why` saying what was missing.
 */
export type ScreenedRelation = {
  from: string; to: string; type: TopicRelationType; link: string; quote: string; confidence: number; note: string | null;
  subject: string; explicit: { label: string } | null; why: string | null;
};
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
    // The model sometimes repeats an end in its linking words (« completed a flight of the X-59 »): only what lies
    // between the two concepts is a link.
    const linkText = trimEnds(item.link, [from.name, to.name]);
    const link = fold(linkText);
    if (ATTRIBUTION.test(link)) { rejected.push({ item: label, reason: "attribution d’une source, pas une relation" }); continue; }
    // « et », « de », « entre » alone link nothing: the linking words need a word of their own.
    if (!link || link.split(" ").length > 8 || !conceptKey(linkText) || !meaningful(linkText)) { rejected.push({ item: label, reason: "aucun mot du texte ne relie les deux concepts" }); continue; }
    // The linking words must stand between the two concepts in one sentence: « L’accord entre NASA et l’USDA vise à… »
    // does not say that NASA « vise » the USDA.
    // A conjunction between them outside the linking words is a coordination (« les données agricoles et explorer des
    // idées »), not a link.
    const between = (line: string) => {
      const a = within(line, from.name), l = within(line, linkText), b = within(line, to.name);
      if (a < 0 || b < 0 || l <= Math.min(a, b) || l >= Math.max(a, b)) return false;
      const words = ` ${terms(line)} `, first = a < b ? from.name : to.name;
      const gap = words.slice(Math.min(a, b) + terms(first).length + 1, Math.max(a, b)).replace(` ${terms(linkText)} `, " ");
      return !/ (et|and|ou|or) /.test(` ${gap} `);
    };
    const quote = lines.find(between);
    if (!quote) { rejected.push({ item: label, reason: "aucune phrase ne relie les deux concepts par ces mots" }); continue; }
    if (relations.length >= MAX_RELATIONS) { rejected.push({ item: label, reason: "au-delà de la limite de relations" }); continue; }
    const asked = (TOPIC_RELATION_TYPES as readonly string[]).includes(item.type) ? item.type as TopicRelationType : "related_to";
    const a = within(quote, from.name), b = within(quote, to.name);
    const oriented = asked === "part_of" || asked === "influences";
    const cue = asked === "related_to" || typeCue(asked, `${linkText} ${quote}`);
    // An oriented relation reads from → link → to in the sentence. When the sentence reads the other way round with the
    // type's cue (« Perseverance … fait partie de … Mars 2020 »), the text gives the direction: the ends are swapped.
    const reversed = oriented && cue && b < a;
    const type = cue ? asked : "related_to";
    const [source, target] = reversed ? [to, from] : [from, to];
    const pair = `${type}:${oriented && type !== "related_to" ? `${source.key}>${target.key}` : [source.key, target.key].sort().join("|")}`;
    if (pairs.has(pair)) continue;
    pairs.add(pair);
    const check = explicitLink(quote, from.name, to.name, linkText, [...concepts.values()].filter(c => c !== from && c !== to).map(c => c.name));
    // Another concept between the two (« NASA test pilot Mike Lippert completed a flight of the X-59 »): the words
    // belong to it, the sentence does not link these two. Quoted exactly, still a wrong relation.
    if (check.interposed) { rejected.push({ item: label, reason: `« ${check.interposed} » s’interpose : la phrase ne relie pas directement ces deux concepts` }); continue; }
    const note = !cue ? `type « ${item.type} » non établi par la phrase : enregistrée comme related_to` : reversed ? "sens inversé pour suivre la phrase" : null;
    const subject = within(quote, from.name) <= within(quote, to.name) ? from.name : to.name;
    // Validation needs the model's reading (from → to) to be the sentence's; a reversed oriented type is a correction.
    const explicit = check.explicit && !reversed ? check.explicit : null;
    relations.push({ from: source.name, to: target.name, type, link: linkText, quote, confidence: item.confidence ?? 0.5, note, subject, explicit, why: explicit ? null : reversed ? "sens corrigé d’après la phrase" : check.why });
  }
  return { concepts: [...concepts.values()], relations, rejected };
}

// Explicit relations. Deterministic and conservative: a relation the sentence only suggests stays a proposal.
const wordSet = (words: string) => new Set(words.split(" ").map(word => searchTerms(word)[0]).filter(Boolean));
/** Words that never introduce a relation of their own: articles, possessives, demonstratives. */
const ARTICLES = wordSet("le la les l un une des du de d the a an son sa ses leur leurs its their his her ce cet cette ces this these those notre nos votre vos our your");
/** Prepositions: a link made of them alone (« de », « avec ») states nothing; before a concept, they make it a complement. */
const PREPOSITIONS = wordSet("de d du des of by par avec with pour for au aux en in into dans sur on from to chez vers at about entre between among parmi sous under selon contre against");
/** Coordinations and relatives: a link containing one joins clauses, it does not relate two concepts. */
const JOINERS = wordSet("et and ou or mais but ni puis then qui que dont which who whom whose that lorsque quand when while alors tandis");
/** Auxiliaries and adverbs allowed before the linking words (« a capturé », « has also completed »). */
const AUXILIARIES = wordSet("a ont avait avaient est sont etait etaient ete has have had is are was were been be being did does do aussi deja also already just");
/** Negation, hypothesis, modality, intention: the sentence does not state the relation as a fact. */
const UNCERTAIN = wordSet("ne n pas jamais aucun aucune nul sans ni guere rarement not no never without nor neither cannot hardly barely rarely scarcely nobody nothing rien "
  + "pourrait pourraient pourra pourront devrait devraient devra aurait auraient serait seraient sera seront peut peuvent envisage prevoit projette souhaite veut veulent vise espere "
  + "potentiellement eventuellement probablement si may might could would should will shall can plan plans planned aim aims intend intends expect expected hope hopes if whether maybe perhaps possibly probably likely unlikely reportedly allegedly supposedly rumeur rumor");
/** Punctuation allowed between two concepts: apostrophes and quotation marks only. A comma, a dash, a bracket open an incise. */
const QUOTES = new Set(["'", "’", "\"", "«", "»", "“", "”"]);
const adverb = (term: string) => (term.length > 4 && term.endsWith("ly")) || (term.length > 6 && /(ement|amment|emment)$/.test(term));

/** Whether linking words carry a word of their own: not only articles, prepositions or conjunctions. */
const meaningful = (link: string) => searchTerms(link).some(term => !ARTICLES.has(term) && !PREPOSITIONS.has(term) && !JOINERS.has(term));
/** Linking words without a concept name repeated at their start or end. */
function trimEnds(link: string, names: string[]) {
  const tokens = tokenize(link);
  let [first, last] = [0, tokens.length - 1];
  for (const name of names) {
    const span = occurrences(tokens, name);
    const head = span.find(([a]) => tokens.slice(first, a).every(token => !token.term || ARTICLES.has(token.term)));
    if (head) first = head[1] + 1;
    const tail = span.findLast(([, b]) => b <= last && tokens.slice(b + 1, last + 1).every(token => !token.term));
    if (tail && tail[0] >= first) last = tail[0] - 1;
  }
  return first > last ? "" : link.slice(tokens[first].start, tokens[last].end).trim();
}

type Token = { text: string; term: string | null; start: number; end: number };
const tokenize = (sentence: string): Token[] => [...sentence.matchAll(/[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu)]
  .map(match => ({ text: match[0], term: /[\p{L}\p{N}]/u.test(match[0]) ? searchTerms(match[0])[0] ?? null : null, start: match.index, end: match.index + match[0].length }));
/** Token spans [first, last] where the phrase's words occur, punctuation inside a name (« X-59 ») allowed. */
function occurrences(tokens: Token[], phrase: string) {
  const wanted = searchTerms(phrase), words = tokens.flatMap((token, index) => token.term ? [index] : []);
  const found: [number, number][] = [];
  if (!wanted.length) return found;
  for (let i = 0; i + wanted.length <= words.length; i++) {
    if (wanted.every((term, k) => tokens[words[i + k]].term === term)) found.push([words[i], words[i + wanted.length - 1]]);
  }
  return found;
}

/**
 * Whether a sentence states « from — link → to » explicitly. All must hold:
 * - both concepts are named, `from` first: the model's direction is the sentence's;
 * - the linking words stand between them, with nothing else but auxiliaries and adverbs before them and articles
 *   after (« successfully completed a flight of the »): no other noun, no incise, no coordination;
 * - the linking words carry a word of their own, not a preposition or an article alone;
 * - `from` is not a complement (« la caméra de NASA », « NASA’s rover ») but the sentence's subject;
 * - no negation, hypothesis, modality or question anywhere in the sentence.
 * `label`: the sentence's exact words from the first auxiliary to the end of the linking words. `interposed`: another
 * retained concept stands between the two (the relation is not theirs: the caller rejects it).
 */
export function explicitLink(sentence: string, from: string, to: string, link: string, others: string[]): { explicit: { label: string } | null; why: string | null; interposed: string | null } {
  const tokens = tokenize(sentence), no = (why: string) => ({ explicit: null, why, interposed: null });
  const links = occurrences(tokens, link);
  // The closest arrangement first, model's direction or not: [first concept, link, second concept].
  const arrangements = occurrences(tokens, from).flatMap(a => occurrences(tokens, to).flatMap(b => {
    const [first, second] = a[0] < b[0] ? [a, b] : [b, a];
    return links.filter(l => l[0] > first[1] && l[1] < second[0]).map(l => ({ first, second, link: l, direct: first === a }));
  })).sort((x, y) => (x.second[0] - x.first[1]) - (y.second[0] - y.first[1]));
  const best = arrangements[0];
  if (!best) return no("les mots du lien ne sont pas entre les deux concepts");
  const inside = (span: [number, number]) => span[0] > best.first[1] && span[1] < best.second[0] && (span[1] < best.link[0] || span[0] > best.link[1]);
  const interposed = others.find(name => occurrences(tokens, name).some(inside));
  if (interposed) return { explicit: null, why: null, interposed };
  if (!best.direct) return no("la phrase se lit dans l’autre sens");
  if (/\?\s*["»”']?\s*$/.test(sentence)) return no("phrase interrogative");
  const terms = tokens.flatMap(token => token.term ? [token.term] : []);
  if (terms.some(term => UNCERTAIN.has(term))) return no("négation, hypothèse ou modalité dans la phrase");
  if (tokens.some((token, index) => token.term === "t" && QUOTES.has(tokens[index - 1]?.text ?? ""))) return no("négation dans la phrase");
  const linkTerms = tokens.slice(best.link[0], best.link[1] + 1).flatMap(token => token.term ? [token.term] : []);
  if (linkTerms.some(term => JOINERS.has(term))) return no("coordination ou relative dans le lien");
  if (!linkTerms.some(term => !ARTICLES.has(term) && !PREPOSITIONS.has(term))) return no("les mots du lien ne disent rien de précis");
  // Between the concepts: auxiliaries/adverbs, the link, articles. Punctuation only as quotes.
  let start = best.link[0];
  for (let index = best.first[1] + 1; index < best.second[0]; index++) {
    if (index >= best.link[0] && index <= best.link[1]) continue;
    const token = tokens[index];
    if (!token.term) { if (QUOTES.has(token.text)) continue; return no("incise ou ponctuation entre les deux concepts"); }
    if (index < best.link[0]) {
      const previous = tokens[index - 1]?.term ?? "";
      if (!AUXILIARIES.has(token.term) && !(adverb(token.term) && !ARTICLES.has(previous))) return no("d’autres mots s’ajoutent au lien");
      start = Math.min(start, index);
    } else if (!ARTICLES.has(token.term)) return no("d’autres mots s’ajoutent au lien");
  }
  // The subject: neither the complement of a preceding noun (« de la NASA ») nor a possessor (« NASA’s »).
  let before = best.first[0] - 1;
  while (before >= 0 && (QUOTES.has(tokens[before].text) || (ARTICLES.has(tokens[before].term ?? "") && !PREPOSITIONS.has(tokens[before].term ?? "")))) before--;
  if (before >= 0 && PREPOSITIONS.has(tokens[before].term ?? "")) return no("le premier concept est un complément, pas le sujet");
  const after = tokens[best.first[1] + 1], next = tokens[best.first[1] + 2];
  if (after && QUOTES.has(after.text) && next?.term === "s") return no("le premier concept est un possesseur, pas le sujet");
  // Trailing articles are the object's (« completed a flight of the »), unless the link is a copula (« est un »).
  let end = best.link[1];
  const trimmed = () => { let at = end; while (at > best.link[0] && (!tokens[at].term || ARTICLES.has(tokens[at].term!))) at--; return at; };
  if (tokens.slice(best.link[0], trimmed() + 1).some(token => token.term && !AUXILIARIES.has(token.term))) end = trimmed();
  return { explicit: { label: sentence.slice(tokens[start].start, tokens[end].end) }, why: null, interposed: null };
}
