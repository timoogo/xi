import { Lock, Users } from "lucide-react";
import Link from "next/link";
import type { PublicationSnapshot } from "@/lib/publications/types";
import { FeedArticle } from "./feed-article";
import { PublicationContent } from "./publication-content";
import { PublicationPanel } from "./publication-panel";
import { ReplyButton } from "./publication-actions";

import { ShareButton } from "./message-menu";
import { messageAnchor } from "@/lib/publications/conversation";

type Author = { name: string; handle: string; bloubSeed?: string | null; image?: string | null };

/** One publication as a social feed entry: used by the home feed, the profile, Publications and the detail page. */
export function PublicationCard({ publication, author, viewerId, full = false, afterTrash, replies }: {
  publication: PublicationSnapshot;
  author?: Author;
  viewerId: string;
  full?: boolean;
  afterTrash?: string;
  replies?: Record<string, { count: number; content: React.ReactNode }>;
}) {
  const isAuthor = publication.authorId === viewerId;
  const isDraft = publication.status === "draft";
  const href = `/dashboard/publications/${publication.id}${isDraft ? "/edit" : ""}`;
  const date = publication.publishedAt ?? publication.updatedAt;
  const name = author?.name ?? "Auteur inconnu";
  const badges = [
    isDraft ? <Pill key="draft" className="border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300">Brouillon</Pill> : null,
    publication.visibility === "private" ? <Pill key="private"><Lock aria-hidden="true" className="size-3" />Moi uniquement</Pill> : null,
    publication.visibility === "followers" ? <Pill key="followers"><Users aria-hidden="true" className="size-3" />Abonnés</Pill> : null,
  ].filter(Boolean);
  return (
    <FeedArticle href={full ? undefined : href} label={`Publication de ${name}`} className="xi-publication border-b px-3 py-2 sm:px-4">
      <div className="min-w-0 flex-1">
        {badges.length ? <p className="ml-[52px] mt-1 flex flex-wrap gap-1.5">{badges}</p> : null}
        <div className={full ? "mt-2 text-[17px] leading-7" : "mt-0.5 text-[15px] leading-6"}>
          {publication.parentContext ? <Link href={`/dashboard/publications/${publication.parentContext.publicationId}#m-${publication.parentContext.ref.split("/")[1]}`} className="mb-3 block rounded-lg border px-3 py-2 text-sm text-muted-foreground hover:bg-muted"><span className="block font-medium">En réponse · ouvrir la conversation</span><span>{publication.parentContext.excerpt}</span></Link> : publication.messages.some(message => message.replyTo && !message.replyTo.startsWith(`${publication.id}/`)) ? <p className="mb-2 text-sm text-muted-foreground">En réponse à un message indisponible.</p> : null}
          <PublicationContent
            owner={isAuthor ? { id: publication.id, correction: !!publication.analysis && !isDraft, afterTrash } : undefined}
            replies={replies}
            publicationId={publication.id}
            messageRefs={isDraft ? [] : publication.messages.filter(message => !message.deleted).flatMap(message => {
              const anchor = messageAnchor(message.file);
              return anchor ? [`${publication.id}/${anchor.slice(2)}`] : [];
            })}
            author={{ name, image: author?.image, bloubSeed: author?.bloubSeed, handle: author?.handle, id: publication.authorId, ai: publication.authorType === "ai" }}
            date={date}
            visibility={publication.visibility}
            summary={publication.summary}
            messages={publication.messages.map((message) => ({ key: message.file, ...message, body: message.body, replyTo: message.replyTo }))}
            sources={publication.sources}
            fullHref={full ? undefined : href}
            sourcesOpen={full}
          />
        </div>
        {publication.previousVersion ? <PublicationPanel sources={[]} previousVersion={publication.previousVersion} preview={publication.summary} /> : null}
        <footer className="ml-[52px] flex items-center">
          <div aria-label="Interactions" className="flex max-w-md flex-1 items-center justify-between">
            {!isDraft && publication.messages[0] && messageAnchor(publication.messages[0].file) ? <ReplyButton messageRef={`${publication.id}/${messageAnchor(publication.messages[0].file)!.slice(2)}`} /> : null}
            <ShareButton href={href} />
          </div>
        </footer>
      </div>
    </FeedArticle>
  );
}

function Pill({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium text-muted-foreground ${className}`}>{children}</span>;
}
