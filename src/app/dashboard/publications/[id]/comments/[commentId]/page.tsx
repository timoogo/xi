import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { z } from "zod";
import { PageHeader } from "@/components/page-header";
import { LivePublication } from "@/components/publications/live-publication";
import { getComment } from "@/lib/comments/server";
import { getCurrentUser } from "@/lib/current-user";
import { getFeedAuthors, getPublicationStore, orNotFound } from "@/lib/publications/server";

export const metadata: Metadata = { title: "Ξ | Conversation" };
export default async function CommentPage({ params }: { params: Promise<{ id: string; commentId: string }> }) {
  const [{ id, commentId }, user] = await Promise.all([params, getCurrentUser()]);
  const publication = await orNotFound(async () => (await getPublicationStore()).get(user, id));
  if (!z.uuid().safeParse(commentId).success || !getComment(id, commentId)) notFound();
  const authors = await getFeedAuthors(user, [publication.authorId]);
  return <>
    <PageHeader title="Conversation" back={{ href: `/dashboard/publications/${id}`, label: "Retour à la publication" }} />
    <LivePublication initial={publication} initialAuthors={Object.fromEntries(authors)} viewerId={user.id} focusedCommentId={commentId} />
  </>;
}
