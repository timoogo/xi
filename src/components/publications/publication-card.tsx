import { Bookmark, EyeOff, GitFork, Heart, Lock, PenLine, Telescope, Users } from "lucide-react";
import Link from "next/link";
import { UserAvatar } from "@/components/user-avatar";
import type { PublicationSnapshot } from "@/lib/publications/types";
import { FeedArticle } from "./feed-article";
import { formatDate, formatShortDate } from "./publication-badges";
import { PublicationContent } from "./publication-content";
import { TrashButton } from "./publication-actions";

type Author = { name: string; handle: string; image?: string | null };

// Planned interactions: shown so the layout is settled, disabled until their logic exists.
const PLANNED_ACTIONS = [
  { label: "J’aime", icon: Heart },
  { label: "Pas intéressé", icon: EyeOff },
  { label: "Enregistrer", icon: Bookmark },
  { label: "Approfondir", icon: Telescope },
  { label: "Dériver", icon: GitFork },
];

/** One publication as a social feed entry: used by the home feed, the profile, Publications and the detail page. */
export function PublicationCard({ publication, author, viewerId, full = false, afterTrash }: {
  publication: PublicationSnapshot;
  author?: Author;
  viewerId: string;
  full?: boolean;
  afterTrash?: string;
}) {
  const isAuthor = publication.authorId === viewerId;
  const isDraft = publication.status === "draft";
  const href = `/dashboard/publications/${publication.id}${isDraft ? "/edit" : ""}`;
  const date = publication.publishedAt ?? publication.updatedAt;
  const name = author?.name ?? "Auteur inconnu";
  const badges = [
    isDraft ? <Pill key="draft" className="border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300">Brouillon</Pill> : null,
    publication.visibility === "private" ? <Pill key="private"><Lock aria-hidden="true" className="size-3" />Moi uniquement</Pill> : null,
    publication.visibility === "followers" ? <Pill key="followers"><Users aria-hidden="true" className="size-3" />Abonnés · vous uniquement pour l’instant</Pill> : null,
  ].filter(Boolean);
  return (
    <FeedArticle href={full ? undefined : href} label={`Publication de ${name}`} className="flex gap-3 border-b px-4 pb-2 pt-3">
      <UserAvatar name={name} image={author?.image} size={40} />
      <div className="min-w-0 flex-1">
        <header className="flex min-w-0 items-baseline gap-1 text-[15px] leading-5">
          <span className="truncate font-bold">{name}</span>
          {author ? <span className="min-w-0 truncate text-muted-foreground">{author.handle}</span> : null}
          <span aria-hidden="true" className="shrink-0 text-muted-foreground">·</span>
          <Link href={href} title={isDraft ? `Modifié le ${formatDate(date)}` : formatDate(date)} className="shrink-0 whitespace-nowrap text-muted-foreground hover:underline">
            <time dateTime={date}>{formatShortDate(date)}</time>
          </Link>
        </header>
        {badges.length ? <p className="mt-1 flex flex-wrap gap-1.5">{badges}</p> : null}
        <div className={full ? "mt-2 text-[17px] leading-7" : "mt-0.5 text-[15px] leading-6"}>
          <PublicationContent
            summary={publication.summary}
            messages={publication.messages.map((message) => ({ key: message.file, body: message.body }))}
            sources={publication.sources}
            fullHref={full ? undefined : href}
            sourcesOpen={full}
          />
        </div>
        <footer className="mt-1.5 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <ul aria-label="Interactions (bientôt disponibles)" className="-ml-2 flex max-w-[425px] flex-1 justify-between">
            {PLANNED_ACTIONS.map(({ label, icon: Icon }) => (
              <li key={label}>
                <button type="button" disabled aria-label={`${label} (bientôt disponible)`} title={`${label} — bientôt disponible`}
                  className="inline-flex size-[34px] items-center justify-center rounded-full text-muted-foreground/60 disabled:cursor-not-allowed">
                  <Icon aria-hidden="true" className="size-[18px]" />
                </button>
              </li>
            ))}
          </ul>
          {isAuthor ? (
            <div className="-mr-2 flex items-center gap-0.5">
              <Link href={`/dashboard/publications/${publication.id}/edit`} className="inline-flex h-8 items-center gap-1.5 rounded-full px-2 text-sm sm:px-3 font-medium text-muted-foreground hover:bg-chart-2/10 hover:text-chart-2">
                <PenLine aria-hidden="true" className="size-4" /><span className="sr-only sm:not-sr-only">Modifier</span>
              </Link>
              <TrashButton id={publication.id} redirectTo={afterTrash} compact />
            </div>
          ) : null}
        </footer>
      </div>
    </FeedArticle>
  );
}

function Pill({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium text-muted-foreground ${className}`}>{children}</span>;
}
