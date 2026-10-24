import { notFound } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { DeploymentView } from "@/components/xiagents/deployment-view";
import { getCurrentUser } from "@/lib/current-user";
import { TopicError } from "@/lib/topics/types";
import { getDeployments } from "@/lib/xiagents/services";
export const metadata = { title: "Ξ | Déploiement" };
export const dynamic = "force-dynamic";
export default async function DeploymentPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  const deployment = await (await getDeployments()).get(user.id, (await params).id).catch(error => { if (error instanceof TopicError && error.status === 404) notFound(); throw error; });
  return <><PageHeader title="Déploiement" back={{ href: "/dashboard/xiagents", label: "Retour aux ΞAgents" }} /><DeploymentView initial={deployment} /></>;
}
