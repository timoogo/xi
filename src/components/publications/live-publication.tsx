"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { PublicationSnapshot } from "@/lib/publications/types";
import { messageAnchor } from "@/lib/publications/conversation";
import { PublicationCard } from "./publication-card";
import { messageHref } from "./message-links";
import { useLiveSync } from "./live-sync";
type Author = { name: string; handle: string; bloubSeed?: string | null; image?: string | null };
export function LivePublication({ initial, initialAuthors, viewerId }: { initial: PublicationSnapshot; initialAuthors: Record<string, Author>; viewerId: string }) {
  const [publication, setPublication] = useState<PublicationSnapshot | null>(initial);
  const [authors, setAuthors] = useState(initialAuthors);
  const generation = useRef(0);
  const router = useRouter();
  const messages = useRef(initial.messages);
  useEffect(() => { messages.current = publication?.messages ?? []; }, [publication]);
  useLiveSync(async event => {
    const ticket = ++generation.current;
    if (event.removed?.includes(initial.id)) { setPublication(null); return; }
    try {
      const response = await fetch(`/api/publications/${initial.id}`, { cache: "no-store" });
      if (ticket !== generation.current) return;
      if (response.status === 404 || response.status === 403) { setPublication(null); return; }
      if (!response.ok) return;
      const result = await response.json();
      if (ticket !== generation.current) return;
      setPublication(result.publication); setAuthors(result.authors);
    } catch { /* Next event or reconnect retries. */ }
  });
  useEffect(() => {
    const reveal = () => {
      const anchor = location.hash.slice(1);
      const message = messages.current.find(item => messageAnchor(item.file) === anchor);
      if (message?.replyTo) { router.replace(messageHref(`${initial.id}/${anchor.slice(2)}`)); return; }
      const target = document.getElementById(anchor);
      if (!target) return;
      requestAnimationFrame(() => {
        target.scrollIntoView({ block: "center" });
        if (!matchMedia("(prefers-reduced-motion: reduce)").matches) target.animate([{ backgroundColor: "var(--accent)" }, { backgroundColor: "transparent" }], { duration: 1600 });
      });
    };
    reveal(); window.addEventListener("hashchange", reveal);
    return () => window.removeEventListener("hashchange", reveal);
  }, [initial.id, router]); // Refreshes preserve reading position; only navigation follows the anchor.
  if (!publication) return <p className="p-6 text-muted-foreground">Cette publication n’est plus disponible.</p>;
  return <PublicationCard publication={publication} author={authors[publication.authorId]} viewerId={viewerId} full afterTrash="/dashboard/publications" />;
}
