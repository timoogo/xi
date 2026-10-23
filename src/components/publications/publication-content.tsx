import Link from "next/link";
import type { SourceSummary } from "@/lib/publications/types";
import { conversationTree, messageAnchor, type ConversationMessage } from "@/lib/publications/conversation";
import { UserAvatar } from "@/components/user-avatar";
import { MarkdownView } from "./markdown-view";
import { PublicationPanel } from "./publication-panel";
import { ConversationBranch } from "./conversation-branch";
import { MessageMenu, type OwnerActions } from "./message-menu";
import { messageHref } from "./message-links";
import { FeedArticle } from "./feed-article";
import { formatShortDate } from "./publication-badges";
import { ReplyBranch } from "./conversation-view";

export { messageAnchor } from "@/lib/publications/conversation";
const FEED_MESSAGES = 3;
const FEED_CHARACTERS = 1_500;

export function PublicationContent({ summary, messages, sources, fullHref, publicationId, author, messageRefs, replies, date, visibility, owner }: {
  owner?: OwnerActions;
  summary: string;
  messages: (ConversationMessage & { updatedAt?: string; createdAt?: string; replyCount?: number; deleted?: boolean })[];
  sources: SourceSummary[];
  fullHref?: string;
  sourcesOpen?: boolean;
  publicationId?: string;
  author?: { name: string; bloubSeed?: string | null; image?: string | null; id?: string; handle?: string; ai?: boolean };
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

    return <li key={message.key} id={fullHref ? undefined : anchor ?? undefined} className="relative min-w-0 scroll-mt-24 target:bg-chart-2/10">
      <FeedArticle href={fullHref ? href : undefined} label={`Message de ${author?.name ?? "l’auteur"}`} className="flex gap-3">
        {author ? <div className="relative flex w-10 shrink-0 flex-col items-center pt-2"><UserAvatar name={author.name} image={author.image} bloubSeed={author.bloubSeed} size={40} ai={author.ai} />{index < siblings - 1 ? <span aria-hidden="true" data-thread-connector className="absolute bottom-[-8px] top-[52px] w-0.5 bg-border" /> : null}</div> : null}
        <div className="min-w-0 flex-1 pb-3 pt-2">
          {author ? <header className="relative min-h-10 pr-11 flex flex-wrap content-center items-center gap-x-1 text-[15px] leading-5">
            <Link href={`/dashboard/profiles/${author.id ?? ""}`} className="max-w-full truncate font-bold hover:underline">{author.name}</Link>
            {author.handle ? <span className="max-w-full truncate text-muted-foreground">{author.handle}</span> : null}
            {date && href ? <><span aria-hidden="true" className="text-muted-foreground">·</span><Link href={href} className="text-muted-foreground hover:underline"><time dateTime={message.createdAt ?? date}>{formatShortDate(message.createdAt ?? date)}</time></Link></> : null}
            {message.updatedAt && message.createdAt && message.updatedAt !== message.createdAt ? <span className="text-xs text-muted-foreground">Modifié</span> : null}
            {visibility && visibility !== "public" ? <span className="text-xs text-muted-foreground">{visibility === "followers" ? "Abonnés" : "Privé"}</span> : null}
            {ref || owner ? <span className="absolute right-0 top-0"><MessageMenu messageRef={ref} sources={sources} owner={index === 0 ? owner : undefined} /></span> : null}
          </header> : ref ? <div className="flex justify-end"><MessageMenu messageRef={ref} sources={sources} /></div> : null}
          {index === 0 && depth === 0 && summary.trim() ? <div className="mb-3"><Clamped long={isLong(summary)}><MarkdownView markdown={summary} /></Clamped></div> : null}
          {message.deleted ? <p className="text-sm text-muted-foreground">Ce message a été supprimé</p> : <Clamped long={isLong(message.body)}><MarkdownView markdown={message.body} /></Clamped>}
          {!fullHref && anchor && replies?.[anchor] ? <ConversationBranch anchors={[]} count={replies[anchor].count}>{replies[anchor].content}</ConversationBranch> : null}
          {!fullHref && ref ? <ReplyBranch messageRef={ref} depth={0} count={message.replyCount ?? children.length} initialOpen={message.deleted} /> : !fullHref && children.length ? <ConversationBranch anchors={children.map(child => messageAnchor(child.key)).filter((value): value is string => !!value)} count={children.length}>
            {depth >= 2 && href ? <Link href={href} className="text-chart-2 underline">Voir la sous-conversation</Link> : <ol aria-label="Réponses" className="mt-3 border-l border-border pl-2 sm:pl-3">{children.map((child, i) => renderMessage(child, i, children.length, depth + 1))}</ol>}
          </ConversationBranch> : null}
        </div>
      </FeedArticle>
    </li>;
  }
  return <div>
    {!shown.length && (summary.trim() || author) ? <ol aria-label="Message">{renderMessage({ key: "summary", body: "" }, 0, 1)}</ol> : null}
    {shown.length ? <ol aria-label={written.length > 1 ? "Fil principal" : "Message"}>{shown.map((message, index) => renderMessage(message, index, shown.length))}</ol> : null}
    {fullHref && hidden > 0 ? <Link href={fullHref} className="ml-[52px] inline-block py-2 text-[15px] font-medium text-chart-2 hover:underline">Afficher la suite ({hidden} message{hidden > 1 ? "s" : ""})</Link> : null}
    <div className={author ? "ml-[52px]" : undefined}><PublicationPanel sources={sources} messageRefs={messageRefs} preview={summary || shown[0]?.body} /></div>
    {!summary.trim() && !written.length ? <p className="text-muted-foreground">Rien d’écrit pour l’instant.</p> : null}
  </div>;
}

function Clamped({ long, children }: { long: boolean; children: React.ReactNode }) {
  return long ? <div className="max-h-80 overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]">{children}</div> : <>{children}</>;
}
