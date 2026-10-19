import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { Composer } from "@/components/publications/publication-actions";
import { PublicationFeed } from "@/components/publications/publication-feed";
import { getCurrentUser } from "@/lib/current-user";

export const metadata: Metadata = { title: "Ξ | Accueil", description: "Votre fil Ξ." };

export default async function HomePage({ searchParams }: { searchParams: Promise<{ cursor?: string | string[] }> }) {
  const [user, { cursor }] = await Promise.all([getCurrentUser(), searchParams]);
  return (
    <>
      <PageHeader title="Accueil" />
      {cursor ? null : <Composer user={{ name: user.name, image: user.image }} />}
      <PublicationFeed viewer={user} scope={{ kind: "home" }} cursor={typeof cursor === "string" ? cursor : undefined} path="/dashboard" label="Fil"
        empty={{ title: "Votre fil vous attend", description: "Il n’y a encore aucune publication. Rédigez la première : elle est enregistrée en Markdown dans votre vault Obsidian." }} />
    </>
  );
}
