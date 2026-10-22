import { publicationResponse } from "@/lib/publications/http";
import { getFeedAuthors } from "@/lib/publications/server";
import { PublicationError, type FeedScope } from "@/lib/publications/store";
import { USER_ID } from "@/lib/publications/vault";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  return publicationResponse(async (store, viewer) => {
    const tab = params.get("tab") ?? "for-you";
    const author = params.get("author");
    const kind = params.get("kind");
    if (!["for-you", "following"].includes(tab) || (author && !USER_ID.test(author))) {
      throw new PublicationError("invalid", "Fil invalide.");
    }
    const scope: FeedScope = author ? { kind: "author", authorId: author }
      : kind === "own" ? { kind: "own" } : { kind: "home", tab: tab as "for-you" | "following" };
    const result = await store.page(viewer, scope, params.get("cursor"));
    return { ...result, authors: Object.fromEntries(await getFeedAuthors(viewer, result.items.map(item => item.authorId))) };
  });
}
