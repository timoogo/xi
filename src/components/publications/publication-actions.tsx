"use client";

import { Feather, RotateCcw, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { UserAvatar } from "@/components/user-avatar";
import { createPublication, restorePublication, trashPublication } from "@/lib/apis/publications";

/** Creates an empty draft, then the server action opens it in the existing editor. */
function useCreatePublication() {
  const [pending, setPending] = useState(false);
  async function create() {
    setPending(true);
    try {
      // On success the action redirects to the editor and never resolves here.
      const result = await createPublication();
      toast.error(result.message);
    } finally {
      setPending(false);
    }
  }
  return { pending, create };
}

export function NewPublicationButton({ compact = false, className }: { compact?: boolean; className?: string }) {
  const { pending, create } = useCreatePublication();
  if (compact) {
    return (
      <Button size="icon" onClick={create} disabled={pending} aria-label="Publier" title="Publier" className={className}>
        <Feather aria-hidden="true" className="size-6" />
      </Button>
    );
  }
  return <Button onClick={create} disabled={pending} className={className}>{pending ? "Ouverture…" : "Publier"}</Button>;
}

/** "Quoi de neuf ?" at the top of the home feed: a shortcut to the Markdown editor, not a second editor. */
export function Composer({ user }: { user: { name: string; image?: string | null } }) {
  const { pending, create } = useCreatePublication();
  return (
    <section aria-label="Nouvelle publication" className="flex gap-3 border-b px-4 pb-3 pt-4">
      <UserAvatar name={user.name} image={user.image} size={40} />
      <div className="min-w-0 flex-1">
        <button type="button" onClick={create} disabled={pending}
          className="w-full rounded-md py-1.5 text-left text-xl text-muted-foreground outline-none transition-colors hover:text-foreground/70 focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-wait">
          {pending ? "Ouverture de l’éditeur…" : "Quoi de neuf ?"}
        </button>
        <div className="mt-3 flex items-center justify-between gap-3 border-t pt-3">
          <p className="min-w-0 text-[13px] text-muted-foreground">Markdown, enregistré dans votre vault Obsidian</p>
          <Button onClick={create} disabled={pending} className="shrink-0 rounded-full px-5 font-bold">Rédiger</Button>
        </div>
      </div>
    </section>
  );
}

/** Shared by the trash page and the "Annuler" of a deletion toast. */
async function restore(id: string) {
  const result = await restorePublication(id);
  if (!result.ok) {
    toast.error(`Restauration impossible : ${result.message}`);
    return false;
  }
  toast.success(result.renamed
    ? `Publication restaurée. Son dossier d’origine était occupé : elle se trouve maintenant dans ${result.folder}.`
    : "Publication restaurée dans son dossier d’origine.");
  return true;
}

export function RestoreButton({ id }: { id: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  async function onClick() {
    setPending(true);
    const restored = await restore(id);
    setPending(false);
    if (restored) router.push(`/dashboard/publications/${id}/edit`);
  }
  return <Button size="sm" variant="outline" className="rounded-full" onClick={onClick} disabled={pending}><RotateCcw />{pending ? "Restauration…" : "Restaurer"}</Button>;
}

/** Two-step deletion to the private trash, with an undo in the confirmation toast. */
/** `compact` hides the label on phones (feed rows); the accessible name stays "Supprimer". */
export function TrashButton({ id, redirectTo, beforeTrash, compact = false }: { id: string; redirectTo?: string; beforeTrash?: () => Promise<void>; compact?: boolean }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  async function confirm() {
    setPending(true);
    await beforeTrash?.();
    const result = await trashPublication(id);
    setPending(false);
    if (!result.ok) return void toast.error(`Suppression impossible : ${result.message}`);
    setConfirming(false);
    toast.success("Déplacée dans votre corbeille, visible par vous uniquement.", {
      action: { label: "Annuler", onClick: () => void restore(id).then((restored) => restored && router.refresh()) },
    });
    if (redirectTo) router.push(redirectTo);
    else router.refresh();
  }
  if (!confirming) {
    return (
      <Button size="sm" variant="ghost" className="h-8 rounded-full text-muted-foreground hover:bg-destructive/10 hover:text-destructive" onClick={() => setConfirming(true)}>
        <Trash2 /><span className={compact ? "sr-only sm:not-sr-only" : undefined}>Supprimer</span>
      </Button>
    );
  }
  return (
    <span role="group" aria-label="Confirmer la suppression" className="flex flex-wrap items-center gap-1 text-sm">
      <span>Mettre à la corbeille ?</span>
      <Button size="sm" variant="destructive" className="h-8 rounded-full" onClick={confirm} disabled={pending}>{pending ? "Déplacement…" : "Mettre à la corbeille"}</Button>
      <Button size="sm" variant="ghost" className="h-8 rounded-full" onClick={() => setConfirming(false)} disabled={pending}>Annuler</Button>
    </span>
  );
}
