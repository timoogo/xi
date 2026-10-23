import { PageHeader } from "@/components/page-header";
import { AccountManager } from "@/components/accounts/account-manager";
import { getCurrentUser } from "@/lib/current-user";
export const metadata = { title: "Ξ | Comptes éditoriaux" };
export default async function AccountsPage() { const user = await getCurrentUser(); return <><PageHeader title="Comptes éditoriaux" subtitle="Presets versionnés · validation humaine · sans modèle IA" /><AccountManager owner={user.id} /></>; }
