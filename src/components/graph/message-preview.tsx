"use client";

import { ArrowLeft, ArrowRight, CornerDownRight, ExternalLink, Loader2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { MarkdownView } from "@/components/publications/markdown-view";
import { UserAvatar } from "@/components/user-avatar";
import { fetchMessage, GraphApiError, isAbortError } from "@/lib/graph/client";
import type { MessagePreview, MessageRef } from "@/lib/graph/types";
import { formatDay, MessageButton, ReviewBadge } from "./connections-list";
import { TYPE_LABELS } from "./model";

// Bodies stay in memory only (never in IndexedDB): a small cache makes Back/Forward instant.
const previews = new Map<MessageRef, MessagePreview>();
const PREVIEW_CACHE = 30;
function remember(preview: MessagePreview) {
  previews.delete(preview.ref);
  previews.set(preview.ref, preview);
  while (previews.size > PREVIEW_CACHE) previews.delete(previews.keys().next().value as MessageRef);
}

type Loaded = { ref: MessageRef; preview: MessagePreview | null; error: string | null };

export function MessagePreviewView({ messageRef, onOpenMessage }: { messageRef: MessageRef; onOpenMessage: (ref: MessageRef) => void }) {
  const [loaded, setLoaded] = useState<Loaded | null>(() => {
    const cached = previews.get(messageRef);
    return cached ? { ref: messageRef, preview: cached, error: null } : null;
  });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const cached = previews.get(messageRef);
    if (cached) return void setLoaded({ ref: messageRef, preview: cached, error: null });
    const abort = new AbortController();
    fetchMessage(messageRef, abort.signal)
      .then((preview) => { remember(preview); setLoaded({ ref: messageRef, preview, error: null }); })
      .catch((reason) => {
        if (isAbortError(reason)) return;
        setLoaded({ ref: messageRef, preview: null, error: reason instanceof GraphApiError ? reason.message : "Impossible d’afficher ce message." });
      });
    return () => abort.abort();
  }, [messageRef, attempt]);

  if (!loaded || loaded.ref !== messageRef) {
    return <p role="status" className="flex items-center gap-2 text-[13px] text-muted-foreground"><Loader2 aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />Chargement du message…</p>;
  }
  if (!loaded.preview) {
    return (
      <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-[13px]">
        {loaded.error} <button type="button" className="font-semibold underline" onClick={() => { previews.delete(messageRef); setLoaded(null); setAttempt((n) => n + 1); }}>Réessayer</button>
      </div>
    );
  }
  const preview = loaded.preview;
  return (
    <article aria-label={`Message ${preview.position} sur ${preview.total}`} className="space-y-4">
      <header className="flex items-start gap-3">
        {preview.author ? <UserAvatar name={preview.author.name} image={preview.author.image} bloubSeed={preview.author.bloubSeed} size={36} /> : null}
        <div className="min-w-0 flex-1 text-[13.5px] leading-5">
          <p className="truncate font-bold">{preview.author?.name ?? "Auteur inconnu"}</p>
          {preview.author ? <p className="truncate text-muted-foreground">{preview.author.handle}</p> : null}
        </div>
        <span className="shrink-0 rounded-full border px-2 py-0.5 text-xs tabular-nums text-muted-foreground">{preview.position}/{preview.total}</span>
      </header>
      <div className="rounded-xl border px-3 py-2 text-[13px]">
        <p className="font-semibold leading-snug">{preview.publication.title || (preview.publication.type === "thread" ? "Fil sans titre" : "Publication sans titre")}</p>
        <p className="text-muted-foreground">
          {preview.publication.type === "thread" ? "Fil" : "Publication"}
          {preview.publication.status === "draft" ? ", brouillon" : ""}
          {preview.publication.date ? <>, <time dateTime={preview.publication.date}>{formatDay(preview.publication.date)}</time></> : null}
        </p>
      </div>
      <MarkdownView markdown={preview.body} className="text-[15px]" />
      <Link href={preview.href} className="inline-flex h-9 items-center gap-2 rounded-full bg-foreground px-4 text-sm font-semibold text-background hover:bg-foreground/90 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
        <ExternalLink aria-hidden="true" className="size-4" />Ouvrir la publication
      </Link>

      {preview.parent || preview.replies.length ? (
        <section aria-labelledby="preview-thread" className="space-y-2">
          <h3 id="preview-thread" className="text-[13px] font-semibold text-muted-foreground">Dans le fil</h3>
          {preview.parent ? <MessageButton summary={preview.parent} current={false} onOpen={onOpenMessage} prefix="Message précédent" /> : null}
          {preview.replies.map((reply) => (
            <div key={reply.ref} className="flex gap-1.5">
              <CornerDownRight aria-hidden="true" className="mt-3 size-4 shrink-0 text-muted-foreground" />
              <MessageButton summary={reply} current={false} onOpen={onOpenMessage} prefix="Réponse" />
            </div>
          ))}
        </section>
      ) : null}

      <section aria-labelledby="preview-connections" className="space-y-2">
        <h3 id="preview-connections" className="text-[13px] font-semibold text-muted-foreground">Connexions validées ({preview.connections.length})</h3>
        {preview.connections.length ? (
          <ul className="space-y-2">
            {preview.connections.map((connection) => {
              const outgoing = connection.direction === "outgoing";
              const Arrow = outgoing ? ArrowRight : ArrowLeft;
              return (
                <li key={connection.id} className="space-y-1">
                  <p className="flex flex-wrap items-center gap-1.5 text-xs">
                    <Arrow aria-hidden="true" className="size-3.5 text-muted-foreground" />
                    <span className="font-semibold text-chart-2">{TYPE_LABELS[connection.type]}</span>
                    <span className="text-muted-foreground">{outgoing ? "ce message → l’autre" : "l’autre → ce message"}</span>
                    {connection.needsReview ? <ReviewBadge /> : null}
                  </p>
                  <MessageButton summary={connection.other} current={false} onOpen={onOpenMessage}
                    prefix={`${TYPE_LABELS[connection.type]}, ${outgoing ? "relation sortante" : "relation entrante"}`} />
                </li>
              );
            })}
          </ul>
        ) : <p className="text-[13px] text-muted-foreground">Aucune connexion validée pour ce message.</p>}
      </section>
    </article>
  );
}
