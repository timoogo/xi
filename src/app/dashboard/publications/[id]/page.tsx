import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { LivePublication } from "@/components/publications/live-publication";
import { getCurrentUser } from "@/lib/current-user";
import { getFeedAuthors, getPublicationStore, orNotFound } from "@/lib/publications/server";

export const metadata: Metadata = { title: "Ξ | Publication" };

export default async function PublicationPage({ params }: { params: Promise<{ id: string }> }) {
  const [{ id }, user] = await Promise.all([params, getCurrentUser()]);
  const publication = await orNotFound(async () => (await getPublicationStore()).get(user, id));
  const authors = await getFeedAuthors(user, [publication.authorId]);
  return (
    <>
      <PageHeader title={publication.type === "thread" ? "Fil" : "Publication"} back={{ href: "/dashboard", label: "Retour à l’accueil" }} />
      <LivePublication initial={publication} initialAuthors={Object.fromEntries(authors)} viewerId={user.id} />
    </>
  );
}
