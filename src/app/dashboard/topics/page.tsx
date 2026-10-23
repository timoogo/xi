import { PageHeader } from "@/components/page-header";
import { TopicManager } from "@/components/topics/topic-manager";
import { getCurrentUser } from "@/lib/current-user";
export const metadata = { title: "Ξ | Gestion des topics" };
export default async function TopicsPage() {
  const user = await getCurrentUser();
  return <><PageHeader title="Gestion des topics" subtitle="Hiérarchie partagée · intentions privées" /><TopicManager owner={user.id} /></>;
}
