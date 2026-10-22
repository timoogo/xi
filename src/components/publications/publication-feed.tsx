import Link from "next/link";
import { PublicationError } from "@/lib/publications/store";
import { LiveFeed } from "./live-feed";
import { EmptyState } from "@/components/empty-state";
import { getFeedAuthors, getPublicationStore } from "@/lib/publications/server";
import type { FeedScope } from "@/lib/publications/store";
import type { Viewer } from "@/lib/publications/types";
import { PublicationCard } from "./publication-card";

/** A column of readable publications, one page at a time (`?cursor=`), newest first. */
export async function PublicationFeed({ viewer, scope, cursor, path, label, empty }: {
  viewer: Viewer;
  scope: FeedScope;
  cursor?: string;
  path: string;
  label: string;
  empty: { title: string; description: string };
}) {
  const store = await getPublicationStore();
  const { items, nextCursor } = await store.page(viewer, scope, cursor).catch(error => {
    if (error instanceof PublicationError && error.code === "stale_cursor") return store.page(viewer, scope);
    throw error;
  });
  const authors = await getFeedAuthors(viewer, items.map((item) => item.authorId));
  if (scope.kind === "home") return <section aria-label={label}><LiveFeed empty={empty} key={scope.tab ?? "for-you"} initial={{ items, nextCursor, authors: Object.fromEntries(authors) }} tab={scope.tab ?? "for-you"} viewerId={viewer.id} /></section>;
  if (!items.length && !cursor) return <EmptyState title={empty.title} description={empty.description} />;
  return (
    <section aria-label={label}>
      {items.map((item) => <PublicationCard key={item.id} publication={item} author={authors.get(item.authorId)} viewerId={viewer.id} />)}
      {!items.length ? <p className="border-b p-6 text-center text-[15px] text-muted-foreground">Aucune publication plus ancienne.</p> : null}
      {nextCursor || cursor ? (
        <nav aria-label={`${label} : pages`} className="flex justify-between gap-3 border-b px-4 py-4 text-[15px]">
          {cursor ? <Link href={path} className="text-muted-foreground hover:text-foreground">← Plus récentes</Link> : <span />}
          {nextCursor ? <Link href={`${path}${path.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(nextCursor)}`} className="font-medium text-chart-2 hover:underline">Publications précédentes →</Link> : null}
        </nav>
      ) : null}
    </section>
  );
}
