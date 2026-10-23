export const VISIBILITIES = ["private", "followers", "public"] as const;
export type Visibility = (typeof VISIBILITIES)[number];
export type PublicationStatus = "draft" | "published";
export type PublicationKind = "post" | "thread";
// Human and generator publications share the same rendering contract.
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

export type SourceSummary = { file: string; title: string; url: string | null; publisher: string | null; date?: string | null; kinds?: string[]; excerpts?: string[]; claims?: string[]; reservations?: string[]; author?: string | null };

/** What the application exposes about a publication: never an absolute path. */
export type PublicationSnapshot = PublicationMeta & {
  summary: string;
  messages: { file: string; body: string; replyTo?: string | null; createdAt?: string; updatedAt?: string; deleted?: boolean; replyCount?: number }[];
  parentContext?: { publicationId: string; ref: string; excerpt: string } | null;
  sources: SourceSummary[];
  revision: string;
  /** A published analysis is immutable: it changes through dated corrections. */
  analysis?: boolean;
  /** The publication this one corrects, when the viewer may read it. */
  previousVersion?: string | null;
};

export type TrashItem = Pick<PublicationMeta, "id" | "type" | "status" | "visibility"> & { excerpt: string; trashedAt: string };

export type Viewer = { id: string; following?: readonly string[]; managedAgents?: readonly string[] };

/** Message identities are publication UUID / immutable file number. */
export type ConversationEntry = {
  ref: string;
  publicationId: string;
  message: PublicationSnapshot["messages"][number] | null;
  publication: PublicationSnapshot | null;
  deleted: boolean;
  replyCount: number;
};
export type ConversationPage = {
  parent: ConversationEntry;
  ancestors: ConversationEntry[];
  children: ConversationEntry[];
  nextCursor: string | null;
};
