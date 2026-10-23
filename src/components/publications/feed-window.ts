import type { PublicationSnapshot } from "@/lib/publications/types";

export type FeedPage = {
  items: PublicationSnapshot[];
  authors: Record<string, { name: string; handle: string; bloubSeed?: string | null; image?: string | null }>;
  nextCursor: string | null;
};
export class FeedChanged extends Error {}

/** Rebuild a contiguous prefix, including every surviving entry already being read.
 * A fresh cursor always belongs to that prefix, so a burst larger than one page
 * cannot leave a gap between new entries and the older pages. Deleted anchors
 * simply cause us to reach the end of the current feed.
 */
export async function loadFeedWindow(
  fetchPage: (cursor: string | null) => Promise<FeedPage>,
  retainedIds: string[], minimum = 20,
): Promise<FeedPage> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const remaining = new Set(retainedIds);
    const items = new Map<string, PublicationSnapshot>();
    const authors: FeedPage["authors"] = {};
    const visited = new Set<string>();
    let cursor: string | null = null;
    try {
      do {
        const page = await fetchPage(cursor);
        for (const item of page.items) { items.set(item.id, item); remaining.delete(item.id); }
        Object.assign(authors, page.authors);
        cursor = page.nextCursor;
        if (cursor && visited.has(cursor)) throw new Error("Curseur de fil répété");
        if (cursor) visited.add(cursor);
      } while (cursor && (remaining.size > 0 || items.size < minimum));
      return { items: [...items.values()], authors, nextCursor: cursor };
    } catch (error) {
      if (!(error instanceof FeedChanged) || attempt === 2) throw error;
    }
  }
  throw new FeedChanged();
}
