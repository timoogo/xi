// Full-text normalization shared by indexing and querying, so both sides always produce the same terms.
// Accents and case are folded; common French/English plural endings are reduced (`transports` → `transport`,
// `journaux` → `journal`). Purely morphological: no synonyms, no semantic expansion.

const fold = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

/** Very frequent words are kept in documents but ignored in queries, where they would only narrow results. */
const QUERY_STOPWORDS = new Set(["a", "au", "aux", "d", "de", "des", "du", "en", "et", "l", "la", "le", "les", "ou", "un", "une", "and", "in", "of", "on", "or", "the", "to"]);

/** Light plural reduction, applied identically to documents and queries. */
export function stem(term: string) {
  if (term.length <= 3 || !/[a-z]$/.test(term)) return term;
  // `-eaux` → `-eau` (bateaux), then `-aux` → `-al` (journaux); words in `-au` other than `-eau` are rare.
  if (term.endsWith("eaux")) return term.slice(0, -1);
  if (term.length > 4 && term.endsWith("aux")) return `${term.slice(0, -3)}al`;
  return /[sx]$/.test(term) && !/ss$/.test(term) ? term.slice(0, -1) : term;
}

export function searchTerms(text: string): string[] {
  return fold(text).split(/[^a-z0-9]+/).filter(Boolean).map(stem);
}

/** Key of a concept or topic name: same key for spelling variants (case, accents, plurals, punctuation). */
export const conceptKey = (text: string) => searchTerms(text).filter(term => !QUERY_STOPWORDS.has(term)).join(" ");

/** The text stored in the FTS index for a publication. */
export const ftsDocument = (text: string) => searchTerms(text).join(" ");

/** FTS5 MATCH expression requiring every meaningful term (implicit AND); null when nothing is searchable. */
export function ftsQuery(text: string): string | null {
  const terms = [...new Set(searchTerms(text).filter(term => !QUERY_STOPWORDS.has(term)))].slice(0, 20);
  // Terms only hold [a-z0-9]: quoting makes each one a literal token, never FTS syntax.
  return terms.length ? terms.map(term => `"${term}"`).join(" ") : null;
}
