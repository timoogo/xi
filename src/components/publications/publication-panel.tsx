"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { BookOpen, Network } from "lucide-react";
import { ConnectionsList } from "@/components/graph/connections-list";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { fetchMessage, isAbortError } from "@/lib/graph/client";
import type { ConnectionsFilters, MessagePreview } from "@/lib/graph/types";
import type { SourceSummary } from "@/lib/publications/types";
import { MarkdownView } from "./markdown-view";
import { useLiveSync } from "./live-sync";

/** Only authorized source metadata and relation refs are passed by the server. No request per feed card. */
export function PublicationPanel({ sources, messageRefs = [], preview, previousVersion, externalOpen, onOpenChange, hideTrigger = false }: {
  externalOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  hideTrigger?: boolean;
  sources: SourceSummary[];
  messageRefs?: string[];
  preview?: string;
  previousVersion?: string | null;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = externalOpen ?? internalOpen;
  const setOpen = (value: boolean) => { setInternalOpen(value); onOpenChange?.(value); };
  useLiveSync(() => setOpen(false));
  const [tab, setTab] = useState<"sources" | "connections">("sources");
  const [selected, setSelected] = useState<string | null>(null);
  const [filters, setFilters] = useState<ConnectionsFilters>({});
  if (!sources.length && !messageRefs.length && !previousVersion) return null;
  return (
    <div onClick={(event) => event.stopPropagation()} className="cursor-auto">
      <Sheet open={open} onOpenChange={(value) => { setOpen(value); if (!value) setSelected(null); }}>
        <div className={`flex flex-wrap gap-3 text-sm text-muted-foreground ${hideTrigger ? "hidden" : ""}`}>
          {sources.length ? <SheetTrigger asChild><button type="button" className="inline-flex min-h-9 items-center gap-1.5 rounded-md hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setTab("sources")}><BookOpen aria-hidden="true" className="size-4" />Sources ({sources.length})</button></SheetTrigger> : null}
          {messageRefs.length || previousVersion ? <SheetTrigger asChild><button type="button" className="inline-flex min-h-9 items-center gap-1.5 rounded-md hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setTab("connections")}><Network aria-hidden="true" className="size-4" />Connexions et corrections</button></SheetTrigger> : null}
        </div>
        <SheetContent className="w-full sm:max-w-lg">
          <SheetHeader className="pr-12">
            <SheetTitle>{tab === "sources" ? "Sources" : "Connexions et corrections"}</SheetTitle>
            <SheetDescription>{tab === "sources" ? "Documents cités par cette publication. Les catégories décrivent leur nature, pas leur fiabilité." : "Relations validées humainement. Les mises à jour relient une correction à sa version précédente."}</SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain break-words px-4 pb-6">
            {preview ? <blockquote className="border-l-2 pl-3 text-sm text-muted-foreground">{preview.slice(0, 400)}</blockquote> : null}
            {tab === "connections" && previousVersion ? <Link className="block text-sm text-chart-2 underline" href={`/dashboard/publications/${previousVersion}`}>Consulter la version précédente</Link> : null}
            {tab === "sources" ? <ul className="space-y-5">{sources.map((source) => <li key={source.file} className="space-y-2 rounded-xl border p-3">
              <h3 className="font-semibold">{source.url ? <a href={source.url} target="_blank" rel="noopener noreferrer nofollow" className="text-chart-2 underline underline-offset-2">{source.title}<span className="sr-only"> (nouvel onglet)</span></a> : source.title}</h3>
              {source.author || source.publisher ? <p className="text-sm text-muted-foreground">{[source.author, source.publisher].filter(Boolean).join(" — ")}</p> : null}
              {source.date ? <p className="text-sm"><time dateTime={source.date}>{source.date}</time></p> : null}
              {source.kinds?.length ? <p className="text-xs text-muted-foreground">Nature : {source.kinds.join(", ")}</p> : null}
              {source.excerpts?.length ? <section><h4 className="text-sm font-semibold">Extraits pertinents</h4>{source.excerpts.map((text, i) => <blockquote key={i} className="my-2 border-l-2 pl-3 text-sm">{text}</blockquote>)}</section> : null}
              {source.claims?.length ? <section><h4 className="text-sm font-semibold">Affirmations étayées</h4><ul className="list-disc space-y-1 pl-5 text-sm">{source.claims.map((text, i) => <li key={i}>{text}</li>)}</ul></section> : null}
              {source.reservations?.length ? <section><h4 className="text-sm font-semibold">Réserves</h4><ul className="list-disc space-y-1 pl-5 text-sm">{source.reservations.map((text, i) => <li key={i}>{text}</li>)}</ul></section> : null}
            </li>)}</ul> : selected ? <>
              <button type="button" className="min-h-9 text-sm text-chart-2 underline" onClick={() => setSelected(null)}>Revenir aux connexions</button>
              <FreshMessagePreview key={selected} messageRef={selected} />
            </> : messageRefs.length ? <ConnectionsList scope={{ kind: "all", node: `p:${messageRefs[0].split("/")[0]}` }} filters={filters} onFilters={setFilters} generators={[]} currentRef={null} onOpenMessage={setSelected} /> : null}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

/** Revalidate access on every opening; no shared cache of private message bodies. */
function FreshMessagePreview({ messageRef }: { messageRef: string }) {
  const [preview, setPreview] = useState<MessagePreview | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    fetchMessage(messageRef, controller.signal).then(setPreview).catch((reason) => { if (!isAbortError(reason)) setError(true); });
    return () => controller.abort();
  }, [messageRef, attempt]);
  useLiveSync(event => { if (event.reset || event.publications?.includes(messageRef.split("/")[0])) { setPreview(null); setError(false); setAttempt(value => value + 1); } });
  if (error) return <p role="alert">Ce message ne peut pas être chargé. <button type="button" className="underline" onClick={() => { setError(false); setAttempt((value) => value + 1); }}>Réessayer</button></p>;
  if (!preview) return <p role="status">Chargement du message…</p>;
  return <article className="space-y-3"><p className="font-semibold">{preview.author?.name}</p><MarkdownView markdown={preview.body} /><Link className="text-chart-2 underline" href={preview.href}>Ouvrir dans la conversation</Link></article>;
}
