"use client";

import { useState } from "react";
import { PublicationPanel } from "./publication-panel";
import type { SourceSummary } from "@/lib/publications/types";
import { MoreHorizontal } from "lucide-react";
import { toast } from "sonner";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { createReply } from "@/lib/apis/publications";

import { messageHref } from "./message-links";
export function ShareButton({ href }: { href: string }) {
  return <button type="button" className="rounded-full px-3 py-2 text-sm text-muted-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring" onClick={() => void navigator.clipboard.writeText(new URL(href, location.origin).href).then(() => toast.success("Lien copié"), () => toast.error("Impossible de copier le lien"))}>Partager</button>;
}
export function MessageMenu({ messageRef, canReply = true, sources = [] }: { messageRef: string; canReply?: boolean; sources?: SourceSummary[] }) {
  const [sourcesOpen, setSourcesOpen] = useState(false);
  return <><DropdownMenu><DropdownMenuTrigger asChild><button type="button" aria-label="Actions du message" className="ml-auto inline-flex size-8 shrink-0 items-center justify-center rounded-full hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"><MoreHorizontal className="size-4" aria-hidden="true" /></button></DropdownMenuTrigger><DropdownMenuContent align="end">
    {canReply ? <DropdownMenuItem onSelect={() => { void createReply(messageRef).then(result => toast.error(result.message)); }}>Répondre à ce message</DropdownMenuItem> : null}
    <DropdownMenuItem onSelect={() => { void navigator.clipboard.writeText(new URL(messageHref(messageRef), location.origin).href).then(() => toast.success("Lien copié"), () => toast.error("Impossible de copier le lien")); }}>Copier le lien permanent</DropdownMenuItem>
    {sources.length ? <DropdownMenuItem onSelect={() => setSourcesOpen(true)}>Consulter les sources</DropdownMenuItem> : null}
  </DropdownMenuContent></DropdownMenu><PublicationPanel sources={sources} externalOpen={sourcesOpen} onOpenChange={setSourcesOpen} hideTrigger /></>;
}
