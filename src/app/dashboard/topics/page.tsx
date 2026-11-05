import { KonstruktorPanel } from "@/components/konstruktor/konstruktor-panel";
import { PageHeader } from "@/components/page-header";
import { TopicCandidates } from "@/components/topics/topic-candidates";
import { TopicManager } from "@/components/topics/topic-manager";
import { getCurrentUser } from "@/lib/current-user";
import { getDiscoveryRecords } from "@/lib/topics/server";
export const metadata = { title: "Ξ | Gestion des topics" };
export default async function TopicsPage() {
  const [user, candidates] = await Promise.all([getCurrentUser(), getDiscoveryRecords().then(store => store.candidates())]);
  return <><PageHeader title="Gestion des topics" subtitle="Hiérarchie partagée · intentions privées" /><KonstruktorPanel target={{ type: "new-topic", id: null }} intro="Décrivez le topic à créer : Konstruktor cherche les topics existants et propose une étiquette et un périmètre." /><TopicManager owner={user.id} /><TopicCandidates candidates={candidates} /></>;
}
