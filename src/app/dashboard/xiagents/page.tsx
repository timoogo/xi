import { PageHeader } from "@/components/page-header";
import { AccountManager } from "@/components/accounts/account-manager";
import { getCurrentUser } from "@/lib/current-user";
export const metadata = { title: "Ξ | ΞAgents" };
export default async function XiAgentsPage({ searchParams }: { searchParams: Promise<{ duplicate?: string | string[] }> }) {
  const user = await getCurrentUser();
  const { duplicate } = await searchParams;
  return <><PageHeader title="ΞAgents" subtitle="Vos identités éditoriales · validation humaine" /><AccountManager owner={user.id} duplicateId={typeof duplicate === "string" && /^[0-9a-f-]{36}$/.test(duplicate) ? duplicate : undefined} /></>;
}
