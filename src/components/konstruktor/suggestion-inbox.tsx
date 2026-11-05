"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { SuggestionStatus, SuggestionView } from "@/lib/konstruktor/service";
import type { KonstruktorSession } from "@/lib/konstruktor/types";
import { KonstruktorReview } from "./konstruktor-review";

/**
 * Konstruktor's suggestions in one place: why each one is made, what it concerns, its status, and
 * its preview (L5's), where it is accepted (whole or in part), edited or refused. Nothing applies
 * without validating that preview. A review can be asked here; the worker also plans them.
 */
const GROUPS: { title: string; statuses: SuggestionStatus[] }[] = [
  { title: "En attente", statuses: ["pending"] },
  { title: "Validées", statuses: ["accepted", "failed"] },
  { title: "Appliquées", statuses: ["applied"] },
  { title: "Refusées", statuses: ["refused"] },
  { title: "Plus d’actualité", statuses: ["obsolete"] },
];
export const SUGGESTION_STATUS_LABELS: Record<SuggestionStatus, string> = {
  pending: "À examiner", accepted: "Validée : application en cours ou à reprendre", failed: "Application interrompue : à reprendre",
  applied: "Appliquée après votre validation", refused: "Refusée", obsolete: "Le problème a disparu : plus d’actualité",
};
type Filter = { type: "agent" | "topic"; id: string } | null;

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init, headers: init?.body !== undefined ? { "Content-Type": "application/json" } : undefined });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "Konstruktor indisponible. Réessayez.");
  return data as T;
}

function Preview({ suggestion, onChanged }: { suggestion: SuggestionView; onChanged: () => void }) {
  const [session, setSession] = useState<KonstruktorSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    call<{ session: KonstruktorSession }>(`/api/konstruktor/sessions/${suggestion.sessionId}`).then(result => setSession(result.session), cause => setError(cause instanceof Error ? cause.message : "Conversation indisponible."));
  }, [suggestion.sessionId]);
  if (error) return <p role="alert" className="text-sm text-destructive">{error}</p>;
  if (!session) return <p role="status" className="text-sm text-muted-foreground">Chargement de l’aperçu…</p>;
  return <div className="space-y-2">
    {session.history.filter(message => message.role === "assistant").map(message => <p key={message.id} className="whitespace-pre-wrap text-sm">{message.text}</p>)}
    {session.history.some(message => message.proposals.length)
      ? <KonstruktorReview session={session} onChanged={next => { setSession(next); onChanged(); }} />
      : <p className="text-sm text-muted-foreground">{suggestion.awaitingModel ? "Proposition en préparation par votre modèle local : elle apparaîtra au prochain bilan." : "Pas de correction automatique : discutez-en avec Konstruktor depuis la page concernée."}</p>}
  </div>;
}

function Item({ suggestion, open, onOpen, onChanged }: { suggestion: SuggestionView; open: boolean; onOpen: (open: boolean) => void; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function act(action: "refuse" | "restore") {
    setBusy(true); setError(null);
    try { await call(`/api/konstruktor/suggestions/${suggestion.id}`, { method: "POST", body: JSON.stringify({ action }) }); onChanged(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Décision non enregistrée."); }
    finally { setBusy(false); }
  }
  return <li data-suggestion={suggestion.kind} data-status={suggestion.status} className="space-y-2 rounded-xl border p-3">
    <p className="text-xs font-medium text-muted-foreground">{suggestion.kindLabel} · {new Date(suggestion.createdAt).toLocaleString("fr-FR")}</p>
    <h3 className="font-semibold">{suggestion.title}</h3>
    <p className="text-sm"><span className="font-medium">Pourquoi : </span>{suggestion.reason}</p>
    {suggestion.agents.length || suggestion.topics.length ? <p className="flex flex-wrap gap-2 text-sm">Concerne :
      {suggestion.agents.map(agent => <Link key={agent.id} className="underline" href={`/dashboard/xiagents/${agent.id}`}>@{agent.handle}</Link>)}
      {suggestion.topics.map(topic => <Link key={topic.id} className="underline" href={`/dashboard/topics/${topic.tag}`}>#{topic.tag}</Link>)}
    </p> : null}
    {suggestion.proposals.length ? <p className="text-sm text-muted-foreground">Proposition : {suggestion.proposals.map(proposal => proposal.summary).join(" · ")}</p> : null}
    <p className="text-xs">{SUGGESTION_STATUS_LABELS[suggestion.status]}</p>
    <div className="flex flex-wrap gap-2">
      <Button type="button" size="sm" variant={open ? "secondary" : "outline"} aria-expanded={open} onClick={() => onOpen(!open)}>{open ? "Fermer l’aperçu" : "Ouvrir l’aperçu"}</Button>
      {suggestion.status === "pending" || suggestion.status === "failed" ? <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void act("refuse")}>Refuser</Button> : null}
      {suggestion.status === "refused" ? <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void act("restore")}>Reconsidérer</Button> : null}
    </div>
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
  </li>;
}

export function SuggestionInbox({ focus, filter }: { focus: string | null; filter: Filter }) {
  const [suggestions, setSuggestions] = useState<SuggestionView[] | null>(null);
  const [opened, setOpened] = useState<string | null>(focus);
  const [review, setReview] = useState<{ requestId: string; state: string; message: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const query = filter ? `?type=${filter.type}&id=${filter.id}` : "";
  const current = suggestions?.find(item => item.id === opened) ?? null;
  const load = useCallback(() => call<{ suggestions: SuggestionView[] }>(`/api/konstruktor/suggestions${query}`).then(result => setSuggestions(result.suggestions), cause => setError(cause instanceof Error ? cause.message : "Propositions indisponibles.")), [query]);
  useEffect(() => { void load(); }, [load]);

  // A review asked here is followed until it ends, then the list is read again.
  const running = review && (review.state === "pending" || review.state === "running");
  useEffect(() => {
    if (!running) return;
    const timer = setTimeout(() => {
      call<{ request: { requestId: string; state: string; message: string | null } }>(`/api/konstruktor/reviews?requestId=${review.requestId}`)
        .then(result => { setReview(result.request); if (result.request.state === "done") void load(); }, () => setError("État du bilan non actualisé."));
    }, 1_000);
    return () => clearTimeout(timer);
  }, [running, review, load]);
  async function ask() {
    setError(null);
    try { const { request } = await call<{ request: { requestId: string; state: string; message: string | null } }>("/api/konstruktor/reviews", { method: "POST", body: "{}" }); setReview(request); if (request.state === "done") void load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Bilan impossible."); }
  }

  return <div className="space-y-4 p-4 pb-24">
    <p className="text-sm text-muted-foreground">Konstruktor examine périodiquement vos ΞAgents et vos Topics et propose des améliorations. Il ne modifie jamais rien lui-même : chaque proposition s’ouvre dans un aperçu que vous pouvez accepter en tout ou partie, modifier ou refuser, puis valider.</p>
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" variant="outline" size="sm" disabled={!!running} onClick={() => void ask()}>{running ? "Bilan en cours…" : "Lancer un bilan maintenant"}</Button>
      {filter ? <Link className="text-sm underline" href="/dashboard/konstruktor">Toutes les propositions</Link> : null}
      <p role="status" aria-live="polite" data-review={review?.state ?? "none"} className="text-sm text-muted-foreground">
        {review?.state === "done" ? "Bilan terminé." : review?.state === "failed" ? `Bilan interrompu : ${review.message ?? "erreur"}` : running ? "Konstruktor examine votre configuration…" : ""}
      </p>
    </div>
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    {/* Kept apart from the groups: validating moves the suggestion to another group, never the preview. */}
    {current ? <section aria-label="Proposition ouverte" data-open-suggestion={current.kind} className="space-y-2 rounded-xl border-2 p-3">
      <div className="flex flex-wrap items-center gap-2"><h2 className="font-bold">{current.title}</h2>
        <Button type="button" size="sm" variant="ghost" className="ml-auto" onClick={() => setOpened(null)}>Fermer l’aperçu</Button></div>
      <p className="text-sm"><span className="font-medium">Pourquoi : </span>{current.reason}</p>
      <Preview key={current.id} suggestion={current} onChanged={() => void load()} />
    </section> : null}
    {suggestions === null ? <p role="status" className="text-sm text-muted-foreground">Chargement des propositions…</p>
      : !suggestions.length ? <p className="text-sm">Aucune proposition pour le moment.</p>
      : GROUPS.map(group => {
        const items = suggestions.filter(item => group.statuses.includes(item.status));
        return items.length ? <section key={group.title} aria-label={group.title} className="space-y-2">
          <h2 className="font-bold">{group.title} ({items.length})</h2>
          <ul className="space-y-2">{items.map(item => <Item key={item.id} suggestion={item} open={opened === item.id} onOpen={open => setOpened(open ? item.id : null)} onChanged={() => void load()} />)}</ul>
        </section> : null;
      })}
  </div>;
}
