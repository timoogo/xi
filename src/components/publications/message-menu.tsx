"use client";

import { useState } from "react";
import { PublicationPanel } from "./publication-panel";
import type { SourceSummary } from "@/lib/publications/types";
import Link from "next/link";
import { CorrectionButton } from "./correction-button";
import { TrashButton } from "./publication-actions";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { MoreHorizontal, Share } from "lucide-react";
import { toast } from "sonner";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { createReply } from "@/lib/apis/publications";

import { messageHref } from "./message-links";
export function ShareButton({ href }: { href: string }) {
  return <button type="button" aria-label="Partager" title="Partager" className="inline-flex size-11 items-center justify-center rounded-full text-muted-foreground hover:bg-chart-2/10 hover:text-chart-2 focus-visible:ring-2 focus-visible:ring-ring" onClick={() => void navigator.clipboard.writeText(new URL(href, location.origin).href).then(() => toast.success("Lien copié"), () => toast.error("Impossible de copier le lien"))}><Share aria-hidden="true" className="size-[18px]" /></button>;
}
export type OwnerActions = { id: string; correction: boolean; afterTrash?: string };
export function MessageMenu({ messageRef, canReply = true, sources = [], owner }: { messageRef?: string; canReply?: boolean; sources?: SourceSummary[]; owner?: OwnerActions }) {
  const [action, setAction] = useState<"trash" | "correction" | null>(null);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  return <><DropdownMenu><DropdownMenuTrigger asChild><button type="button" aria-label="Actions du message" className="ml-auto inline-flex size-11 shrink-0 items-center justify-center rounded-full hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"><MoreHorizontal className="size-5" aria-hidden="true" /></button></DropdownMenuTrigger><DropdownMenuContent align="end">
    {canReply && messageRef ? <DropdownMenuItem onSelect={() => { void createReply(messageRef).then(result => toast.error(result.message)); }}>Répondre à ce message</DropdownMenuItem> : null}
    {messageRef ? <DropdownMenuItem onSelect={() => { void navigator.clipboard.writeText(new URL(messageHref(messageRef), location.origin).href).then(() => toast.success("Lien copié"), () => toast.error("Impossible de copier le lien")); }}>Copier le lien permanent</DropdownMenuItem> : null}
    {owner ? <>
      {owner.correction ? <DropdownMenuItem onSelect={() => setAction("correction")}>Créer une correction</DropdownMenuItem> : <DropdownMenuItem asChild><Link href={`/dashboard/publications/${owner.id}/edit`}>Modifier</Link></DropdownMenuItem>}
      <DropdownMenuItem onSelect={() => setAction("trash")}>Supprimer</DropdownMenuItem>
    </> : null}
    {sources.length ? <DropdownMenuItem onSelect={() => setSourcesOpen(true)}>Consulter les sources</DropdownMenuItem> : null}
  </DropdownMenuContent></DropdownMenu>
    {owner ? <Dialog open={action !== null} onOpenChange={open => { if (!open) setAction(null); }}><DialogContent><DialogHeader><DialogTitle>{action === "trash" ? "Supprimer la publication" : "Créer une correction"}</DialogTitle><DialogDescription>{action === "trash" ? "La publication sera déplacée dans votre corbeille privée." : "Une nouvelle version sera reliée à cette publication."}</DialogDescription></DialogHeader>
      {action === "trash" ? <TrashButton id={owner.id} redirectTo={owner.afterTrash} /> : <CorrectionButton id={owner.id} />}
    </DialogContent></Dialog> : null}
    <PublicationPanel sources={sources} externalOpen={sourcesOpen} onOpenChange={setSourcesOpen} hideTrigger /></>;
}
