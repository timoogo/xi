// Universal search syntax, shared by the server and the browser: plain words, `#topic` and `@agent`.
// Pure and dependency-free. Publications never need hashtags: `#` only addresses a Topic.

export const MAX_QUERY_LENGTH = 300;
export const MAX_QUERY_REFERENCES = 10;

export type SearchQuery = {
  /** Free text, without the `#`/`@` references. */
  text: string;
  /** Normalized topic tags, in order of appearance, without duplicates. */
  topics: string[];
  /** Normalized ΞAgent handles, in order of appearance, without duplicates. */
  agents: string[];
};

// Same shapes as tagSchema (topics/types.ts) and GENERATOR_SLUG (graph/types.ts).
const TAG = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/;
const HANDLE = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)*$/;

const fold = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const segments = (value: string) => fold(value).split(".")
  .map(segment => segment.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""))
  .filter(Boolean);

/** `#Élections.Françaises` → `elections.francaises`; null when no valid tag remains. */
export function normalizeTag(raw: string): string | null {
  const tag = segments(raw.replace(/^#+/, "")).join(".");
  return tag.length <= 180 && TAG.test(tag) ? tag : null;
}

/** `@Science.Bot` → `science.bot`; null when it is not a valid handle. */
export function normalizeHandle(raw: string): string | null {
  const handle = segments(raw.replace(/^@+/, "")).join(".");
  return handle.length <= 180 && HANDLE.test(handle) ? handle : null;
}

// Sentence punctuation glued to a reference (`#transport,`) is not part of it.
const trailing = /[.,;:!?…)\]"'»]+$/;

export function parseSearchQuery(input: string): SearchQuery {
  const topics: string[] = [];
  const agents: string[] = [];
  const text: string[] = [];
  for (const token of input.slice(0, MAX_QUERY_LENGTH).split(/\s+/).filter(Boolean)) {
    const marker = token[0];
    const reference = marker === "#" ? normalizeTag(token.replace(trailing, "")) : marker === "@" ? normalizeHandle(token.replace(trailing, "")) : null;
    const target = marker === "#" ? topics : agents;
    // An invalid reference (`#`, `#2026`) stays plain text rather than being silently dropped.
    if (!reference) text.push(token);
    else if (!target.includes(reference) && target.length < MAX_QUERY_REFERENCES) target.push(reference);
  }
  return { text: text.join(" "), topics, agents };
}

/** Canonical URL of a topic page. Tags only hold [a-z0-9.-], safe in a path segment. */
export const topicHref = (tag: string) => `/dashboard/topics/${tag}`;
export const searchHref = (query: string) => `/dashboard/explore?q=${encodeURIComponent(query)}`;
