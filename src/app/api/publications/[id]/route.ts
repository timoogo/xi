import { publicationResponse } from "@/lib/publications/http";
import { getFeedAuthors } from "@/lib/publications/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return publicationResponse(async (store, viewer) => {
    const publication = await store.get(viewer, id);
    return { publication, authors: Object.fromEntries(await getFeedAuthors(viewer, [publication.authorId])) };
  });
}
