import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { PublicationCard } from "@/components/publications/publication-card";
import { getCurrentUser } from "@/lib/current-user";
import { getAuthors, getPublicationStore, orNotFound } from "@/lib/publications/server";

export const metadata: Metadata = { title: "Ξ | Publication" };

export default async function PublicationPage({ params }: { params: Promise<{ id: string }> }) {
  const [{ id }, user] = await Promise.all([params, getCurrentUser()]);
  const publication = await orNotFound(async () => (await getPublicationStore()).get(user, id));
  return (
    <>
      <PageHeader title={publication.type === "thread" ? "Fil" : "Publication"} back={{ href: "/dashboard", label: "Retour à l’accueil" }} />
      <PublicationCard publication={publication} author={getAuthors([publication.authorId]).get(publication.authorId)} viewerId={user.id} full afterTrash="/dashboard/publications" />
    </>
  );
}
