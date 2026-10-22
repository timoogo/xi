import Link from "next/link";
import type { SourceSummary } from "@/lib/publications/types";
import { conversationTree, messageAnchor, type ConversationMessage } from "@/lib/publications/conversation";
import { UserAvatar } from "@/components/user-avatar";
import { MarkdownView } from "./markdown-view";
import { PublicationPanel } from "./publication-panel";
import { ConversationBranch } from "./conversation-branch";
import { MessageMenu } from "./message-menu";
import { messageHref } from "./message-links";
import { FeedArticle } from "./feed-article";
import { formatShortDate } from "./publication-badges";
import { ReplyBranch } from "./conversation-view";

export { messageAnchor } from "@/lib/publications/conversation";
const FEED_MESSAGES = 3;
const FEED_CHARACTERS = 1_500;

export function PublicationContent({ summary, messages, sources, fullHref, publicationId, author, messageRefs, replies, date, visibility }: {
  summary: string;
  messages: (ConversationMessage & { updatedAt?: string; createdAt?: string; replyCount?: number; deleted?: boolean })[];
  sources: SourceSummary[];
  fullHref?: string;
  sourcesOpen?: boolean;
  publicationId?: string;
  author?: { name: string; image?: string | null; id?: string; handle?: string; ai?: boolean };
  messageRefs?: string[];
  date?: string;
  visibility?: string;
  replies?: Record<string, { count: number; content: React.ReactNode }>;
}) {
  const written = messages.map(message => ({ ...message, body: message.body.replace(/(?:^|\n+)#{1,6}[ \t]+Sources[ \t]*\s*$/i, "") })).filter(message => message.deleted || message.body.trim());
  const { main, branches } = conversationTree(written, publicationId);
  const shown = fullHref ? main.slice(0, FEED_MESSAGES) : main;
  const hidden = main.length - shown.length;
  const isLong = (text: string) => !!fullHref && text.length > FEED_CHARACTERS;
  function renderMessage(message: typeof written[number], index: number, siblings: number, depth = 0): React.ReactNode {
    const children = branches.get(message.key) ?? [];
    const anchor = messageAnchor(message.key);
    const ref = publicationId && anchor ? `${publicationId}/${anchor.slice(2)}` : undefined;
    const href = ref ? messageHref(ref) : fullHref;
    if (message.deleted) return <li key={message.key} id={anchor ?? undefined} className="scroll-mt-24 py-3"><p className="text-sm text-muted-foreground">Ce message a été supprimé</p>{ref ? <ReplyBranch messageRef={ref} depth={0} count={message.replyCount} initialOpen /> : null}</li>;
    return <li key={message.key} id={fullHref ? undefined : anchor ?? undefined} className="relative min-w-0 scroll-mt-24 target:bg-chart-2/10">
      <FeedArticle href={fullHref ? href : undefined} label={`Message de ${author?.name ?? "l’auteur"}`} className="flex gap-3">
        {author ? <div className="relative flex w-8 shrink-0 flex-col items-center pt-3"><UserAvatar name={author.name} image={author.image} size={32} />{index < siblings - 1 ? <span aria-hidden="true" className="absolute bottom-0 top-12 w-px bg-border" /> : null}</div> : null}
        <div className={`min-w-0 flex-1 pb-3 pt-3 ${index ? "border-t border-border/60" : ""}`}>
          {author ? <header className="mb-1 flex flex-wrap items-center gap-x-1 text-sm">
            <Link href={`/dashboard/profiles/${author.id ?? ""}`} className="font-semibold hover:underline">{author.name}</Link>
            {author.ai ? <span className="rounded border px-1 text-xs" aria-label="Générateur IA">IA</span> : null}
            {author.handle ? <span className="text-muted-foreground">{author.handle}</span> : null}
            {date && href ? <Link href={href} className="text-muted-foreground hover:underline"><time dateTime={message.createdAt ?? date}>{formatShortDate(message.createdAt ?? date)}</time></Link> : null}
            {message.updatedAt && message.createdAt && message.updatedAt !== message.createdAt ? <span className="text-xs text-muted-foreground">Modifié</span> : null}
            {visibility && visibility !== "public" ? <span className="text-xs text-muted-foreground">{visibility === "followers" ? "Abonnés" : "Privé"}</span> : null}
            {ref ? <MessageMenu messageRef={ref} sources={sources} /> : null}
          </header> : ref ? <div className="flex justify-end"><MessageMenu messageRef={ref} sources={sources} /></div> : null}
          <Clamped long={isLong(message.body)}><MarkdownView markdown={message.body} /></Clamped>
          {!fullHref && anchor && replies?.[anchor] ? <ConversationBranch anchors={[]} count={replies[anchor].count}>{replies[anchor].content}</ConversationBranch> : null}
          {!fullHref && ref ? <ReplyBranch messageRef={ref} depth={0} count={message.replyCount ?? children.length} /> : !fullHref && children.length ? <ConversationBranch anchors={children.map(child => messageAnchor(child.key)).filter((value): value is string => !!value)} count={children.length}>
            {depth >= 2 && href ? <Link href={href} className="text-chart-2 underline">Voir la sous-conversation</Link> : <ol aria-label="Réponses" className="mt-3 border-l border-border pl-2 sm:pl-3">{children.map((child, i) => renderMessage(child, i, children.length, depth + 1))}</ol>}
          </ConversationBranch> : null}
        </div>
      </FeedArticle>
    </li>;
  }
  return <div className="space-y-3">
    {summary.trim() ? <Clamped long={isLong(summary)}><MarkdownView markdown={summary} /></Clamped> : null}
    {shown.length ? <ol aria-label={written.length > 1 ? "Fil principal" : "Message"}>{shown.map((message, index) => renderMessage(message, index, shown.length))}</ol> : null}
    {fullHref && hidden > 0 ? <Link href={fullHref} className="inline-block text-[15px] font-medium text-chart-2 hover:underline">Afficher la suite ({hidden} message{hidden > 1 ? "s" : ""})</Link> : null}
    <PublicationPanel sources={sources} messageRefs={messageRefs} preview={summary || shown[0]?.body} />
    {!summary.trim() && !written.length ? <p className="text-muted-foreground">Rien d’écrit pour l’instant.</p> : null}
  </div>;
}

function Clamped({ long, children }: { long: boolean; children: React.ReactNode }) {
  return long ? <div className="max-h-80 overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]">{children}</div> : <>{children}</>;
}
