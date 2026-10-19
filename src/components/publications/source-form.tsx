"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { SourceFormInput } from "@/lib/publications/store";

const lines = (value: FormDataEntryValue | null) => String(value ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
const field = "mt-1 w-full rounded-md border bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

/** Every field comes from the author; Xi never completes or invents bibliographic data. */
export function SourceForm({ onSubmit, onCancel }: { onSubmit: (source: SourceFormInput) => Promise<boolean>; onCancel: () => void }) {
  const [pending, setPending] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setPending(true);
    const added = await onSubmit({
      url: String(data.get("url") ?? ""), title: String(data.get("title") ?? ""), publisher: String(data.get("publisher") ?? ""),
      publishedAt: String(data.get("publishedAt") ?? ""), facts: lines(data.get("facts")), reservations: lines(data.get("reservations")),
    });
    setPending(false);
    if (added) onCancel();
  }
  return (
    <form onSubmit={submit} className="mt-3 grid gap-3 rounded-xl border bg-muted/30 p-3 text-sm sm:grid-cols-2">
      <label className="sm:col-span-2">URL d’origine<Input name="url" type="url" required placeholder="https://" className="mt-1" /></label>
      <label>Titre<Input name="title" required maxLength={300} className="mt-1" /></label>
      <label>Média ou éditeur<Input name="publisher" required maxLength={200} className="mt-1" /></label>
      <label>Date de publication <span className="text-muted-foreground">(facultative, AAAA-MM-JJ)</span><Input name="publishedAt" pattern="\d{4}(-\d{2}(-\d{2})?)?" className="mt-1" /></label>
      <label className="sm:col-span-2">Faits utilisés <span className="text-muted-foreground">(un par ligne)</span><textarea name="facts" required rows={3} className={field} /></label>
      <label className="sm:col-span-2">Réserves <span className="text-muted-foreground">(facultatives, une par ligne)</span><textarea name="reservations" rows={2} className={field} /></label>
      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit" size="sm" disabled={pending}>{pending ? "Ajout…" : "Ajouter la note source"}</Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>Annuler</Button>
      </div>
    </form>
  );
}
