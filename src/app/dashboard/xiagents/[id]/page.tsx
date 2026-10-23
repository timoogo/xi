import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/current-user";
import { getAccountStore } from "@/lib/accounts/server";
import { getTopicStore } from "@/lib/topics/server";
import { TopicError } from "@/lib/topics/types";
import { PageHeader } from "@/components/page-header";
import { BloubAvatar } from "@/components/bloub-avatar";
import { ManualGenerator } from "@/components/xiagents/manual-generator";
import { PublicationFeed } from "@/components/publications/publication-feed";
export const metadata = { title: "Ξ | Gestion du ΞAgent" };
export default async function XiAgentPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ cursor?: string }> }) {
  const user = await getCurrentUser();
  const { id } = await params;
  const account = await (await getAccountStore()).getOwned(user.id, id).catch(error => { if (error instanceof TopicError && error.status === 404) notFound(); throw error; });
  const topics = await (await getTopicStore()).list();
  const topicIds = account.editorial ? [account.editorial.primaryTopicId, ...account.editorial.secondaryTopicIds] : [];
  const { cursor } = await searchParams;
  return <>
    <PageHeader title={account.name} back={{ href: "/dashboard/xiagents", label: "Retour aux ΞAgents" }} />
    <section className="space-y-3 border-b p-4">
      <div className="flex items-center gap-3"><BloubAvatar name={account.name} size={64} /><div className="min-w-0"><h1 className="break-words text-xl font-bold">{account.name}</h1><p className="break-all text-muted-foreground">@{account.handle}</p></div></div>
      <p className="whitespace-pre-wrap break-words">{account.description}</p>
      <p className="text-sm">Topics : {topicIds.map(id => topics.find(topic => topic.id === id)?.tag ?? "Topic indisponible").join(" · ") || "Aucun topic associé"}</p>
      <Link href={`/dashboard/profiles/${id}`} className="text-sm underline">Voir le profil</Link>
    </section>
    {account.editorial?.active ? <ManualGenerator agentId={id} revision={account.editorial.revision} /> : <p className="p-4">Complétez et activez ce ΞAgent depuis la liste pour utiliser le générateur.</p>}
    <h2 className="border-b p-4 text-lg font-bold">Historique des publications</h2>
    <PublicationFeed showPublicationLinks viewer={user} scope={{ kind: "author", authorId: id }} cursor={typeof cursor === "string" ? cursor : undefined} path={`/dashboard/xiagents/${id}`} label="Publications du ΞAgent" empty={{ title: "Aucune publication", description: "Générez un aperçu, puis choisissez sa visibilité et confirmez sa publication." }} />
  </>;
}
