import { Document, parseDocument } from "yaml";
import { z } from "zod";
import { splitFrontmatter } from "../publications/markdown";
import { VISIBILITIES, type Visibility } from "../publications/types";
import { PUBLICATION_ID, USER_ID } from "../publications/vault";
import {
  GENERATOR_SLUG, MESSAGE_REF, RELATION_STATUSES, SEMANTIC_TYPES, type MessageRef, type RelationOrigin, type RelationStatus,
  type SemanticType,
} from "./types";

// Pure parse/serialize of generators/<slug>/index.md and relations/<uuid>.md. See docs/graph.md for the format.
// The YAML Document is kept so unknown properties and Obsidian comments survive an update.

export const GRAPH_ID = PUBLICATION_ID;

export type GeneratorRecord = {
  id: string;
  slug: string;
  title: string;
  ownerId: string;
  visibility: Visibility;
  createdAt: string | null;
};

export type RelationRecord = {
  id: string;
  type: SemanticType;
  source: MessageRef;
  target: MessageRef;
  status: RelationStatus;
  needsReview: boolean;
  origin: RelationOrigin;
  createdBy: string;
  createdAt: string;
  validatedBy: string | null;
  validatedAt: string | null;
};

const text = z.string().trim().min(1).max(500);

const generatorSchema = z.object({
  id: z.string().regex(GRAPH_ID),
  slug: z.string().max(200).regex(GENERATOR_SLUG),
  title: text.optional(),
  owner_id: z.string().regex(USER_ID),
  visibility: z.enum(VISIBILITIES),
  created_at: z.string().min(1).optional(),
});

const relationSchema = z.object({
  id: z.string().regex(GRAPH_ID),
  type: z.enum(SEMANTIC_TYPES),
  source: z.string().regex(MESSAGE_REF),
  target: z.string().regex(MESSAGE_REF),
  status: z.enum(RELATION_STATUSES),
  needs_review: z.boolean().optional(),
  origin: z.enum(["human", "ai"]),
  created_by: z.string().regex(USER_ID),
  created_at: z.string().min(1),
  validated_by: z.string().regex(USER_ID).nullish(),
  validated_at: z.string().min(1).nullish(),
}).refine((data) => data.source !== data.target);

function frontmatter(content: string) {
  const { yaml, body } = splitFrontmatter(content);
  if (yaml === null) return null;
  const doc = parseDocument(yaml);
  return doc.errors.length ? null : { doc, body, data: doc.toJS() as unknown };
}

export type ParsedGenerator = { doc: Document; generator: GeneratorRecord; description: string };

/** Invalid YAML, slug, visibility or owner → null (the file is ignored, never repaired). */
export function parseGenerator(content: string): ParsedGenerator | null {
  const parsed = frontmatter(content);
  const result = parsed && generatorSchema.safeParse(parsed.data);
  if (!parsed || !result?.success) return null;
  const data = result.data;
  return {
    doc: parsed.doc, description: parsed.body.trim(),
    generator: { id: data.id, slug: data.slug, title: data.title ?? data.slug, ownerId: data.owner_id, visibility: data.visibility, createdAt: data.created_at ?? null },
  };
}

export function serializeGenerator(generator: GeneratorRecord, description = "", doc = new Document({})) {
  setFields(doc, {
    id: generator.id, slug: generator.slug, title: generator.title, owner_id: generator.ownerId, visibility: generator.visibility,
    created_at: generator.createdAt,
  });
  return withBody(doc, description);
}

export type ParsedRelation = { doc: Document; relation: RelationRecord; note: string };

export function parseRelation(content: string): ParsedRelation | null {
  const parsed = frontmatter(content);
  const result = parsed && relationSchema.safeParse(parsed.data);
  if (!parsed || !result?.success) return null;
  const data = result.data;
  return {
    doc: parsed.doc, note: parsed.body.trim(),
    relation: {
      id: data.id, type: data.type, source: data.source, target: data.target, status: data.status, needsReview: data.needs_review ?? false,
      origin: data.origin, createdBy: data.created_by, createdAt: data.created_at, validatedBy: data.validated_by ?? null,
      validatedAt: data.validated_at ?? null,
    },
  };
}

/** Writes the known fields into `doc` (other keys untouched); null removes a field. */
export function serializeRelation(relation: RelationRecord, note = "", doc = new Document({})) {
  setFields(doc, {
    id: relation.id, type: relation.type, source: relation.source, target: relation.target, status: relation.status,
    needs_review: relation.needsReview, origin: relation.origin, created_by: relation.createdBy, created_at: relation.createdAt,
    validated_by: relation.validatedBy, validated_at: relation.validatedAt,
  });
  return withBody(doc, note);
}

export function setFields(doc: Document, values: Record<string, string | number | boolean | null>) {
  if (!doc.contents) doc.contents = doc.createNode({}) as Document["contents"];
  for (const [key, value] of Object.entries(values)) {
    if (value === null) doc.delete(key);
    else doc.set(key, value);
  }
}

function withBody(doc: Document, body: string) {
  const trimmed = body.trim();
  return `---\n${doc.toString({ lineWidth: 0 })}---\n${trimmed ? `\n${trimmed}\n` : ""}`;
}

/** `<publicationUuid>/<n>` → its parts; null when malformed. */
export function splitMessageRef(ref: string): { publicationId: string; n: number } | null {
  const match = MESSAGE_REF.exec(ref);
  return match ? { publicationId: match[1], n: Number(match[2]) } : null;
}
