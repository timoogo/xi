import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { deploymentTitle } from "@/components/xiagents/deployment-view";
import { getCurrentUser } from "@/lib/current-user";
import { getDeployments } from "@/lib/xiagents/services";
export const metadata = { title: "Ξ | Déploiements" };
export const dynamic = "force-dynamic";
const LABEL = { pending: "En attente", running: "En cours", completed: "Déployé", failed: "Échec" } as const;
export default async function DeploymentsPage() {
  const user = await getCurrentUser();
  const deployments = await (await getDeployments()).list(user.id);
  return <><PageHeader title="Déploiements" back={{ href: "/dashboard/xiagents", label: "Retour aux ΞAgents" }} />
    <div className="p-4 pb-24">
      {!deployments.length ? <p>Aucun déploiement.</p> : <ul className="divide-y rounded-xl border">
        {deployments.map(item => <li key={item.id}><Link href={`/dashboard/xiagents/deployments/${item.id}`} className="flex flex-wrap items-center gap-2 p-3 hover:bg-muted">
          <span className="font-medium">{deploymentTitle(item)}</span>
          <span className={item.state === "failed" ? "text-destructive" : "text-muted-foreground"}>{LABEL[item.state]}</span>
          <span className="ml-auto text-xs text-muted-foreground">{new Date(item.createdAt).toLocaleString("fr-FR")} · {item.steps.filter(step => step.status === "completed").length}/{item.steps.length} étapes</span>
        </Link></li>)}
      </ul>}
    </div></>;
}
