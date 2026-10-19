import Link from "next/link";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";

export default function PublicationNotFound() {
  return (
    <>
      <PageHeader title="Publication" back={{ href: "/dashboard", label: "Retour à l’accueil" }} />
      <EmptyState title="Publication indisponible" description="Cette publication n’existe pas, n’est pas partagée avec vous ou a été mise à la corbeille. Si vous l’avez supprimée, vous pouvez la restaurer depuis votre corbeille." />
      <p className="flex justify-center gap-4 text-[15px]">
        <Link href="/dashboard" className="text-chart-2 hover:underline">Retour à l’accueil</Link>
        <Link href="/dashboard/publications/trash" className="text-muted-foreground hover:text-foreground">Ouvrir la corbeille</Link>
      </p>
    </>
  );
}
