import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { AvatarSettings } from "@/components/avatar-settings";
import { LLMSettings } from "@/components/llm/llm-settings";
import { getCurrentUser } from "@/lib/current-user";
import { getLLMRuntime } from "@/lib/llm/server";

export const metadata: Metadata = { title: "Ξ | Paramètres du compte" };

export default async function SettingsPage() {
  const user = await getCurrentUser();
  const llm = await getLLMRuntime();
  // Owner-scoped: only this account's instances; the operator's server is described without its URL.
  const [instances, settings] = await Promise.all([llm.store.list(user.id), llm.store.settings(user.id)]);
  return <>
    <PageHeader title="Paramètres du compte" back={{ href: "/dashboard/profile", label: "Retour au profil" }} />
    <AvatarSettings name={user.name} image={user.image} avatar={user.avatar} />
    <LLMSettings initial={{ instances, settings, environment: llm.environment() }} />
  </>;
}
