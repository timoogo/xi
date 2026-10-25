"use client";
import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { MarkdownView } from "@/components/publications/markdown-view";
import type { WatchDiagnostics } from "@/lib/watch/diagnostics";

type Draft = WatchDiagnostics["drafts"][number];
type Act = (task: () => Promise<unknown>, success: string) => Promise<void>;
const REVIEW = { pending: "Brouillon réel non publié · privé", rejected: "Brouillon rejeté", approved: "Approuvé · publié en privé" } as const;
const LANE: Record<string, string> = { night: "fenêtre nocturne", immediate: "alerte majeure", weekly: "bilan hebdomadaire" };
const score = (value: number | null) => (value === null ? "—" : value.toFixed(2));

async function review(agentId: string, draft: Draft, data: Record<string, unknown>) {
  const response = await fetch(`/api/xiagents/${agentId}/drafts/${draft.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: draft.revision, ...data }) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error ?? "Opération impossible. Réessayez.");
}

export function WatchDrafts({ agentId, drafts, busy, act }: { agentId: string; drafts: Draft[]; busy: boolean; act: Act }) {
  return <section aria-labelledby="drafts-title" className="space-y-2">
    <h3 id="drafts-title" className="font-semibold">Brouillons</h3>
    <p className="text-sm text-muted-foreground">Rédigés par le modèle local à partir des seules affirmations vérifiées, contrôlés par Ξ, puis enregistrés comme brouillons privés. Ce ne sont pas des contenus de test : ils ne sont jamais publiés automatiquement.</p>
    {!drafts.length ? <p className="text-sm text-muted-foreground">Aucun brouillon.</p> : <ul className="space-y-3">{drafts.map(draft => <DraftCard key={draft.id} agentId={agentId} draft={draft} busy={busy} act={act} />)}</ul>}
  </section>;
}

export function DraftCard({ agentId, draft, busy, act }: { agentId: string; draft: Draft; busy: boolean; act: Act }) {
  const [editing, setEditing] = useState<string[] | null>(null);
  const [confirm, setConfirm] = useState<"approve" | "reject" | null>(null);
  const pending = draft.review === "pending";
  return <li className="space-y-3 rounded-lg border p-3 text-sm" aria-label={`Brouillon ${draft.title}`}>
    <div>
      <p className="font-semibold break-words">{draft.title}</p>
      <p className="text-muted-foreground"><strong className={draft.review === "rejected" ? "text-destructive" : ""}>{REVIEW[draft.review]}</strong> · {draft.type === "thread" ? `thread de ${draft.messages.length} messages` : "post"}{draft.lane ? ` · ${LANE[draft.lane]}` : ""} · pertinence {score(draft.relevance)} · nouveauté {score(draft.novelty)} · importance {score(draft.importance)} · {draft.attempts} essai(s) de rédaction</p>
      {draft.reason && <p className="break-words">{draft.reason}</p>}
    </div>
    {draft.summary && <div><p className="font-medium">Résumé</p><MarkdownView markdown={draft.summary} /></div>}
    <ol className="space-y-3">{draft.messages.map((message, i) => <li key={message.file} className="rounded-md border p-3">
      <p className="mb-2 text-muted-foreground">Message {i + 1}{editing ? " · aperçu final" : ""}</p>
      {editing ? <>
        <label className="mb-2 block">Texte du message {i + 1} (les sources restent celles vérifiées)<Textarea className="mt-1 min-h-28" maxLength={10_000} value={editing[i]} disabled={busy} onChange={event => setEditing(editing.map((text, j) => (j === i ? event.target.value : text)))} /></label>
        <MarkdownView markdown={`${editing[i].trim()}\n\n${message.sources}`} />
      </> : <MarkdownView markdown={message.body} />}
    </li>)}</ol>
    <details>
      <summary className="cursor-pointer font-medium">Sources et justifications ({draft.sources.length})</summary>
      <ul className="mt-2 space-y-2">{draft.sources.map(source => <li key={source.file} className="break-words">
        <span className="font-medium">{source.title}</span> — {source.publisher}{source.date ? ` · ${source.date}` : ""}{source.url && <> · <a className="underline" href={source.url} target="_blank" rel="noopener noreferrer nofollow">article</a></>}
        {source.facts.length > 0 && <ul className="pl-4 text-muted-foreground">{source.facts.map((fact, i) => <li key={i}>« {fact} »</li>)}</ul>}
        {source.reservations.length > 0 && <p className="text-muted-foreground">Réserves : {source.reservations.join(" ")}</p>}
      </li>)}</ul>
      <p className="mt-2 text-muted-foreground">Les faits extraits, leur niveau de vérification et les scores détaillés figurent dans « Candidats éditoriaux ».</p>
    </details>
    <p><Link className="underline" href={`/dashboard/publications/${draft.id}`}>Ouvrir le rendu final</Link></p>
    {pending && <div className="flex flex-wrap gap-2">
      {editing ? <>
        <Button type="button" size="sm" disabled={busy || editing.some(text => !text.trim())} onClick={() => void act(async () => { await review(agentId, draft, { action: "update", messages: editing }); setEditing(null); }, "Brouillon modifié.")}>Enregistrer</Button>
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setEditing(null)}>Annuler</Button>
      </> : confirm ? <>
        <Button type="button" size="sm" variant={confirm === "reject" ? "destructive" : "default"} disabled={busy} onClick={() => void act(() => review(agentId, draft, { action: confirm }), confirm === "approve" ? "Brouillon approuvé et publié en privé." : "Brouillon rejeté.")}>{confirm === "approve" ? "Confirmer la publication privée" : "Confirmer le rejet"}</Button>
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setConfirm(null)}>Annuler</Button>
        {confirm === "approve" && <p className="w-full text-muted-foreground">Publication privée, visible par vous seul, pour tester le parcours de bout en bout. Aucune publication publique.</p>}
      </> : <>
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setEditing(draft.messages.map(message => message.prose))}>Modifier</Button>
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setConfirm("reject")}>Rejeter</Button>
        <Button type="button" size="sm" disabled={busy} onClick={() => setConfirm("approve")}>Approuver (publication privée)</Button>
      </>}
    </div>}
  </li>;
}
