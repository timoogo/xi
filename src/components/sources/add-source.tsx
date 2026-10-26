"use client";
import { Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

type Topic = { id: string; tag: string };
type Known = { id: string; publisher: string; status: string };
const KNOWN_STATUS: Record<string, string> = { proposed: "en attente", approved: "approuvée", rejected: "refusée", disabled: "collecte désactivée" };

/**
 * « Ajouter une source »: a feed or site address (feed autodiscovery by the collector), attached to
 * topics followed by the owner's ΞAgents, created pending. A known address links to its page.
 */
export function AddSource({ topics }: { topics: Topic[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [topicIds, setTopicIds] = useState<string[]>(() => topics.length === 1 ? [topics[0].id] : []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [known, setKnown] = useState<Known | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError(""); setKnown(null);
    try {
      const response = await fetch("/api/watch/sources", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url, topicIds }) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error ?? "Ajout impossible. Réessayez.");
      if (result.duplicate) { setKnown(result.source); return; }
      setOpen(false);
      router.push(`/dashboard/sources/${result.source.id}`);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Ajout impossible."); }
    finally { setBusy(false); }
  }

  return <Dialog open={open} onOpenChange={next => { setOpen(next); if (!next) { setError(""); setKnown(null); } }}>
    <DialogTrigger asChild><Button type="button" size="sm"><Plus aria-hidden="true" className="size-4" />Ajouter une source</Button></DialogTrigger>
    <DialogContent className="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>Ajouter une source</DialogTitle>
        <DialogDescription>Adresse d’un flux RSS/Atom ou d’un site qui en publie un. La source est créée en attente : collectée et analysée, jamais suffisante seule pour publier.</DialogDescription>
      </DialogHeader>
      {!topics.length ? <p className="text-sm text-muted-foreground">Aucun de vos ΞAgents ne suit de topic : créez ou complétez un ΞAgent avant d’ajouter des sources.</p>
        : <form onSubmit={submit} className="grid gap-3 text-sm">
          <fieldset disabled={busy} className="grid gap-3">
            <div className="grid gap-1"><label htmlFor="new-source-url">Adresse</label>
              <Input id="new-source-url" required maxLength={2_000} inputMode="url" autoComplete="url" value={url} onChange={event => setUrl(event.target.value)} placeholder="https://exemple.fr/rss" /></div>
            <fieldset className="grid gap-1"><legend>Topics</legend>
              <div className="flex flex-wrap gap-3">{topics.map(topic => <label key={topic.id} className="inline-flex items-center gap-1.5">
                <input type="checkbox" checked={topicIds.includes(topic.id)} onChange={event => setTopicIds(event.target.checked ? [...topicIds, topic.id] : topicIds.filter(id => id !== topic.id))} />#{topic.tag}
              </label>)}</div>
            </fieldset>
          </fieldset>
          <div aria-live="polite">
            {busy && <p role="status">Lecture de l’adresse…</p>}
            {error && <p role="alert" className="text-destructive">{error}</p>}
            {known && <p role="status">Cette source est déjà dans votre catalogue ({KNOWN_STATUS[known.status] ?? known.status}) : <Link className="underline underline-offset-2" href={`/dashboard/sources/${known.id}`}>ouvrir {known.publisher}</Link>.</p>}
          </div>
          <DialogFooter>
            <Button type="submit" disabled={busy || !url.trim() || !topicIds.length}>Ajouter</Button>
          </DialogFooter>
        </form>}
    </DialogContent>
  </Dialog>;
}
