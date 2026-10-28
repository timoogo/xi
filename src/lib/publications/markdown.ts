import { Document, parseDocument } from "yaml";
import { z } from "zod";
import { rewriteFolderLinks } from "./links";
import { VISIBILITIES, type PublicationMeta } from "./types";
import { PUBLICATION_ID, USER_ID } from "./vault";

// Pure Markdown/Obsidian format helpers. See docs/publications.md for the format itself.

export { rewriteFolderLinks };

export function splitFrontmatter(text: string): { yaml: string | null; body: string } {
  const match = /^---\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m.exec(text);
  if (!match || match.index !== 0) return { yaml: null, body: text };
  return { yaml: match[1], body: text.slice(match[0].length) };
}

const metaSchema = z.object({
  id: z.string().regex(PUBLICATION_ID),
  type: z.enum(["post", "thread"]),
  author_type: z.enum(["human", "ai"]),
  author_id: z.string().regex(USER_ID),
  status: z.enum(["draft", "published"]),
  visibility: z.enum(VISIBILITIES),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
  published_at: z.string().nullish(),
  score: z.number().nullish(),
});

/** `generatorId`: the optional `generator:` property (a generator UUID, anything else ignored), kept in the Document. */
export type ParsedIndex = { doc: Document; meta: PublicationMeta | null; body: string; generatorId: string | null };

/** Keeps the YAML Document itself, so unknown properties and comments added in Obsidian survive a rewrite. */
export function parseIndex(text: string): ParsedIndex {
  const { yaml, body } = splitFrontmatter(text);
  const doc = yaml === null ? new Document({}) : parseDocument(yaml);
  if (doc.errors.length) return { doc, meta: null, body, generatorId: null };
  const raw: unknown = doc.toJS();
  const parsed = metaSchema.safeParse(raw);
  if (!parsed.success) return { doc, meta: null, body, generatorId: null };
  const data = parsed.data;
  const generator = (raw as Record<string, unknown>).generator;
  return {
    doc,
    body,
    generatorId: typeof generator === "string" && PUBLICATION_ID.test(generator) ? generator : null,
    meta: {
      id: data.id, type: data.type, authorType: data.author_type, authorId: data.author_id, status: data.status,
      visibility: data.visibility, createdAt: data.created_at, updatedAt: data.updated_at,
      publishedAt: data.published_at ?? null, score: data.score ?? null,
    },
  };
}

export function setMeta(doc: Document, meta: PublicationMeta) {
  if (!doc.contents) doc.contents = doc.createNode({}) as Document["contents"];
  const values: Record<string, string | number | null> = {
    id: meta.id, type: meta.type, author_type: meta.authorType, author_id: meta.authorId, status: meta.status,
    visibility: meta.visibility, created_at: meta.createdAt, updated_at: meta.updatedAt, published_at: meta.publishedAt, score: meta.score,
  };
  for (const [key, value] of Object.entries(values)) {
    if (value === null) doc.delete(key);
    else doc.set(key, value);
  }
}

export function serializeIndex(doc: Document, summary: string, embeds: string[]) {
  const parts = [summary.trim(), embeds.map((target) => `![[${target}]]`).join("\n")].filter(Boolean);
  return `---\n${doc.toString({ lineWidth: 0 })}---\n\n${parts.join("\n\n")}\n`;
}

/** File name targeted by a wikilink or embed: "a/b/1_x|alias" and "1_x#heading" both give "1_x.md". */
export function linkTargetFile(target: string) {
  const path = target.split("|")[0].split("#")[0].trim();
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name.endsWith(".md") ? name : `${name}.md`;
}

/** Message embeds (standalone `![[…]]` lines targeting a message of the folder) give the order; everything else is the summary. */
export function splitIndexBody(body: string, isMessage: (file: string) => boolean) {
  const order: string[] = [];
  const kept: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const embed = /^\s*!\[\[([^\]\n]+)\]\]\s*$/.exec(line);
    const file = embed && linkTargetFile(embed[1]);
    if (file && isMessage(file)) {
      if (!order.includes(file)) order.push(file);
    } else kept.push(line);
  }
  return { summary: kept.join("\n").trim(), order };
}

/** Vault-relative targets avoid ambiguity between the many `1_….md` files of the vault. */
export function messageEmbedTarget(folder: string, file: string) {
  return `${folder}/${file.replace(/\.md$/, "")}`;
}

export function slugify(text: string, fallback: string) {
  const words = text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean).slice(0, 6);
  return words.join("_").slice(0, 48).replace(/_+$/, "") || fallback;
}

function firstLine(markdown: string) {
  return splitFrontmatter(markdown).body.split(/\r?\n/).map((line) => line.trim()).find((line) => line && !/^#+\s*sources\s*$/i.test(line)) ?? "";
}

export function messageSlug(body: string) {
  return slugify(firstLine(body).replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, "$2"), "message");
}

/** A message only becomes a file once it has content besides its `## Sources` heading. */
export function hasContent(body: string) {
  return firstLine(body) !== "";
}

/** Readable text of a Markdown note: no frontmatter, link targets or formatting marks. */
export function plainText(markdown: string) {
  return splitFrontmatter(markdown).body
    .replace(/!?\[\[([^\]|]*\|)?([^\]]*)\]\]/g, "$2")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_`~-]+/g, " ")
    .replace(/\s+/g, " ").trim();
}

export function excerpt(markdown: string, length = 200) {
  const text = plainText(markdown);
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

export type SourceInput = { url: string; title: string; publisher: string; publishedAt?: string; facts: string[]; reservations: string[] };

/** A source note only ever contains what the author supplied; nothing is inferred or completed. */
export function serializeSource(source: SourceInput, accessedAt: string) {
  const doc = new Document({
    type: "source", url: source.url, title: source.title, publisher: source.publisher,
    ...(source.publishedAt ? { published_at: source.publishedAt } : {}), accessed_at: accessedAt,
  });
  const list = (items: string[]) => items.length ? items.map((item) => `- ${item}`).join("\n") : "_Aucune._";
  return `---\n${doc.toString({ lineWidth: 0 })}---\n\n# ${source.title}\n\n<${source.url}>\n\n## Faits utilisés\n\n${list(source.facts)}\n\n## Réserves\n\n${list(source.reservations)}\n`;
}

export function parseSource(text: string) {
  const { yaml, body } = splitFrontmatter(text);
  const data = yaml ? parseDocument(yaml).toJS() as Record<string, unknown> | null : null;
  const string = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;
  const url = string(data?.url);
  const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && !!item.trim()).map((item) => item.trim()) : string(value) ? [string(value)!] : [];
  const section = (heading: string) => {
    const lines = body.split(/\r?\n/);
    const start = lines.findIndex((line) => line.trim().toLocaleLowerCase("fr") === `## ${heading}`.toLocaleLowerCase("fr"));
    if (start < 0) return [];
    const result: string[] = [];
    for (const line of lines.slice(start + 1)) {
      if (/^#{1,6}\s/.test(line)) break;
      if (/^[-*]\s+/.test(line.trim())) result.push(line.trim().replace(/^[-*]\s+/, ""));
    }
    return result;
  };
  return {
    title: string(data?.title), publisher: string(data?.publisher),
    url: url && /^https?:\/\//i.test(url) ? url : null,
    date: string(data?.published_at), author: string(data?.author),
    kinds: strings(data?.categories ?? data?.nature), excerpts: strings(data?.excerpts),
    claims: [...strings(data?.claims), ...section("Faits utilisés")], reservations: section("Réserves"),
  };
}

/** A message's prose and its trailing `## Sources` section ("" when absent). */
export function splitSourcesSection(body: string) {
  const match = /^#{1,6}\s*sources\s*$/im.exec(body);
  return match ? { prose: body.slice(0, match.index).trimEnd(), sources: body.slice(match.index) } : { prose: body.trimEnd(), sources: "" };
}

export function sourceLinkLine(folder: string, file: string, title: string, publisher: string) {
  const alias = title.replace(/[[\]|#^\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  return `- [[${folder}/_sources/${file.replace(/\.md$/, "")}|${alias}]] — ${publisher.replace(/[\r\n]+/g, " ")}`;
}
