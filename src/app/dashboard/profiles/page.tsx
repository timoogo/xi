import Link from "next/link";
import { normalizeHandle } from "@/lib/handle";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { AccountControls } from "@/components/publications/account-controls";
import { getCurrentUser } from "@/lib/current-user";
import { getAuthors, getPublicationStore } from "@/lib/publications/server";
import { getAppDatabase } from "@/lib/auth";

export default async function AccountsPage({ searchParams }: { searchParams: Promise<{ handle?: string }> }) {
  const { handle } = await searchParams;
  const viewer = await getCurrentUser();
  const store = await getPublicationStore();
  await store.reconcileAll();
  const [settings, generators] = await Promise.all([store.social(viewer), store.generators(viewer)]);
  // Discover humans only through their public publications, plus accounts already followed.
  const rows = getAppDatabase().prepare("SELECT DISTINCT author_id AS id FROM publication WHERE author_type = 'human' AND status = 'published' AND visibility = 'public' AND trashed_at IS NULL").all() as { id: string }[];
  const humans = [...getAuthors([...rows.map((row) => row.id), ...settings.following]).values()];
  const accounts = [...generators, ...humans].filter((account) => account.id !== viewer.id);
  if (handle) {
    const matches = accounts.filter((account) => normalizeHandle(account.handle) === normalizeHandle(handle));
    if (matches.length === 1) redirect(`/dashboard/profiles/${encodeURIComponent(matches[0].id)}`);
  }
  return <>
    <PageHeader title="Comptes et préférences" back={{ href: "/dashboard", label: "Retour au fil" }} />
    <p className="border-b p-4 text-sm text-muted-foreground">Choisissez explicitement les comptes que vous souhaitez suivre et leur place dans votre fil.</p>
    {handle ? <p role="status" className="p-4 text-sm">Ce handle ne correspond pas à un compte accessible unique.</p> : null}
    {accounts.length ? accounts.map((account) => <section key={account.id} className="border-b p-4">
      <Link href={`/dashboard/profiles/${encodeURIComponent(account.id)}`} className="break-words font-bold hover:underline">{account.name} <span className="font-normal text-muted-foreground">{account.handle}</span></Link>
      <AccountControls authorId={account.id} following={settings.following.includes(account.id)} preference={settings.preferences[account.id]} />
    </section>) : <p className="p-4 text-muted-foreground">Aucun compte à découvrir pour l’instant.</p>}
  </>;
}
