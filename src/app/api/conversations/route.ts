import { publicationResponse } from "@/lib/publications/http";
import { getFeedAuthors } from "@/lib/publications/server";
import { PublicationError } from "@/lib/publications/store";
import { MESSAGE_REF } from "@/lib/graph/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  return publicationResponse(async (store, viewer) => {
    const ref = params.get("ref") ?? "";
    if (!MESSAGE_REF.test(ref)) throw new PublicationError("invalid", "Message invalide.");
    const result = await store.conversation(viewer, ref, params.get("cursor"));
    const ids = [result.parent, ...result.ancestors, ...result.children]
      .flatMap(entry => entry.publication ? [entry.publication.authorId] : []);
    return { ...result, authors: Object.fromEntries(await getFeedAuthors(viewer, ids)) };
  });
}
