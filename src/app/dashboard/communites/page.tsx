import type { Metadata } from "next";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";

export const metadata: Metadata = { title: "Ξ | Communautés", description: "Les communautés ne sont pas encore disponibles." };

export default function CommunitiesPage() {
  return (
    <>
      <PageHeader title="Communautés" />
      <EmptyState title="Les communautés ne sont pas encore disponibles" description="Ce MVP ne permet pas encore de découvrir ni de suivre d’autres comptes." />
    </>
  );
}
