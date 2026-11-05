"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { SourceRow, TopicPick } from "@/lib/xiagents/draft";
import type { Schedule } from "@/lib/xiagents/schedule";
import { KonstruktorReview } from "./konstruktor-review";
import { MAX_MESSAGE, PROPOSAL_LABELS, TURN_LABELS, type KonstruktorMessage, type KonstruktorSession, type KonstruktorTarget, type Proposal, type SessionSummary } from "@/lib/konstruktor/types";

const POLL_MS = 1_500;
const IN_PROGRESS = new Set(["pending", "thinking", "unavailable"]);
const FIELD_LABELS: Record<string, string> = {
  name: "Nom", handle: "Handle", about: "Description", description: "Description", perimeter: "Périmètre", charter: "Charte", scope: "Périmètre du topic", topics: "Topics",
  settings: "Style", sources: "Sources", schedule: "Calendriers", autoPublish: "Publication autonome", limits: "Limites de publication", llm: "Modèle local", bloub: "Avatar Bloub",
};
const DAYS = ["lun", "mar", "mer", "jeu", "ven", "sam", "dim"];
const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
/** Short reading of a proposed value (the preview shows it in full and editable). */
function describe(key: string, value: unknown): string {
  if (key === "topics" && Array.isArray(value)) return (value as TopicPick[]).map(pick => pick.type === "new" ? `#${pick.draft.tag} (nouveau topic : ${pick.draft.name})` : pick.type === "existing" ? pick.reason ?? "Topic existant" : "Topic non résolu").join("\n");
  if (key === "sources" && Array.isArray(value)) return (value as SourceRow[]).map(row => `${row.domain} (à approuver)`).join("\n");
  if (key === "schedule") {
    const schedule = value as Schedule;
    const week = (calendar: Schedule["watch"]) => calendar.week.map((ranges, day) => ranges.length ? `${DAYS[day]} ${ranges.map(range => `${hhmm(range.start)}–${hhmm(range.end)}`).join(", ")}` : null).filter(Boolean).join(" · ") || "aucune plage";
    return `Veille : ${week(schedule.watch)}\nPublication : ${week(schedule.publish)}\nFuseau ${schedule.timeZone}, tolérance ${schedule.graceMinutes} min`;
  }
  if (key === "limits") { const limits = value as { maxPerDay: number; minIntervalMinutes: number }; return `${limits.maxPerDay} par jour au plus, ${limits.minIntervalMinutes} min d’intervalle`; }
  if (key === "autoPublish") return value ? "Oui (privée, si l’opérateur l’autorise)" : "Non";
  if (key === "llm") { const llm = value as { model: string; instanceId: string | null }; return `${llm.model || "modèle par défaut"}${llm.instanceId ? "" : " (instance par défaut)"}`; }
  if (key === "settings") { const settings = value as Record<string, string>; return `${settings.tone} · ${settings.audience} · ${settings.depth}`; }
  if (key === "bloub") { const bloub = value as Record<string, string>; return `${bloub.shape}, ${bloub.expression}, ${bloub.color}`; }
  return String(value);
}
const time = new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short" });

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init, headers: init?.body ? { "Content-Type": "application/json" } : undefined });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "Konstruktor indisponible. Réessayez.");
  return data as T;
}

function ProposalCard({ proposal }: { proposal: Proposal }) {
  const entries = Object.entries(proposal.change.patch);
  return <article aria-label="Proposition de Konstruktor" data-status={proposal.status} className="mt-2 rounded-lg border border-dashed p-3 text-sm">
    <p className="font-semibold">{proposal.summary}</p>
    <p className="text-xs text-muted-foreground">{PROPOSAL_LABELS[proposal.status]}</p>
    <dl className="mt-2 space-y-1">{entries.map(([key, value]) => <div key={key}>
      <dt className="text-xs font-medium text-muted-foreground">{FIELD_LABELS[key] ?? key}</dt>
      <dd className="whitespace-pre-wrap break-words">{describe(key, value)}</dd>
    </div>)}</dl>
    {proposal.notes.length ? <ul aria-label="Éléments non retenus" className="mt-2 list-disc pl-5 text-xs text-muted-foreground">{proposal.notes.map(note => <li key={note}>{note}</li>)}</ul> : null}
  </article>;
}

function Message({ message }: { message: KonstruktorMessage }) {
  const mine = message.role === "user";
  return <li data-role={message.role} className={`rounded-xl px-3 py-2 ${mine ? "ml-8 bg-muted" : "mr-8 border"}`}>
    <p className="text-xs font-semibold text-muted-foreground">{mine ? "Vous" : "@konstruktor"}</p>
    <p className="whitespace-pre-wrap break-words text-[15px]">{message.text}</p>
    {message.questions.length ? <ul aria-label="Questions de Konstruktor" className="mt-2 list-disc pl-5 text-sm">{message.questions.map(question => <li key={question}>{question}</li>)}</ul> : null}
    {message.unsupported.length ? <div className="mt-2 rounded-md bg-muted p-2 text-sm"><p className="text-xs font-semibold">Non pris en charge par Ξ (rien n’a été configuré pour cela) :</p>
      <ul aria-label="Demandes non prises en charge" className="list-disc pl-5">{message.unsupported.map(item => <li key={item}>{item}</li>)}</ul></div> : null}
    {message.proposals.map(proposal => <ProposalCard key={proposal.id} proposal={proposal} />)}
  </li>;
}

/**
 * Conversation with @konstruktor about one target (an existing Topic or ΞAgent, or one to create).
 * Opens on demand, resumes the latest conversation, lists the earlier ones and can start a new one.
 * Each message carries an idempotency key kept until it is accepted, so a retried send never
 * queues a second turn. The state of the turn is polled while the local model works on it.
 */
export function KonstruktorPanel({ target, intro }: { target: KonstruktorTarget; intro: string }) {
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [session, setSession] = useState<KonstruktorSession | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Same message, same key: a send retried after a network error is the same turn.
  const outgoing = useRef<{ text: string; requestId: string; sessionId: string } | null>(null);
  const query = `type=${target.type}${target.id ? `&id=${target.id}` : ""}`;
  // Discreet indicator: Konstruktor's suggestions still to examine about this ΞAgent or Topic.
  const [pending, setPending] = useState(0);
  useEffect(() => {
    if (target.type !== "agent" && target.type !== "topic") return;
    call<{ suggestions: { status: string }[] }>(`/api/konstruktor/suggestions?type=${target.type}&id=${target.id}`)
      .then(result => setPending(result.suggestions.filter(item => item.status === "pending").length), () => undefined);
  }, [target.type, target.id]);

  const load = useCallback(async (id: string) => {
    const { session } = await call<{ session: KonstruktorSession }>(`/api/konstruktor/sessions/${id}`);
    setSession(session);
    return session;
  }, []);

  useEffect(() => {
    if (!open || sessions) return;
    call<{ sessions: SessionSummary[] }>(`/api/konstruktor/sessions?${query}`)
      .then(({ sessions }) => { setSessions(sessions); if (sessions[0]) return load(sessions[0].id); })
      .catch(cause => setError(cause instanceof Error ? cause.message : "Conversations indisponibles."));
  }, [open, sessions, query, load]);

  const busy = !!session?.turn && IN_PROGRESS.has(session.turn.state);
  useEffect(() => {
    if (!busy || !session) return;
    const timer = setTimeout(() => { load(session.id).catch(() => setError("État non actualisé.")); }, POLL_MS);
    return () => clearTimeout(timer);
  }, [busy, session, load]);

  async function send() {
    const message = text.trim();
    if (!message || busy || sending) return;
    setSending(true); setError(null);
    try {
      let sessionId = session?.id;
      if (!sessionId) {
        const opened = await call<{ session: KonstruktorSession }>("/api/konstruktor/sessions", { method: "POST", body: JSON.stringify({ id: crypto.randomUUID(), target }) });
        sessionId = opened.session.id;
        setSessions(list => [opened.session, ...(list ?? [])]);
      }
      if (outgoing.current?.text !== message || outgoing.current.sessionId !== sessionId) outgoing.current = { text: message, requestId: crypto.randomUUID(), sessionId };
      const { session: next } = await call<{ session: KonstruktorSession }>(`/api/konstruktor/sessions/${sessionId}/messages`, { method: "POST", body: JSON.stringify({ requestId: outgoing.current.requestId, text: message }) });
      outgoing.current = null;
      setSession(next); setText("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Message non envoyé.");
    } finally { setSending(false); }
  }

  function startNew() { setSession(null); setText(""); setError(null); setReviewing(false); outgoing.current = null; }
  const [reviewing, setReviewing] = useState(false);
  const reviewable = !!session?.history.some(message => message.proposals.length);
  // A preview left in progress is reopened where the owner left it.
  useEffect(() => { if (session?.previewSaved) setReviewing(true); }, [session?.id, session?.previewSaved]);

  const turn = session?.turn;
  const status = turn && turn.state !== "done"
    ? `${TURN_LABELS[turn.state]}${turn.state === "unavailable" && turn.retryAt ? ` à ${time.format(turn.retryAt)}` : ""}${turn.message && turn.state === "error" ? ` : ${turn.message}` : ""}`
    : turn ? TURN_LABELS.done : null;

  return <details data-konstruktor={target.type} className="border-b" onToggle={event => setOpen((event.currentTarget as HTMLDetailsElement).open)}>
    <summary className="cursor-pointer px-4 py-3 font-bold"><span>Discuter avec @konstruktor</span>
      {pending ? <span data-suggestions={pending} className="ml-2 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">{pending} suggestion{pending > 1 ? "s" : ""}</span> : null}</summary>
    <section aria-labelledby={titleId} className="space-y-3 px-4 pb-4">
      <h2 id={titleId} className="sr-only">Conversation avec Konstruktor</h2>
      {pending ? <p className="text-sm"><Link className="underline" href={`/dashboard/konstruktor?${query}`}>Voir {pending > 1 ? `les ${pending} suggestions` : "la suggestion"} de Konstruktor</Link></p> : null}
      <p className="text-sm text-muted-foreground">{intro} Konstruktor utilise uniquement votre modèle local et ne modifie rien : ses propositions attendent votre validation.</p>
      <div className="flex flex-wrap items-center gap-2">
        {sessions?.length ? <Select items={sessions.map(item => ({ value: item.id, label: `${time.format(item.createdAt)} · ${item.messages} message${item.messages > 1 ? "s" : ""}` }))}
          value={session?.id ?? null} onValueChange={id => { if (id) load(id as string).catch(() => setError("Conversation indisponible.")); }}>
          <SelectTrigger size="sm" aria-label="Reprendre une conversation"><SelectValue placeholder="Reprendre une conversation" /></SelectTrigger>
          <SelectContent>{sessions.map(item => <SelectItem key={item.id} value={item.id}>{`${time.format(item.createdAt)} · ${item.messages} message${item.messages > 1 ? "s" : ""}`}</SelectItem>)}</SelectContent>
        </Select> : null}
        <Button type="button" variant="outline" size="sm" onClick={startNew} disabled={!session}>Nouvelle conversation</Button>
      </div>
      {session?.history.length ? <ol aria-label="Messages de la conversation" className="space-y-2">{session.history.map(message => <Message key={message.id} message={message} />)}</ol>
        : <p className="text-sm text-muted-foreground">{sessions === null && open ? "Chargement des conversations…" : "Nouvelle conversation : décrivez ce que vous souhaitez."}</p>}
      {reviewable && session ? (reviewing
        ? <KonstruktorReview key={session.id} session={session} onChanged={setSession} />
        : <Button type="button" variant="outline" size="sm" onClick={() => setReviewing(true)}>Revoir et appliquer les propositions</Button>) : null}
      <p role="status" aria-live="polite" data-turn={turn?.state ?? "none"} className={`text-sm ${turn?.state === "error" ? "text-destructive" : "text-muted-foreground"}`}>{status}</p>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      <form className="space-y-2" onSubmit={event => { event.preventDefault(); void send(); }}>
        <label htmlFor={`${titleId}-message`} className="sr-only">Message pour Konstruktor</label>
        <Textarea id={`${titleId}-message`} value={text} maxLength={MAX_MESSAGE} rows={3} onChange={event => setText(event.target.value)} placeholder="Votre message à @konstruktor" />
        <Button type="submit" size="sm" disabled={!text.trim() || busy || sending}>{busy ? "Konstruktor répond…" : sending ? "Envoi…" : "Envoyer"}</Button>
      </form>
    </section>
  </details>;
}
