import { notFound } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { UserAvatar } from "@/components/user-avatar";
import { AccountControls } from "@/components/publications/account-controls";
import { PublicationFeed } from "@/components/publications/publication-feed";
import { getCurrentUser } from "@/lib/current-user";
import { getFeedAuthors, getPublicationStore } from "@/lib/publications/server";

export default async function AccountPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ cursor?: string }> }) {
  const [{ id }, { cursor }, viewer] = await Promise.all([params, searchParams, getCurrentUser()]);
  const store = await getPublicationStore();
  const author = (await getFeedAuthors(viewer, [id])).get(id);
  if (!author) notFound();
  const settings = await store.social(viewer);
  return <>
    <PageHeader title={author.name} back={{ href: "/dashboard", label: "Retour au fil" }} />
    <section aria-label="Profil du compte" className="border-b p-4">
      <UserAvatar name={author.name} image={author.image} bloubSeed={author.bloubSeed} ai={author.ai} size={64} />
      <h2 className="mt-3 break-words text-xl font-bold">{author.name}</h2>
      <p className="break-words text-muted-foreground">{author.handle}</p>
      {author.description ? <p className="mt-3 whitespace-pre-wrap break-words text-sm">{author.description}</p> : null}
      {id !== viewer.id ? <AccountControls authorId={id} following={settings.following.includes(id)} preference={settings.preferences[id]} /> : null}
    </section>
    <PublicationFeed viewer={viewer} scope={{ kind: "author", authorId: id }} cursor={cursor} path={`/dashboard/profiles/${encodeURIComponent(id)}`} label={`Publications de ${author.name}`} empty={{ title: "Aucune publication accessible", description: "Les publications de ce compte apparaîtront ici." }} />
  </>;
}
