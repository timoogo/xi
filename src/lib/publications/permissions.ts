import type { PublicationMeta, Viewer } from "./types";

type Access = Pick<PublicationMeta, "authorType" | "authorId" | "status" | "visibility">;

function isAuthor(viewer: Viewer | null, publication: Access) {
  return !!viewer && publication.authorType === "human" && publication.authorId === viewer.id;
}

/**
 * Drafts are always private. Follower grants are resolved from the current Markdown subscriptions.
 * Trashed publications are only reachable through the author's trash.
 */
export function canRead(viewer: Viewer | null, publication: Access, trashed = false) {
  if (trashed) return false;
  if (isAuthor(viewer, publication)) return true;
  return !!viewer && publication.status === "published" && (publication.visibility === "public" || (publication.visibility === "followers" && viewer.following?.includes(publication.authorId) === true));
}

export function canEdit(viewer: Viewer | null, publication: Access, trashed = false) {
  return !trashed && isAuthor(viewer, publication);
}

export function canManageTrash(viewer: Viewer | null, publication: Access) {
  return isAuthor(viewer, publication);
}
