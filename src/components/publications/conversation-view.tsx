"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { PublicationSnapshot } from "@/lib/publications/types";
import { UserAvatar } from "@/components/user-avatar";
import { MarkdownView } from "./markdown-view";
import { MessageMenu } from "./message-menu";
import { messageHref } from "./message-links";
import { PublicationPanel } from "./publication-panel";
import { useLiveSync } from "./live-sync";
import { formatShortDate } from "./publication-badges";
import { FeedArticle } from "./feed-article";
import type { XiAgentBloub } from "@/lib/xiagents/avatar";

type Entry = { ref: string; publicationId: string; message: PublicationSnapshot["messages"][number] | null; publication: PublicationSnapshot | null; deleted: boolean; replyCount?: number };
type Author = { name: string; handle: string; bloubSeed?: string | null; bloub?: XiAgentBloub; image?: string | null };
type Page = { parent: Entry; ancestors: Entry[]; thread?: Entry[]; children: Entry[]; nextCursor: string | null; authors: Record<string, Author> };
const unique = (items: Entry[]) => [...new Map(items.map(item => [item.ref, item])).values()];

/** Thread link to the next message, drawn under the avatar like a social thread. */
const connector = <span aria-hidden="true" data-thread-connector className="col-start-1 row-start-2 -mb-6 mt-1 w-0.5 justify-self-center bg-border" />;

/** `threaded` places the message in a thread; `href` makes its free space open it. */
function Message({ entry, authors, fresh = false, threaded, focused = false, href }: { entry: Entry; authors: Page["authors"]; fresh?: boolean; threaded?: { next: boolean }; focused?: boolean; href?: string }) {
  if (entry.deleted) return threaded
    ? <div className="grid grid-cols-[40px_minmax(0,1fr)] gap-x-3 py-3"><span aria-hidden="true" className="size-10 rounded-full bg-muted" /><p className="self-center text-sm text-muted-foreground">Ce message a été supprimé</p>{threaded.next ? connector : null}</div>
    : <div className="py-4 text-sm text-muted-foreground">Ce message a été supprimé</div>;
  if (!entry.message || !entry.publication) return null;
  const publication = entry.publication;
  const author = authors[publication.authorId];
  const message = entry.message as typeof entry.message & { createdAt?: string; updatedAt?: string };
  const date = message.createdAt ?? publication.publishedAt ?? publication.createdAt;
  return <FeedArticle id={`m-${entry.ref.split("/")[1]}`} href={href} label={`Message de ${author?.name ?? "l’auteur"}`} className={`grid grid-cols-[40px_minmax(0,1fr)] gap-x-3 min-w-0 scroll-mt-24 py-3 ${focused ? "-mx-2 rounded-lg bg-chart-2/10 px-2" : ""} ${fresh ? "motion-safe:animate-in motion-safe:fade-in motion-safe:duration-500" : ""}`}>
    <Link href={`/dashboard/profiles/${publication.authorId}`} className="mr-1 shrink-0" aria-label={`Profil de ${author?.name ?? "l’auteur"}`}><UserAvatar name={author?.name ?? "Auteur"} image={author?.image} bloubSeed={author?.bloubSeed} bloub={author?.bloub} size={40} ai={publication.authorType === "ai"} /></Link>
    <header className="relative flex min-h-10 flex-wrap content-center items-center gap-x-1 pr-11 text-[15px] leading-5">
      <Link href={`/dashboard/profiles/${publication.authorId}`} className="max-w-full truncate font-bold hover:underline">{author?.name ?? "Auteur"}</Link>
      <span className="max-w-full truncate text-muted-foreground">{author?.handle}</span>
      <Link href={messageHref(entry.ref)} className="text-muted-foreground hover:underline"><time dateTime={date}>{formatShortDate(date)}</time></Link>
      {message.updatedAt && message.updatedAt !== date ? <span className="text-xs text-muted-foreground">Modifié</span> : null}
      {fresh ? <span className="text-xs text-muted-foreground">Nouvelle réponse</span> : null}
      <span className="absolute right-0 top-0"><MessageMenu messageRef={entry.ref} sources={publication.sources} /></span>
    </header>
    <div className="col-start-2 row-start-2"><MarkdownView markdown={message.body} /><PublicationPanel sources={publication.sources} messageRefs={[entry.ref]} preview={message.body} />
      {threaded && !focused && entry.replyCount ? <Link href={messageHref(entry.ref)} className="mt-1 inline-block rounded px-1 py-2 text-sm text-chart-2 hover:underline">{entry.replyCount} réponse{entry.replyCount > 1 ? "s" : ""}</Link> : null}
    </div>
    {threaded?.next ? connector : null}
  </FeedArticle>;
}

/** Each branch owns its cursor and disclosure; sibling refreshes cannot close it. */
export function ReplyBranch({ messageRef, depth, initialOpen = false, count }: { messageRef: string; depth: number; initialOpen?: boolean; count?: number }) {
  const [page, setPage] = useState<Page | null>(null);
  const [open, setOpen] = useState(initialOpen);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const loaded = useRef(10);
  const current = useRef<Page | null>(null);
  const request = useRef(0);
  const alive = useRef(true);
  const expanded = useRef(open);
  expanded.current = open;
  const restoreY = useRef<number | null>(null);
  useEffect(() => {
    const saved = history.state?.xiBranches?.[messageRef];
    if (saved && typeof saved.open === "boolean" && Number.isSafeInteger(saved.loaded) && saved.loaded >= 10) {
      loaded.current = saved.loaded;
      setOpen(saved.open);
      if (Number.isFinite(history.state?.xiConversationY)) restoreY.current = history.state.xiConversationY;
    }
    const remember = () => history.replaceState({ ...history.state, xiConversationY: window.scrollY,
      xiBranches: { ...history.state?.xiBranches, [messageRef]: { open: expanded.current, loaded: loaded.current } },
    }, "");
    document.addEventListener("click", remember, true);
    return () => document.removeEventListener("click", remember, true);
  }, [messageRef]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const load = useCallback(async (more = false, sync = false) => {
    const ticket = ++request.current;
    setPending(true); setError(false);
    try {
      let cursor = more ? current.current?.nextCursor : null;
      let children = more ? current.current?.children ?? [] : [];
      let result: Page | null = null;
      let authors = more ? current.current?.authors ?? {} : {};
      do {
        const response = await fetch(`/api/conversations?ref=${encodeURIComponent(messageRef)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { cache: "no-store" });
        if (response.status === 404 || response.status === 403) { if (alive.current && ticket === request.current) { setPage(null); current.current = null; } return; }
        if (!response.ok) throw new Error("load");
        result = await response.json() as Page;
        children = unique([...children, ...result.children]);
        authors = { ...authors, ...result.authors };
        cursor = result.nextCursor;
      } while (!more && cursor && children.length < loaded.current);
      if (!result || !alive.current || ticket !== request.current) return;
      if (sync && current.current) setFresh(new Set(children.filter(item => !current.current?.children.some(old => old.ref === item.ref)).map(item => item.ref)));
      const next = { ...result, children, authors };
      loaded.current = Math.max(10, children.length);
      current.current = next; setPage(next);
      const y = restoreY.current;
      restoreY.current = null;
      if (y !== null) requestAnimationFrame(() => window.scrollTo(0, y));
    } catch { if (alive.current && ticket === request.current) setError(true); }
    finally { if (alive.current && ticket === request.current) setPending(false); }
  }, [messageRef]);
  useEffect(() => { if (open && depth < 2) void load(); }, [load, open, depth]);
  // A closed branch learns about new replies through its parent's refreshed `count`,
  // or, once loaded, through a quiet check of the parent's reply count.
  const [seen, setSeen] = useState(count ?? 0);
  const [unseen, setUnseen] = useState(false);
  useEffect(() => { if (open) { setSeen(count ?? 0); setUnseen(false); } }, [open, count]);
  useLiveSync(async event => {
    if (event.removed?.includes(messageRef.split("/")[0])) { setPage(null); current.current = null; }
    if (depth >= 2) return;
    // Reconnect resets reconcile silently: only a live change is announced as new.
    if (open) return void load(false, !event.reset);
    if (event.reset || !current.current) return;
    try {
      const response = await fetch(`/api/conversations?ref=${encodeURIComponent(messageRef)}`, { cache: "no-store" });
      if (!response.ok) return;
      const known = current.current?.parent.replyCount ?? 0;
      if (alive.current && ((await response.json() as Page).parent.replyCount ?? 0) > known) setUnseen(true);
    } catch { /* The next event retries. */ }
  });
  if (depth >= 2) return (count ?? page?.children.length ?? 0) > 0 ? <Link href={messageHref(messageRef)} className="block py-3 text-sm text-chart-2 underline">Voir la sous-conversation</Link> : null;
  if (count === 0 && !page?.children.length && !error) return null;
  return <section className="mt-2 min-w-0">
    <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)} className="rounded px-1 py-2 text-sm font-medium text-chart-2 focus-visible:ring-2 focus-visible:ring-ring">{open ? "Réduire" : "Développer"} les réponses{!open && (unseen || (count ?? 0) > seen) ? " · Nouvelles réponses" : ""}</button>
    {open ? <div className="border-l border-border pl-3 sm:pl-4">
      <ol aria-label="Réponses chronologiques">{page?.children.map(entry => <li key={entry.ref} className="border-b border-border/60"><Message entry={entry} authors={page.authors} fresh={fresh.has(entry.ref)} /><ReplyBranch messageRef={entry.ref} depth={depth + 1} count={entry.replyCount} /></li>)}</ol>
      {error ? <p role="alert" className="py-2 text-sm">Impossible de charger les réponses. <button className="underline" onClick={() => void load()}>Réessayer</button></p> : null}
      {page?.nextCursor ? <button type="button" disabled={pending} className="my-3 rounded px-2 py-2 text-sm text-chart-2 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50" onClick={() => void load(true)}>{pending ? "Chargement…" : "Afficher plus de réponses"}</button> : page?.children.length ? <p className="py-2 text-xs text-muted-foreground">Toutes les réponses sont affichées.</p> : null}
    </div> : null}
  </section>;
}

export function ConversationView({ messageRef }: { messageRef: string }) {
  const [page, setPage] = useState<Page | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const router = useRouter();
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/conversations?ref=${encodeURIComponent(messageRef)}`, { cache: "no-store", signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error("unavailable");
      setPage(await response.json()); setError(false);
    }).catch(reason => { if (reason.name !== "AbortError") { setPage(null); setError(true); } });
    return () => controller.abort();
  }, [messageRef, attempt]);
  useLiveSync(event => { if (event.removed?.includes(messageRef.split("/")[0])) setPage(null); setAttempt(value => value + 1); });
  const thread = page && (page.thread?.length ?? 0) > 1 ? page.thread! : null;
  const position = thread?.findIndex(entry => entry.ref === messageRef) ?? -1;
  // A direct opening lands on the selected message; earlier messages stay just above it.
  // History restoration (ReplyBranch) and explicit anchors keep their own position.
  const central = useRef<HTMLLIElement>(null);
  const placed = useRef(false);
  useEffect(() => {
    if (placed.current || !page) return;
    placed.current = true;
    if (position <= 0 || location.hash || Number.isFinite(history.state?.xiConversationY)) return;
    requestAnimationFrame(() => central.current?.scrollIntoView({ block: "start" }));
  }, [page, position]);
  return <section className="xi-publication min-w-0">
    <header className="border-b px-4 py-3"><button type="button" className="mr-3 rounded px-2 py-2 text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring" onClick={() => window.history.length > 1 ? router.back() : router.push(`/dashboard/publications/${messageRef.split("/")[0]}`)}>← Retour</button><h1 className="inline text-lg font-semibold">{thread ? "Fil" : "Sous-conversation"}</h1>
      {page ? <nav aria-label="Fil d’Ariane" className="mt-2 flex flex-wrap gap-2 text-sm text-muted-foreground"><Link href={`/dashboard/publications/${messageRef.split("/")[0]}`} className="underline">Publication d’origine</Link>{page.ancestors.filter(entry => !entry.deleted).map((entry, index) => <Link key={entry.ref} href={messageHref(entry.ref)} className="underline">› Message parent {index + 1}</Link>)}</nav> : null}
    </header>
    <div className="px-4">{error ? <p role="alert" className="py-6">Cette conversation est indisponible. <button className="underline" onClick={() => setAttempt(value => value + 1)}>Réessayer</button></p> : thread ? <ol aria-label={`Fil de ${thread.length} messages`}>{thread.map((entry, index) => {
        const focused = index === position;
        return <li key={entry.ref} ref={focused ? central : undefined} aria-current={focused ? "true" : undefined} className="min-w-0 scroll-mt-24">
          <Message entry={entry} authors={page!.authors} threaded={{ next: index < thread.length - 1 }} focused={focused} href={focused || entry.deleted ? undefined : messageHref(entry.ref)} />
        </li>;
      })}</ol> : page ? <Message entry={page.parent} authors={page.authors} /> : <p role="status" className="py-4">Chargement…</p>}
      {thread && page!.parent.replyCount ? <h2 className="mt-2 border-t pt-3 text-sm font-semibold">Réponses au message {position + 1}/{thread.length}</h2> : null}
      <ReplyBranch messageRef={messageRef} depth={0} initialOpen count={thread ? page!.parent.replyCount ?? 0 : undefined} />
    </div>
  </section>;
}
