import { PageHeader } from "@/components/page-header";
import { AccountManager } from "@/components/accounts/account-manager";
import { getCurrentUser } from "@/lib/current-user";
export const metadata = { title: "Ξ | ΞAgents" };
export default async function XiAgentsPage() {
  const user = await getCurrentUser();
  return <><PageHeader title="ΞAgents" subtitle="Vos identités éditoriales · validation humaine" /><AccountManager owner={user.id} /></>;
}
