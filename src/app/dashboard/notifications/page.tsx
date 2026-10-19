import type { Metadata } from "next";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";

export const metadata: Metadata = { title: "Ξ | Notifications", description: "Les notifications ne sont pas encore disponibles." };

export default function NotificationsPage() {
  return (
    <>
      <PageHeader title="Notifications" />
      <EmptyState title="Les notifications ne sont pas encore disponibles" description="Ξ ne génère pas encore de notifications. Elles apparaîtront ici lorsque les interactions sociales existeront." />
    </>
  );
}
