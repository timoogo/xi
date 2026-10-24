import type { Preset } from "../accounts/types";
import { GENERATOR_SLUG } from "../graph/types";
import { ranked, slug } from "../topics/analysis";
import { tagSchema, type Draft, type Topic } from "../topics/types";
import { newTopicKey, presetKey, type DraftPatch, type SourceRow, type TopicPick } from "./draft";
import type { AgentProposal } from "./proposal";

/**
 * Rule-based suggestion of a ΞAgent configuration from a few words or a description, without any
 * model: a small local concept catalog (honest and limited), lexical matching against the existing
 * topics, and generic texts built only from the owner's words. Nothing is invented: no sources, no
 * facts; unknown words are kept as plain keywords. Pure and client-safe (no runtime import from
 * proposal.ts, which pulls the server inference code).
 */

export type Concept = { term: string; normalized: string; canonical: string; kind: "keyword" | "synonym" };
export type Suggestion = { patch: DraftPatch; concepts: Concept[]; matches: { id: string; tag: string; name: string; hits: string[] }[]; notes: string[] };

const MAX_CONCEPTS = 12;
const MAX_TOPICS = 5;

/** Lowercase, without accents, ligatures or punctuation, single spaces. */
export function normalizeTerm(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/œ/g, "oe").replace(/æ/g, "ae").replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, " ").trim();
}
/** Plural folding used for matching only (both sides). */
const fold = (normalized: string) => normalized.split(" ").map(word => word.length > 3 && /[^s]s$/.test(word) ? word.slice(0, -1) : word).join(" ");

type TopicHint = { parent?: string; leaf: string; name: string; scope: string };
type Entry = { keys: string[]; canonical: string; topic: TopicHint };

const ASTRO: TopicHint = { parent: "science", leaf: "astronomie", name: "Astronomie", scope: "Observations, découvertes, missions et instruments en astronomie et astrophysique." };
const SPACE: TopicHint = { parent: "science", leaf: "espace", name: "Exploration spatiale", scope: "Missions, lanceurs, agences et politiques spatiales." };
const EXO: TopicHint = { parent: "astronomie", leaf: "exoplanetes", name: "Exoplanètes", scope: "Détection, caractérisation et étude des planètes situées hors du Système solaire." };
const AI: TopicHint = { parent: "technologie", leaf: "intelligence-artificielle", name: "Intelligence artificielle", scope: "Recherche, modèles, usages, régulation et enjeux de l’intelligence artificielle." };
const CYBER: TopicHint = { parent: "technologie", leaf: "cybersecurite", name: "Cybersécurité", scope: "Menaces, vulnérabilités, incidents et protection des systèmes informatiques." };
const QUANTUM: TopicHint = { parent: "technologie", leaf: "informatique-quantique", name: "Informatique quantique", scope: "Recherche, matériel, algorithmes et applications de l’informatique quantique." };
const PHYSICS: TopicHint = { parent: "science", leaf: "physique", name: "Physique", scope: "Recherche et découvertes en physique fondamentale et appliquée." };
const CLIMATE: TopicHint = { parent: "environnement", leaf: "climat", name: "Climat", scope: "Science du climat, changement climatique, impacts et politiques climatiques." };
const BIODIVERSITY: TopicHint = { parent: "environnement", leaf: "biodiversite", name: "Biodiversité", scope: "État, menaces et protection des espèces et des écosystèmes." };
const ENERGY: TopicHint = { leaf: "energie", name: "Énergie", scope: "Production, transition, marchés et politiques de l’énergie." };
const HEALTH: TopicHint = { leaf: "sante", name: "Santé", scope: "Santé publique, recherche médicale, soins et politiques de santé." };
const ECONOMY: TopicHint = { leaf: "economie", name: "Économie", scope: "Conjoncture, politiques économiques et monétaires, entreprises et marchés." };
const EUROPE: TopicHint = { parent: "politiks", leaf: "europe", name: "Union européenne", scope: "Institutions, décisions et politiques de l’Union européenne." };
const ELECTIONS: TopicHint = { parent: "politiks", leaf: "elections", name: "Élections", scope: "Scrutins, campagnes, règles électorales et résultats." };

/** Small, explicit and limited: unknown words stay plain keywords. */
const ENTRIES: Entry[] = [
  { keys: ["jwst", "james webb", "telescope james webb", "james webb space telescope"], canonical: "James Webb Space Telescope", topic: ASTRO },
  { keys: ["hubble"], canonical: "Télescope spatial Hubble", topic: ASTRO },
  { keys: ["astronomie", "astrophysique", "astronomy", "astrophysics"], canonical: "Astronomie", topic: ASTRO },
  { keys: ["nasa"], canonical: "NASA", topic: SPACE },
  { keys: ["esa", "agence spatiale europeenne", "european space agency"], canonical: "Agence spatiale européenne (ESA)", topic: SPACE },
  { keys: ["cnes"], canonical: "CNES", topic: SPACE },
  { keys: ["spacex"], canonical: "SpaceX", topic: SPACE },
  { keys: ["espace", "spatial", "exploration spatiale", "conquete spatiale", "space exploration"], canonical: "Exploration spatiale", topic: SPACE },
  { keys: ["exoplanete", "exoplanet", "planete extrasolaire"], canonical: "Exoplanètes", topic: EXO },
  { keys: ["ia", "ai", "intelligence artificielle", "artificial intelligence"], canonical: "Intelligence artificielle", topic: AI },
  { keys: ["llm", "grand modele de langage", "large language model", "chatgpt"], canonical: "Grands modèles de langage", topic: AI },
  { keys: ["machine learning", "apprentissage automatique", "deep learning", "apprentissage profond"], canonical: "Apprentissage automatique", topic: AI },
  { keys: ["cybersecurite", "cyber", "cybersecurity", "securite informatique"], canonical: "Cybersécurité", topic: CYBER },
  { keys: ["quantique", "informatique quantique", "quantum", "quantum computing"], canonical: "Informatique quantique", topic: QUANTUM },
  { keys: ["cern", "physique des particules", "particle physics"], canonical: "Physique des particules (CERN)", topic: PHYSICS },
  { keys: ["physique", "physics"], canonical: "Physique", topic: PHYSICS },
  { keys: ["climat", "climate", "rechauffement climatique", "changement climatique", "climate change"], canonical: "Climat", topic: CLIMATE },
  { keys: ["giec", "ipcc"], canonical: "GIEC", topic: CLIMATE },
  { keys: ["biodiversite", "biodiversity"], canonical: "Biodiversité", topic: BIODIVERSITY },
  { keys: ["energie", "energy", "transition energetique", "energie renouvelable", "renouvelable"], canonical: "Énergie", topic: ENERGY },
  { keys: ["nucleaire", "energie nucleaire", "nuclear"], canonical: "Énergie nucléaire", topic: ENERGY },
  { keys: ["sante", "health", "medecine", "sante publique"], canonical: "Santé", topic: HEALTH },
  { keys: ["oms", "organisation mondiale de la sante"], canonical: "Organisation mondiale de la santé (OMS)", topic: HEALTH },
  { keys: ["economie", "economy", "inflation", "bce", "banque centrale europeenne"], canonical: "Économie", topic: ECONOMY },
  { keys: ["ue", "union europeenne", "european union"], canonical: "Union européenne", topic: EUROPE },
  { keys: ["election", "elections", "scrutin"], canonical: "Élections", topic: ELECTIONS },
];
const LOOKUP = new Map(ENTRIES.flatMap(entry => entry.keys.map(key => [fold(normalizeTerm(key)), entry] as const)));
const MAX_PHRASE = Math.max(...[...LOOKUP.keys()].map(key => key.split(" ").length));
const entryOf = (concept: Concept) => concept.kind === "synonym" ? ENTRIES.find(entry => entry.canonical === concept.canonical) : undefined;

const STOP = new Set(("le la les l un une des du de d au aux a et ou en dans sur sous pour par avec sans ce cet cette ces son sa ses leur leurs mon ma mes ton ta tes notre nos votre vos " +
  "qui que quoi dont ou est sont etre ete avoir ont fait faire plus moins tres tout tous toute toutes autre autres comme ainsi aussi mais donc car ne pas " +
  "je tu il elle on nous vous ils elles me te se y lui j m n s t c qu quel quelle quels quelles " +
  "veux voudrais souhaite aimerais suivre surveiller veille agent actualite actualites info infos information informations nouvelle nouvelles sujet sujets theme themes " +
  "sujet domaine domaines lie liee lies liees concernant autour propos tout toute tant notamment etc " +
  "the an of and or to in on for with without by from about this that these those is are be was were it its as at into over under " +
  "i want would like follow track news topic topics about related").split(" "));
const isWord = (normalized: string) => /[a-z0-9]/.test(normalized);

type Token = { raw: string; norm: string; key: string };
const tokenize = (text: string): Token[] => (text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? [])
  .flatMap(raw => raw.split(/['’]/).filter(Boolean))
  .map(raw => { const norm = normalizeTerm(raw); return { raw, norm, key: fold(norm) }; })
  .filter(token => isWord(token.norm));

const keepToken = (token: Token, list: boolean) => !STOP.has(token.norm) && token.norm.length >= (list ? 2 : 3) && !/^\d+$/.test(token.norm);
/** Concepts of a list ("a, b; c"), a few words, or a long description. Deduplicated, capped. */
export function extractConcepts(text: string): Concept[] {
  const segments = text.split(/[,;\n|•]+/).map(segment => segment.trim()).filter(Boolean);
  const list = segments.length > 0 && segments.every(segment => tokenize(segment).length <= 5);
  const found: Concept[] = [];
  for (const segment of list ? segments : [text]) {
    const tokens = tokenize(segment);
    const rest: Token[] = [];
    for (let i = 0; i < tokens.length;) {
      let matched = 0;
      for (let n = Math.min(MAX_PHRASE, tokens.length - i); n >= 1 && !matched; n--) {
        const entry = LOOKUP.get(tokens.slice(i, i + n).map(token => token.key).join(" "));
        if (entry) {
          const term = tokens.slice(i, i + n).map(token => token.raw).join(" ");
          found.push({ term, normalized: normalizeTerm(term), canonical: entry.canonical, kind: "synonym" });
          matched = n;
        }
      }
      if (matched) { i += matched; continue; }
      if (list) rest.push(tokens[i]);
      else if (keepToken(tokens[i], false)) found.push({ term: tokens[i].raw, normalized: tokens[i].norm, canonical: tokens[i].norm, kind: "keyword" });
      i++;
    }
    const kept = rest.filter(token => keepToken(token, true));
    if (kept.length) {
      const term = kept.map(token => token.raw).join(" ");
      found.push({ term, normalized: normalizeTerm(term), canonical: normalizeTerm(term), kind: "keyword" });
    }
  }
  const seen = new Set<string>();
  const unique = found.filter(concept => {
    const key = concept.kind === "synonym" ? `s:${concept.canonical}` : `k:${fold(concept.normalized)}`;
    if (seen.has(key) || seen.has(`k:${fold(concept.normalized)}`)) return false;
    seen.add(key); seen.add(`k:${fold(concept.normalized)}`);
    return true;
  });
  if (unique.length <= MAX_CONCEPTS) return unique;
  const synonyms = unique.filter(concept => concept.kind === "synonym").slice(0, MAX_CONCEPTS);
  const keep = new Set([...synonyms, ...unique.filter(concept => concept.kind === "keyword").slice(0, MAX_CONCEPTS - synonyms.length)]);
  return unique.filter(concept => keep.has(concept));
}

/** Pure handle normalisation (same rules as the AI proposal). */
export const toHandle = (value: string, fallback: string) => {
  const cleaned = value.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/^@/, "").replace(/[^a-z0-9.-]+/g, "-").replace(/-+/g, "-").replace(/(^[-.]+|[-.]+$)/g, "").replace(/\.-|-\./g, ".").slice(0, 60).replace(/[-.]+$/, "");
  return GENERATOR_SLUG.test(cleaned) ? cleaned : slug(fallback);
};
const leafTag = (value: string) => {
  const segment = slug(value).replace(/-+$/, "");
  const leaf = /^[a-z]/.test(segment) ? segment : `t-${segment}`.slice(0, 50).replace(/-+$/, "");
  return tagSchema.safeParse(leaf).success ? leaf : "topic";
};
const capitalize = (value: string) => value.charAt(0).toLocaleUpperCase("fr-FR") + value.slice(1);
const joinFr = (items: string[]) => items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} et ${items.at(-1)}`;
const display = (concept: Concept) => concept.kind === "synonym" && normalizeTerm(concept.canonical) !== concept.normalized ? `${concept.term} (${concept.canonical})` : concept.term;

const tagged = (topic: Topic, tag: string) => topic.tag === tag || topic.aliases.includes(tag);
const endsWith = (topic: Topic, leaf: string) => [topic.tag, ...topic.aliases].some(tag => tag === leaf || tag.endsWith(`.${leaf}`));
const sameName = (topic: Topic, ...names: string[]) => names.some(name => fold(normalizeTerm(topic.name)) === fold(normalizeTerm(name)));
const byDepth = (a: Topic, b: Topic) => a.tag.split(".").length - b.tag.split(".").length || a.tag.localeCompare(b.tag);

type Candidate = { order: number; weight: number; concepts: Concept[] } & ({ existing: Topic } | { hint: TopicHint; fromKeyword?: boolean });

/** Deterministic configuration from the owner's words; existing topics are preferred to new ones. */
export function suggestDraft({ text, catalog, presets }: { text: string; catalog: Topic[]; presets: Preset[] }): Suggestion {
  const concepts = extractConcepts(text);
  const notes: string[] = [];
  const preset = presets[0];
  const base: DraftPatch = preset ? { presetKey: presetKey(preset), settings: { ...preset.settings } } : {};
  const presetNote = preset ? `Réglages du preset « ${preset.name} » appliqués par défaut (modifiables).` : null;
  const sourcesNote = "Aucune source proposée : ajoutez et validez vous-même les sources fiables.";
  if (!concepts.length) {
    notes.push("Aucun mot exploitable : précisez le sujet en quelques mots (ex. « Astronomie, NASA, exoplanètes »).");
    return { patch: base, concepts, matches: [], notes: presetNote ? [...notes, presetNote] : notes };
  }
  const list = text.split(/[,;\n|•]+/).filter(segment => segment.trim()).every(segment => tokenize(segment).length <= 5);

  // Existing topics: exact tag/alias/name equality, then lexical ranking.
  const scores = new Map<string, { topic: Topic; score: number; hits: Set<string>; exact: boolean; order: number }>();
  const credit = (topic: Topic, score: number, hits: string[], exact: boolean, order: number) => {
    const current = scores.get(topic.id) ?? { topic, score: 0, hits: new Set<string>(), exact: false, order };
    current.score += score; hits.forEach(hit => current.hits.add(hit)); current.exact ||= exact; current.order = Math.min(current.order, order);
    scores.set(topic.id, current);
  };
  const exactFor = (concept: Concept) => {
    const entry = entryOf(concept);
    const candidates = entry
      ? catalog.filter(topic => endsWith(topic, entry.topic.leaf) || sameName(topic, entry.topic.name, entry.canonical))
      : catalog.filter(topic => endsWith(topic, leafTag(concept.normalized)) || sameName(topic, concept.term));
    return candidates.sort(byDepth)[0];
  };
  const groups = new Map<string, Candidate>();
  const loose: Concept[] = [];
  concepts.forEach((concept, order) => {
    const existing = exactFor(concept);
    if (existing) { credit(existing, 100, [concept.normalized], true, order); return; }
    const entry = entryOf(concept);
    if (!entry) { loose.push(concept); return; }
    const group = groups.get(entry.topic.leaf) ?? { order, weight: 0, concepts: [], hint: entry.topic };
    group.weight += 100; group.concepts.push(concept);
    groups.set(entry.topic.leaf, group);
  });
  const query = concepts.flatMap(concept => [concept.term, concept.kind === "synonym" ? concept.canonical : ""]).join(" ");
  for (const item of ranked(query, catalog)) credit(item.topic, item.score, item.hits, false, concepts.length);

  // A concept group whose hinted topic name is already lexically covered by an existing topic is not duplicated.
  const existing: Candidate[] = [...scores.values()].filter(item => item.exact || item.hits.size > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order || byDepth(a.topic, b.topic))
    .map(item => ({ order: item.order, weight: item.score, concepts: [], existing: item.topic }));
  const fresh: Candidate[] = [...groups.values()].sort((a, b) => b.weight - a.weight || a.order - b.order);
  const keywordTopics = list || (!existing.length && !fresh.length) ? (list ? loose : loose.slice(0, 1)) : [];
  for (const concept of keywordTopics) fresh.push({ order: concepts.indexOf(concept), weight: 50, concepts: [concept], hint: { leaf: leafTag(concept.normalized), name: capitalize(concept.term).slice(0, 160), scope: `Informations et actualités relatives à « ${concept.term.slice(0, 500)} ». Périmètre à préciser.` }, fromKeyword: true });

  const picks: TopicPick[] = [];
  const pickedNames: string[] = [];
  const usedTags = new Set<string>();
  const usedIds = new Set<string>();
  const addExisting = (topic: Topic, reason: string) => {
    if (usedIds.has(topic.id) || picks.length >= MAX_TOPICS) return;
    usedIds.add(topic.id);
    picks.push({ type: "existing", id: topic.id, reason });
    pickedNames.push(topic.name);
  };
  const addNew = (candidate: Extract<Candidate, { hint: TopicHint }>) => {
    if (picks.length >= MAX_TOPICS) return;
    const { hint } = candidate;
    const parent = hint.parent ? catalog.filter(topic => endsWith(topic, hint.parent!)).sort(byDepth)[0] : undefined;
    const tag = parent ? `${parent.tag}.${hint.leaf}` : hint.leaf;
    const collision = catalog.find(topic => tagged(topic, tag));
    if (collision) { addExisting(collision, "Même étiquette qu’un topic existant : réutilisé pour éviter un doublon."); notes.push(`Topic existant réutilisé : ${collision.tag} (${collision.name}).`); return; }
    if (usedTags.has(tag) || !tagSchema.safeParse(tag).success) return;
    usedTags.add(tag);
    const draft: Draft = { tag, name: hint.name, description: "", scope: hint.scope, parentId: parent?.id ?? null, relatedIds: [] };
    picks.push({ type: "new", key: newTopicKey(picks), draft });
    pickedNames.push(hint.name);
    notes.push(`Nouveau topic proposé : ${hint.name} (${tag})${parent ? `, sous ${parent.tag}` : ""}, à confirmer.`);
  };

  const ordered = [...existing, ...fresh];
  const primary = existing[0] ?? fresh[0];
  const rest = ordered.filter(candidate => candidate !== primary).sort((a, b) => b.weight - a.weight || a.order - b.order || ("existing" in a ? -1 : 0) - ("existing" in b ? -1 : 0));
  for (const candidate of primary ? [primary, ...rest] : rest) {
    if ("existing" in candidate) {
      const item = scores.get(candidate.existing.id)!;
      const hits = [...item.hits];
      addExisting(candidate.existing, item.exact ? "Étiquette ou nom identique à un mot-clé." : `Mots communs : ${hits.join(", ")}.`);
      if (usedIds.has(candidate.existing.id)) notes.push(`Topic existant réutilisé : ${candidate.existing.tag} (${candidate.existing.name}) — correspondance : ${hits.join(", ")}.`);
    } else addNew(candidate);
  }

  for (const concept of concepts.filter(concept => concept.kind === "synonym")) {
    const entry = entryOf(concept)!;
    notes.push(normalizeTerm(concept.canonical) === concept.normalized
      ? `« ${concept.term} » rattaché à ${entry.topic.name} (catalogue local).`
      : `« ${concept.term} » reconnu comme ${concept.canonical} (catalogue local), rattaché à ${entry.topic.name}.`);
  }
  const unknown = concepts.filter(concept => concept.kind === "keyword");
  if (unknown.length) notes.push(`${unknown.length > 1 ? "Mots-clés conservés tels quels" : "Mot-clé conservé tel quel"} (absents du catalogue local) : ${unknown.map(concept => concept.term).join(", ")}.`);

  const subject = pickedNames[0] ?? capitalize(concepts[0].term);
  const name = `Veille ${subject}`.slice(0, 160).trim();
  const covered = concepts.map(display);
  const patch: DraftPatch = {
    ...base,
    name, handle: toHandle(name, subject),
    about: `Veille consacrée à ${joinFr(pickedNames.length ? pickedNames : [subject])}. Elle suit les publications des sources que vous validez, sans affirmation non sourcée.`.slice(0, 4000),
    topics: picks,
    perimeter: `Couvre : ${covered.join(", ")}.\nExclut : rumeurs, contenus non sourcés ou invérifiables, contenus promotionnels et sujets sans lien avec ce périmètre.`.slice(0, 4000),
    charter: "Citer systématiquement les sources ; distinguer faits établis, annonces et hypothèses ; signaler les incertitudes.",
  };
  if (!picks.length) delete patch.topics;
  notes.push(sourcesNote);
  if (presetNote) notes.push(presetNote);
  const matches = [...scores.values()].filter(item => item.exact || item.hits.size > 0 || item.score > 0)
    .sort((a, b) => b.score - a.score || byDepth(a.topic, b.topic)).slice(0, 6)
    .map(item => ({ id: item.topic.id, tag: item.topic.tag, name: item.topic.name, hits: [...item.hits] }));
  return { patch, concepts, matches, notes };
}

/** Local-model proposal as a draft patch: suggested sources stay undecided, empty texts do not erase anything. */
export function proposalToPatch(proposal: AgentProposal, presets: Preset[]): DraftPatch {
  const topics: TopicPick[] = [proposal.primary, ...proposal.secondary].map(topic => topic.type === "existing" ? { type: "existing", id: topic.id, reason: topic.reason } : { type: "new", key: topic.key, draft: { ...topic.draft } });
  const sources: SourceRow[] = proposal.sources.map(source => ({ url: source.url, domain: source.domain, type: source.type, rationale: source.rationale, origin: "ai", status: "undecided" }));
  const patch: DraftPatch = { name: proposal.name, handle: proposal.handle, topics, settings: { ...proposal.settings }, sources };
  if (proposal.description.trim()) patch.about = proposal.description;
  if (proposal.perimeter.trim()) patch.perimeter = proposal.perimeter;
  if (proposal.charter.trim()) patch.charter = proposal.charter;
  const same = presets.find(preset => (["tone", "structure", "depth", "audience"] as const).every(key => preset.settings[key] === proposal.settings[key]));
  if (same) patch.presetKey = presetKey(same);
  return patch;
}
