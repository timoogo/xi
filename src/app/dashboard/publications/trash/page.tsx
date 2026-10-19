import type { Metadata } from "next";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { formatDate, PublicationBadges } from "@/components/publications/publication-badges";
import { RestoreButton } from "@/components/publications/publication-actions";
import { getCurrentUser } from "@/lib/current-user";
import { getPublicationStore } from "@/lib/publications/server";

export const metadata: Metadata = { title: "Ξ | Corbeille", description: "Vos publications supprimées." };

export default async function TrashPage() {
  const user = await getCurrentUser();
  const items = await (await getPublicationStore()).listTrash(user);
  return (
    <>
      <PageHeader title="Corbeille" subtitle="Visible par vous uniquement, rien n’est purgé automatiquement" back={{ href: "/dashboard/publications", label: "Retour aux publications" }} />
      {items.length === 0 ? <EmptyState title="La corbeille est vide" description="Les publications supprimées apparaissent ici et peuvent être restaurées." /> : (
        <ul aria-label="Publications supprimées">
          {items.map((item) => (
            <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
              <div className="min-w-0 flex-1 space-y-2">
                <p className="break-words text-[15px]">{item.excerpt || <span className="text-muted-foreground">Brouillon sans titre</span>}</p>
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <PublicationBadges {...item} /><span>Supprimée le {formatDate(item.trashedAt)}</span>
                </div>
              </div>
              <RestoreButton id={item.id} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
