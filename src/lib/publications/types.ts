export const VISIBILITIES = ["private", "followers", "public"] as const;
export type Visibility = (typeof VISIBILITIES)[number];
export type PublicationStatus = "draft" | "published";
export type PublicationKind = "post" | "thread";
// Only humans author publications in this phase; "ai" is reserved for future generators.
export type AuthorType = "human" | "ai";

/** Frontmatter of index.md: the file is the source of truth, SQLite only indexes it. */
export type PublicationMeta = {
  id: string;
  type: PublicationKind;
  authorType: AuthorType;
  authorId: string;
  status: PublicationStatus;
  visibility: Visibility;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  score: number | null;
};

export type SourceSummary = { file: string; title: string; url: string | null; publisher: string | null };

/** What the application exposes about a publication: never an absolute path. */
export type PublicationSnapshot = PublicationMeta & {
  summary: string;
  messages: { file: string; body: string }[];
  sources: SourceSummary[];
  revision: string;
};

export type TrashItem = Pick<PublicationMeta, "id" | "type" | "status" | "visibility"> & { excerpt: string; trashedAt: string };

export type Viewer = { id: string };
