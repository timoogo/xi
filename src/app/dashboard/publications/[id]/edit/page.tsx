import type { Metadata } from "next";
import { PublicationEditor } from "@/components/publications/publication-editor";
import { getCurrentUser } from "@/lib/current-user";
import { getPublicationStore, orNotFound } from "@/lib/publications/server";

export const metadata: Metadata = { title: "Ξ | Éditeur" };

export default async function EditPublicationPage({ params }: { params: Promise<{ id: string }> }) {
  const [{ id }, user] = await Promise.all([params, getCurrentUser()]);
  const publication = await orNotFound(async () => (await getPublicationStore()).getEditable(user, id));
  // Keyed by revision: reopening the editor always starts from the files.
  return <PublicationEditor key={publication.revision} initial={publication} />;
}
