import type { Metadata } from "next";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";

export const metadata: Metadata = { title: "Ξ | Explorer", description: "L’exploration n’est pas encore disponible." };

export default function ExplorePage() {
  return (
    <>
      <PageHeader title="Explorer" />
      <EmptyState title="L’exploration arrive bientôt" description="La recherche, les sujets et les générateurs de veille ne sont pas encore disponibles. Les publications publiques des membres apparaissent déjà dans votre fil d’accueil." />
    </>
  );
}
