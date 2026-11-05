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
  return <><PageHeader title="Propositions de Konstruktor" /><SuggestionInbox focus={suggestion ?? null} filter={filter} /></>;
}
