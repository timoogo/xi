import Link from "next/link";
import type { SourceSummary } from "@/lib/publications/types";
import { MarkdownView } from "./markdown-view";

// Beyond these, a feed card shows the beginning and links to the full page.
const FEED_MESSAGES = 3;
const FEED_CHARACTERS = 1_500;

/** `m-<n>` for a message file `{n}_{slug}.md` (the graph links to `#m-<n>`); null for unsaved editor messages. */
export function messageAnchor(key: string): string | null {
  const match = /^([1-9]\d*)_/.exec(key.split("/").pop() ?? "");
  return match ? `m-${match[1]}` : null;
}

/**
 * Read-only rendering shared by feed cards, the publication page and the editor preview.
 * With `fullHref`, long threads and long messages are shortened for the feed.
 */
export function PublicationContent({ summary, messages, sources, fullHref, sourcesOpen = false }: {
  summary: string;
  messages: { key: string; body: string }[];
  sources: SourceSummary[];
  fullHref?: string;
  sourcesOpen?: boolean;
}) {
  // The empty "## Sources" heading of the message template is not content.
  const written = messages
    .map((message) => ({ ...message, body: message.body.replace(/(?:^|\n+)#{1,6}[ \t]+Sources[ \t]*\s*$/i, "") }))
    .filter((message) => message.body.trim());
  const shown = fullHref ? written.slice(0, FEED_MESSAGES) : written;
  const hidden = written.length - shown.length;
  const isLong = (text: string) => !!fullHref && text.length > FEED_CHARACTERS;
  const thread = written.length > 1;
  return (
    <div className="space-y-3">
      {summary.trim() ? <Clamped long={isLong(summary)}><MarkdownView markdown={summary} /></Clamped> : null}
      {shown.length ? (
        <ol aria-label={thread ? "Fil" : "Message"} className={thread ? "space-y-4 border-l-2 border-border pl-4" : "space-y-3"}>
          {shown.map((message, index) => (
            // Anchors only outside the feed: several cards on one page would duplicate the ids.
            <li key={message.key} id={fullHref ? undefined : messageAnchor(message.key) ?? undefined} className="scroll-mt-16 target:rounded-md target:bg-chart-2/10 target:ring-4 target:ring-chart-2/10">
              {thread ? <p className="mb-0.5 text-xs font-semibold tabular-nums text-muted-foreground">{index + 1}/{written.length}</p> : null}
              <Clamped long={isLong(message.body)}><MarkdownView markdown={message.body} /></Clamped>
            </li>
          ))}
        </ol>
      ) : null}
      {fullHref && (hidden > 0 || [summary, ...shown.map((message) => message.body)].some(isLong)) ? (
        <Link href={fullHref} className="inline-block text-[15px] font-medium text-chart-2 hover:underline">
          {hidden > 0 ? `Lire le fil complet (${hidden} message${hidden > 1 ? "s" : ""} de plus)` : "Afficher la suite"}
        </Link>
      ) : null}
      {sources.length ? (
        <details open={sourcesOpen} className="group text-sm">
          <summary className="cursor-pointer list-none text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
            <span className="group-open:hidden">▸</span><span className="hidden group-open:inline">▾</span> Sources ({sources.length})
          </summary>
          <ul className="mt-2 space-y-1 border-l-2 border-border pl-4">
            {sources.map((source) => (
              <li key={source.file} className="break-words">
                {source.url ? <a href={source.url} target="_blank" rel="noopener noreferrer nofollow" className="text-chart-2 underline underline-offset-2">{source.title}</a> : source.title}
                {source.publisher ? <span className="text-muted-foreground"> — {source.publisher}</span> : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {!summary.trim() && !written.length ? <p className="text-muted-foreground">Rien d’écrit pour l’instant.</p> : null}
    </div>
  );
}

function Clamped({ long, children }: { long: boolean; children: React.ReactNode }) {
  if (!long) return <>{children}</>;
  return <div className="max-h-80 overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]">{children}</div>;
}
