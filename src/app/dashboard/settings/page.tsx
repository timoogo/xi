import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { AvatarSettings } from "@/components/avatar-settings";
import { getCurrentUser } from "@/lib/current-user";

export const metadata: Metadata = { title: "Ξ | Paramètres du compte" };

export default async function SettingsPage() {
  const user = await getCurrentUser();
  return <>
    <PageHeader title="Paramètres du compte" back={{ href: "/dashboard/profile", label: "Retour au profil" }} />
    <AvatarSettings name={user.name} image={user.image} avatar={user.avatar} />
  </>;
}
