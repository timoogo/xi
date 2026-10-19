import { Trash2 } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { PublicationFeed } from "@/components/publications/publication-feed";
import { getCurrentUser } from "@/lib/current-user";

export const metadata: Metadata = { title: "Ξ | Publications", description: "Vos brouillons et publications." };

export default async function PublicationsPage({ searchParams }: { searchParams: Promise<{ cursor?: string | string[] }> }) {
  const [user, { cursor }] = await Promise.all([getCurrentUser(), searchParams]);
  return (
    <>
      <PageHeader title="Vos publications" subtitle="Brouillons et publications, en Markdown dans votre vault">
        <Link href="/dashboard/publications/trash" className="inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground">
          <Trash2 aria-hidden="true" className="size-4" />Corbeille
        </Link>
      </PageHeader>
      <PublicationFeed viewer={user} scope={{ kind: "own" }} cursor={typeof cursor === "string" ? cursor : undefined} path="/dashboard/publications" label="Vos publications"
        empty={{ title: "Aucune publication", description: "Créez une publication : les brouillons sont enregistrés automatiquement et restent privés jusqu’à leur publication." }} />
    </>
  );
}
