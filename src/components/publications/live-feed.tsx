"use client";
import { useEffect, useRef, useState } from "react";
import type { PublicationSnapshot } from "@/lib/publications/types";
import { EmptyState } from "@/components/empty-state";
import { PublicationCard } from "./publication-card";
import { useLiveSync } from "./live-sync";
import { FeedChanged, loadFeedWindow, type FeedPage } from "./feed-window";

export function LiveFeed({ initial, tab, viewerId, empty }: { initial: FeedPage; tab: "for-you" | "following"; viewerId: string; empty: { title: string; description: string } }) {
  const [items, setItems] = useState(initial.items);
  const [authors, setAuthors] = useState(initial.authors);
  const [cursor, setCursor] = useState(initial.nextCursor);
  const [incoming, setIncoming] = useState<FeedPage | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const current = useRef(initial.items);
  const controller = useRef<AbortController | null>(null);
  const base = useRef(initial);
  const intent = useRef({ reveal: false, minimum: 20 });
  const restoration = useRef<{ ids: string[]; y: number } | null>(null);
  const historyScope = `${viewerId}:${tab}`;

  useEffect(() => {
    // Store only IDs and position on this history entry. Back navigation reloads
    // bodies with current permissions, including pages loaded before leaving.
    const saved = history.state?.xiFeed;
    if (saved?.scope === historyScope && Array.isArray(saved.ids) && saved.ids.every((id: unknown) => typeof id === "string") && Number.isFinite(saved.y)) {
      restoration.current = { ids: saved.ids, y: saved.y };
      void refresh(true);
    }
    const remember = () => history.replaceState({ ...history.state, xiFeed: { scope: historyScope, ids: current.current.map(item => item.id), y: window.scrollY } }, "");
    document.addEventListener("click", remember, true);
    return () => document.removeEventListener("click", remember, true);
  // Each mounted feed belongs to one account, tab and history entry.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyScope]);

  function anchor() {
    const element = [...document.querySelectorAll<HTMLElement>("[data-feed-id]")].find(item => item.getBoundingClientRect().bottom > 0);
    return element ? { id: element.dataset.feedId!, top: element.getBoundingClientRect().top } : null;
  }
  function replace(next: PublicationSnapshot[]) {
    const before = anchor();
    current.current = next; setItems(next);
    requestAnimationFrame(() => {
      const after = before && document.querySelector(`[data-feed-id="${CSS.escape(before.id)}"]`);
      if (after && before) window.scrollBy(0, after.getBoundingClientRect().top - before.top);
    });
  }

  async function refresh(reveal = false, extend = false) {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setPending(true); setError(false);
    const previous = current.current;
    intent.current.reveal ||= reveal;
    intent.current.minimum = Math.max(intent.current.minimum, previous.length + (extend ? 20 : 0));
    try {
      const page = await loadFeedWindow(async cursor => {
        const response = await fetch(`/api/feed?tab=${tab}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { cache: "no-store", signal: request.signal });
        if (response.status === 409) throw new FeedChanged();
        if (!response.ok) throw new Error("load");
        return response.json();
      }, restoration.current?.ids ?? previous.map(item => item.id), Math.max(intent.current.minimum, restoration.current?.ids.length ?? 0));
      if (request.signal.aborted) return;
      const visible = new Set(previous.map(item => item.id));
      const hasNew = page.items.some(item => !visible.has(item.id));
      // Membership comes from the feed, not the publication detail endpoint: a
      // readable public post must still disappear when its author is unfollowed.
      const showNew = intent.current.reveal;
      replace(showNew ? page.items : page.items.filter(item => visible.has(item.id)));
      setAuthors(page.authors); setCursor(page.nextCursor);
      setIncoming(!showNew && hasNew ? page : null);
      intent.current = { reveal: false, minimum: 20 };
      const savedPosition = restoration.current;
      restoration.current = null;
      if (savedPosition) requestAnimationFrame(() => window.scrollTo(0, savedPosition.y));
    } catch {
      if (!request.signal.aborted) setError(true);
    } finally {
      if (!request.signal.aborted) setPending(false);
    }
  }
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    if (base.current === initial) return;
    base.current = initial;
    void refresh(true);
  });
  useLiveSync(event => {
    const removed = new Set(event.removed ?? []);
    if (removed.size) {
      replace(current.current.filter(item => !removed.has(item.id)));
      setIncoming(page => page ? { ...page, items: page.items.filter(item => !removed.has(item.id)) } : null);
    }
    void refresh();
  });
  function reveal() {
    // Revalidate before revealing: staged entries may have become private while
    // disconnected. Never display a cached incoming body on an unsuccessful read.
    void refresh(true);
  }
  function more() { void refresh(true, true); }
  return <>
    {incoming ? <button type="button" disabled={pending} onClick={reveal} className="w-full border-b px-4 py-3 text-center text-chart-2 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">Nouvelles publications</button> : null}
    <span role="status" className="sr-only">{incoming ? "De nouvelles publications sont disponibles." : ""}</span>
    {!items.length ? <EmptyState title={empty.title} description={empty.description} /> : null}
    {items.map(item => <div key={item.id} data-feed-id={item.id}><PublicationCard publication={item} author={authors[item.authorId]} viewerId={viewerId} /></div>)}
    {error ? <p role="alert" className="p-4 text-sm">Impossible de charger le fil. <button type="button" className="underline" onClick={() => void refresh()}>Réessayer</button></p> : null}
    {cursor ? <button type="button" disabled={pending} onClick={() => void more()} className="w-full border-b p-4 text-chart-2 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">{pending ? "Chargement…" : "Afficher plus de publications"}</button> : null}
  </>;
}
