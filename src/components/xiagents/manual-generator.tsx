"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Textarea } from "@/components/ui/textarea";
import { labelTestMessage, testPublicationSummary } from "@/lib/publications/test-content";
import { Button } from "@/components/ui/button";
import { MarkdownView } from "@/components/publications/markdown-view";
import type { GeneratedContent, ManualChoice } from "@/lib/xiagents/generator";

export function ManualGenerator({ agentId, revision }: { agentId: string; revision: string }) {
  const router = useRouter();
  const [thread, setThread] = useState(false);
  const [visibility, setVisibility] = useState<"private" | "public">("private");
  const [count, setCount] = useState(3);
  const [preview, setPreview] = useState<{ choice: ManualChoice; content: GeneratedContent } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [published, setPublished] = useState<string | null>(null);
  function invalidate() { setPreview(null); setConfirmed(false); setError(""); setPublished(null); }
  async function request(action: "generate" | "publish") {
    setBusy(true); setError("");
    const choice = action === "publish" ? preview!.choice : { seed: crypto.randomUUID(), count: thread ? count : 1, accountRevision: revision };
    try {
      const response = await fetch(`/api/xiagents/${agentId}/publications`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...choice, action, ...(action === "publish" ? { confirmed, visibility, publicConfirmed: visibility === "public" && confirmed, messages: preview!.content.messages } : {}) }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Opération impossible. Réessayez.");
      if (action === "generate") { setPreview({ choice, content: result.preview }); setConfirmed(false); setPublished(null); }
      else { setPublished(result.publication.id); setPreview(null); setConfirmed(false); router.refresh(); }
    } catch (error) { setError(error instanceof Error ? error.message : "Opération impossible."); }
    finally { setBusy(false); }
  }
  return <section aria-labelledby="manual-generator" className="space-y-4 border-b p-4">
    <h2 id="manual-generator" className="text-lg font-bold">Générer des fixtures</h2>
    <p className="text-sm text-muted-foreground">Outil de test et de développement : contenu fictif généré localement, sans modèle ni source, marqué « Contenu de test fictif ». Choisissez la visibilité et modifiez les messages avant de publier sous l’identité du ΞAgent. Le marquage de test est conservé automatiquement.</p>
    <fieldset disabled={busy} className="flex flex-wrap items-end gap-3">
      <label className="grid gap-1">Format<select className="rounded-md border bg-background p-2" value={thread ? "thread" : "post"} onChange={event => { setThread(event.target.value === "thread"); invalidate(); }}><option value="post">Post simple</option><option value="thread">Thread</option></select></label>
      {thread && <label className="grid gap-1">Nombre de messages<select className="rounded-md border bg-background p-2" value={count} onChange={event => { setCount(Number(event.target.value)); invalidate(); }}>{Array.from({ length: 9 }, (_, i) => <option key={i + 2} value={i + 2}>{i + 2}</option>)}</select></label>}
      <label className="grid gap-1">Visibilité<select aria-label="Visibilité" className="rounded-md border bg-background p-2" value={visibility} onChange={event => { setVisibility(event.target.value as "private" | "public"); setConfirmed(false); }}><option value="private">Privé</option><option value="public">Public</option></select></label>
      <Button type="button" onClick={() => void request("generate")}>{preview ? "Régénérer" : "Générer"}</Button>
    </fieldset>
    {preview && <div className="space-y-4" aria-label="Aperçu avant publication">
      <h3 className="font-semibold">Aperçu · {preview.content.messages.length} message(s) · {visibility === "public" ? "Public" : "Privé"}</h3>
      <MarkdownView markdown={testPublicationSummary(preview.content.messages.length)} />
      <ol className="space-y-3">{preview.content.messages.map((body, i) => <li key={i} className="rounded-lg border p-3"><p className="mb-2 text-sm text-muted-foreground">Message {i + 1}</p><label className="mb-3 block text-sm">Markdown du message {i + 1}<Textarea className="mt-1 min-h-32 font-mono" maxLength={10_000} disabled={busy} value={body} onChange={event => { setPreview({ ...preview, content: { ...preview.content, messages: preview.content.messages.map((text, index) => index === i ? event.target.value : text) } }); setConfirmed(false); }} /></label><p className="mb-2 text-sm font-semibold">Aperçu final</p><MarkdownView markdown={labelTestMessage(body, i, preview.content.messages.length)} /></li>)}</ol>
      <label className="flex items-start gap-2"><input type="checkbox" className="mt-1" disabled={busy} checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />{visibility === "public" ? "Je confirme la publication publique de cet aperçu de test, visible par tous les utilisateurs de Ξ, sous l’identité du ΞAgent." : "Je confirme la publication privée de cet aperçu sous l’identité du ΞAgent."}</label>
      <Button type="button" disabled={busy || !confirmed || preview.content.messages.some(body => !body.trim())} onClick={() => void request("publish")}>Publier</Button>
    </div>}
    {busy && <p role="status">Traitement en cours…</p>}
    {published && <p role="status">Publication enregistrée. <Link className="underline" href={`/dashboard/publications/${published}`}>Voir la publication</Link> · <Link className="underline" href="/dashboard">Voir dans le feed</Link></p>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
  </section>;
}
