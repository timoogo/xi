import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { SuggestionInbox } from "@/components/konstruktor/suggestion-inbox";
import { getCurrentUser } from "@/lib/current-user";
export const metadata = { title: "Ξ | Propositions de Konstruktor" };
export const dynamic = "force-dynamic";

/** The session user's Konstruktor suggestions, apart from the editorial feed. */
export default async function KonstruktorInboxPage({ searchParams }: { searchParams: Promise<{ suggestion?: string; type?: string; id?: string }> }) {
  await getCurrentUser();
  const { suggestion, type, id } = await searchParams;
  const filter = (type === "agent" || type === "topic") && id ? { type, id } as const : null;
  return <><PageHeader title="Propositions de Konstruktor"><Link href="/dashboard/konstruktor/idea" className="ml-auto rounded-full border px-3 py-1 text-sm font-medium hover:bg-accent">Créer à partir d’une idée</Link><Link href="/dashboard/konstruktor/pipelines" className=" rounded-full border px-3 py-1 text-sm font-medium hover:bg-accent">Pipelines</Link></PageHeader><SuggestionInbox focus={suggestion ?? null} filter={filter} /></>;
}
