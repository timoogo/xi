import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { PublicationFeed } from "@/components/publications/publication-feed";
import { UserAvatar } from "@/components/user-avatar";
import { getCurrentUser } from "@/lib/current-user";

export const metadata: Metadata = { title: "Ξ | Profil", description: "Votre espace Ξ privé." };

export default async function ProfilePage({ searchParams }: { searchParams: Promise<{ cursor?: string | string[] }> }) {
  const [user, { cursor }] = await Promise.all([getCurrentUser(), searchParams]);
  return (
    <>
      <PageHeader title={user.name} subtitle="Votre profil" />
      <section aria-label="Votre profil" className="border-b px-4 pb-4 pt-5">
        <UserAvatar image={user.image} name={user.name} size={88} />
        <h2 className="mt-3 break-words text-xl font-extrabold leading-6">{user.name}</h2>
        <p className="text-[15px] text-muted-foreground">{user.handle}</p>
        <dl className="mt-3 text-[15px]">
          <dt className="sr-only">Email du compte</dt>
          <dd className="break-all">{user.email}</dd>
        </dl>
        <p className="mt-1 text-[13px] text-muted-foreground">Votre email n’est visible que par vous.</p>
      </section>
      <h2 className="border-b px-4 py-3 text-[15px] font-bold">Publications</h2>
      <PublicationFeed viewer={user} scope={{ kind: "author", authorId: user.id }} cursor={typeof cursor === "string" ? cursor : undefined}
        path="/dashboard/profile" label="Vos publications publiées"
        empty={{ title: "Rien de publié pour l’instant", description: "Il n’y a encore aucune publication. Vos publications publiées apparaissent ici ; les brouillons sont dans Publications." }} />
    </>
  );
}
