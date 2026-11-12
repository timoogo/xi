"use client";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { MessageCircle } from "lucide-react";
import { UserAvatar } from "@/components/user-avatar";
import type { XiAgentBloub } from "@/lib/xiagents/avatar";
import { useArticleComments } from "./feed-article";
import { references } from "@/lib/comments/references";
import { normalizeTag, topicHref } from "@/lib/search/query";
import { useRouter } from "next/navigation";

type Comment = { id: string; parent: string | null; root: string; owner: string; author: string; agent: string | null; body: string; state: string; created: number };
type Identity = { name: string; handle: string; ai?: boolean; image?: string | null; bloubSeed?: string | null; bloub?: XiAgentBloub };
type Agent = { id: string; name: string; handle: string; bloub?: XiAgentBloub };
type Topic = { id: string; tag: string; aliases: string[] };
type TopicLink = { comment_id: string; source_id: string; tag: string; topic_id: string | null; state: string; owned: boolean };
type Data = { comments: Comment[]; sequences: { comment_id: string; sequence_id: string }[]; agents: Agent[]; knownAgents: string[]; topics: Topic[]; topicLinks: TopicLink[]; declaredTopics: string[]; identities: Record<string, Identity> };
const handle = (value: string) => `@${value.replace(/^@/, "")}`;
function timeLabel(timestamp: number) {
  return new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(timestamp);
}

function commentText(body: string, agents: string[], topics: Topic[], identities: Record<string, Identity>) {
  const names = new Set(agents.map(agent => agent.replace(/^@/, "").toLowerCase()));
  const parts: ReactNode[] = []; let offset = 0;
  for (const ref of references(body)) {
    const token = ref.text.replace(/[.-]+$/, "");
    const tag = (ref.kind === "topic" ? normalizeTag(token) : token.slice(1).toLowerCase()) ?? "";
    const topic = ref.kind === "topic" ? topics.find(item => item.tag === tag) ?? topics.find(item => item.aliases.includes(tag)) : undefined;
    const human = ref.kind === "mention" ? Object.entries(identities).find(([, person]) => !person.ai && person.handle.replace(/^@/, "").toLowerCase() === tag) : undefined;
    parts.push(body.slice(offset, ref.start));
    if (topic) parts.push(<a key={ref.start} className="text-chart-2 hover:underline" href={topicHref(topic.tag)}>{token}</a>);
    else if (human) parts.push(<a key={ref.start} className="text-chart-2 hover:underline" href={`/dashboard/profiles/${encodeURIComponent(human[0])}`}>{human[1].name}</a>);
    else if (ref.kind === "mention" && names.has(tag)) parts.push(<a key={ref.start} className="text-chart-2 hover:underline" href={`/dashboard/profiles?handle=${encodeURIComponent(tag)}`}>{token}</a>);
    else parts.push(<span key={ref.start} className="text-chart-2">{token}</span>);
    parts.push(ref.text.slice(token.length)); offset = ref.end;
  }
  parts.push(body.slice(offset)); return parts;
}

export function InlineComments({ publicationId, viewerId, share, focusedCommentId }: { publicationId: string; viewerId: string; share?: ReactNode; focusedCommentId?: string }) {
  const router = useRouter();
  const article = useArticleComments();
  const open = article?.open ?? false;
  const [data, setData] = useState<Data>({ comments: [], sequences: [], agents: [], knownAgents: [], topics: [], topicLinks: [], declaredTopics: [], identities: {} });
  const [error, setError] = useState("");
  const [reply, setReply] = useState<string | null>(null);
  const url = `/api/publications/${publicationId}/comments${focusedCommentId ? `?focus=${encodeURIComponent(focusedCommentId)}` : ""}`;
  const commentHref = (id: string) => `/dashboard/publications/${publicationId}/comments/${id}`;
  const load = useCallback(async () => {
    try { const response = await fetch(url, { cache: "no-store" }); const result = await response.json(); if (!response.ok) throw new Error(result.error); setData(result); setError(""); }
    catch (e) { setError(e instanceof Error ? e.message : "Chargement impossible."); }
  }, [url]);
  useEffect(() => { if (!open) return; void load(); const timer = setInterval(() => void load(), 1000); return () => clearInterval(timer); }, [open, load]);
  async function send(payload: object) {
    try { const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }); const result = await response.json(); if (!response.ok) throw new Error(result.error); setData(result); setError(""); return true; }
    catch (e) { setError(e instanceof Error ? e.message : "Envoi impossible."); return false; }
  }
  const visible = data.comments.filter(c => c.state !== "waiting" && c.state !== "skipped");
  const byId = new Map(visible.map(comment => [comment.id, comment]));
  const sequences = new Map(data.sequences.map(item => [item.comment_id, item.sequence_id]));
  const children = new Map<string | null, Comment[]>();
  for (const comment of visible) {
    const siblings = children.get(comment.parent) ?? [];
    siblings.push(comment); children.set(comment.parent, siblings);
  }
  const identity = (c: Comment): Identity => data.identities[c.agent ?? c.owner] ?? { name: /^@?xi-[\w-]+$/i.test(c.author) ? "Utilisateur" : c.author, handle: c.agent ? c.author : "" };
  const label = (c: Comment) => c.agent ? handle(identity(c).handle) : identity(c).name;
  const viewer = data.identities[viewerId] ?? { name: "Vous", handle: "vous" };
  function tree(parent: string | null): ReactNode {
    return (children.get(parent) ?? []).map(c => {
      const author = identity(c);
      const parentComment = c.parent ? byId.get(c.parent) : undefined;
      const hasChildren = children.has(c.id);
      return <div key={c.id}>
        <div id={`comment-${c.id}`} aria-label={c.id === focusedCommentId ? "Commentaire sélectionné" : undefined} className={`flex gap-2.5 ${c.parent && !focusedCommentId ? "ml-2 sm:ml-4" : ""} ${c.id === focusedCommentId ? "-mx-2 rounded-lg bg-foreground/[0.045] px-2 pt-2" : "cursor-pointer hover:bg-foreground/[0.025]"}`} onClick={event => {
          if (c.id === focusedCommentId || event.defaultPrevented || event.button !== 0 || (event.target as Element).closest("a,button,form,input,textarea,select,label,[role=button]") || window.getSelection()?.toString()) return;
          if (event.metaKey || event.ctrlKey) window.open(commentHref(c.id), "_blank", "noopener");
          else router.push(commentHref(c.id));
        }}>
          <div className="relative flex w-10 shrink-0 justify-center">
            {c.parent && <span aria-hidden="true" className="absolute -top-2 left-1/2 h-3 w-px bg-border/80" />}
            {hasChildren && <span aria-hidden="true" className="absolute -bottom-2 left-1/2 top-10 w-px bg-border/80" />}
            <UserAvatar name={c.author} size={40} image={author.image} bloubSeed={author.bloubSeed} bloub={author.bloub} />
          </div>
          <div className="min-w-0 flex-1 pb-3.5 text-[15px] leading-5">
            <div className="flex flex-wrap items-baseline gap-x-1.5"><span className="font-semibold">{author.name}</span>{c.agent && <span className="text-muted-foreground">{handle(author.handle)}</span>}<span aria-hidden="true" className="text-muted-foreground">·</span><a href={commentHref(c.id)} aria-label={`Ouvrir le commentaire de ${author.name}`} className="text-[13px] text-muted-foreground hover:underline"><time dateTime={new Date(c.created).toISOString()}>{timeLabel(c.created)}</time></a></div>
            {parentComment && <a className="text-[13px] text-muted-foreground hover:underline" href={commentHref(parentComment.id)}>En réponse à <span className="text-chart-2">{label(parentComment)}</span></a>}
            <p className="mt-0.5 whitespace-pre-wrap break-words">{commentText(c.body, data.knownAgents, data.topics, data.identities)}</p>
            {data.topicLinks.filter(link => link.comment_id === c.id && link.owned && link.source_id === c.id && link.state === "error").map(link => <p key={link.tag} role="alert" className="mt-1 text-xs text-destructive">Topic #{link.tag} indisponible. <button className="underline" onClick={() => void send({ action: "retry-topic", id: c.id, tag: link.tag })}>Réessayer</button></p>)}
            {c.state === "running" && <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground" role="status"><span className="size-1.5 animate-pulse rounded-full bg-chart-2" />Génération en cours…</p>}
            {c.state === "error" && <p className="mt-1 text-sm text-destructive">Échec de la génération. {c.owner === viewerId && <button className="underline" onClick={() => void send({ action: "retry", id: c.id })}>Réessayer</button>}</p>}
            {c.state === "done" && c.id !== focusedCommentId && <button type="button" className="group mt-1 inline-flex items-center gap-1.5 rounded-full py-1 pr-2 text-xs text-muted-foreground transition-colors hover:text-chart-2 focus-visible:outline-2 focus-visible:outline-ring" onClick={() => setReply(reply === c.id ? null : c.id)} aria-expanded={reply === c.id}><MessageCircle aria-hidden="true" className="size-3.5 transition-transform motion-safe:group-hover:scale-110" />Répondre</button>}
            {reply === c.id && <CommentForm agents={data.agents} viewer={viewer} replyingTo={label(c)} initiallyOpen onClose={() => setReply(null)} submit={body => send({ action: "add", body, parent: c.id })} />}
            {c.id === focusedCommentId && c.state === "done" && <CommentForm agents={data.agents} viewer={viewer} replyingTo={label(c)} submit={body => send({ action: "add", body, parent: c.id })} />}
          </div>
        </div>
        {tree(c.id)}
        {!c.agent && data.comments.some(item => sequences.get(item.id) === c.id && item.state === "waiting" && item.owner === viewerId && !!byId.get(item.parent ?? "")?.agent) && !data.comments.some(item => sequences.get(item.id) === c.id && item.state === "running") && <button className="mb-4 ml-[50px] rounded-full px-2 py-1 text-sm font-medium text-chart-2 transition-colors hover:bg-chart-2/10 focus-visible:outline-2 focus-visible:outline-ring" onClick={() => void send({ action: "continue", root: c.id })}>Continuer +10</button>}
      </div>;
    });
  }
  return <div className="w-full min-w-0">
    <div aria-label="Interactions" className="ml-[52px] flex max-w-md items-center justify-between">
      <button type="button" aria-expanded={open} aria-label="Commentaires" className="inline-flex size-11 items-center justify-center rounded-full text-muted-foreground hover:bg-chart-2/10 hover:text-chart-2 focus-visible:outline-2 focus-visible:outline-ring" onClick={() => article?.toggle()}><MessageCircle aria-hidden="true" className="size-[18px]" /></button>{share}
    </div>
    {open && <section aria-label="Commentaires" className="pb-3" onClick={e => e.stopPropagation()}>
      {error && <p role="alert" className="text-sm text-destructive">{error} <button className="underline" onClick={() => void load()}>Réessayer</button></p>}
      {(data.declaredTopics.length > 0 || data.topicLinks.some(link => link.topic_id)) && <p className="mb-2 text-xs text-muted-foreground">Topics : {data.topics.filter(topic => data.declaredTopics.includes(topic.id) || data.topicLinks.some(link => link.topic_id === topic.id)).map(topic => <a key={topic.id} href={topicHref(topic.tag)} className="mr-2 text-chart-2 hover:underline">#{topic.tag}</a>)}</p>}
      {focusedCommentId ? <a className="ml-[50px] text-sm text-chart-2 hover:underline" href={`/dashboard/publications/${publicationId}`}>Voir la publication</a> : <CommentForm agents={data.agents} viewer={viewer} submit={body => send({ action: "add", body, parent: null })} />}
      <div className="mt-4">{tree(null)}</div>
    </section>}
  </div>;
}

function CommentForm({ agents, viewer, submit, replyingTo, initiallyOpen = false, onClose }: { agents: Agent[]; viewer: Identity; submit: (body: string) => Promise<boolean>; replyingTo?: string; initiallyOpen?: boolean; onClose?: () => void }) {
  const [open, setOpen] = useState(initiallyOpen), [value, setValue] = useState(""), [busy, setBusy] = useState(false);
  const [cursor, setCursor] = useState(0), [active, setActive] = useState(0), [dismissed, setDismissed] = useState(false), [above, setAbove] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null), highlight = useRef<HTMLDivElement>(null), composer = useRef<HTMLDivElement>(null), palette = useRef<HTMLDivElement>(null), pendingCaret = useRef<number | null>(null);
  const listId = useId();
  const before = value.slice(0, cursor);
  const match = before.match(/(?:^|\s)@([\w.-]*)$/);
  const query = match?.[1].toLowerCase();
  const results = query === undefined ? [] : agents.filter(a => a.handle.replace(/^@/, "").toLowerCase().includes(query) || a.name.toLowerCase().includes(query)).slice(0, 6);
  const showing = open && !dismissed && query !== undefined && results.length > 0;
  const selected = Math.min(active, results.length - 1);
  useEffect(() => { if (open) field.current?.focus(); }, [open]);
  useLayoutEffect(() => { const el = field.current; if (el) { el.style.height = "auto"; el.style.height = `${el.scrollHeight}px`; if (pendingCaret.current !== null) { el.focus(); el.setSelectionRange(pendingCaret.current, pendingCaret.current); pendingCaret.current = null; } } }, [value, open]);
  useLayoutEffect(() => {
    if (!showing) return;
    const reposition = () => {
      const box = composer.current?.getBoundingClientRect();
      if (box) setAbove(window.innerHeight - box.bottom < 220 && box.top > 220);
    };
    reposition(); window.addEventListener("resize", reposition); window.addEventListener("scroll", reposition, true);
    return () => { window.removeEventListener("resize", reposition); window.removeEventListener("scroll", reposition, true); };
  }, [showing, query]);
  useEffect(() => {
    const list = palette.current?.querySelector('[role="listbox"]');
    const option = document.getElementById(`${listId}-${selected}`);
    if (showing && list && option) {
      if (option.offsetTop < list.scrollTop) list.scrollTop = option.offsetTop;
      else if (option.offsetTop + option.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = option.offsetTop + option.offsetHeight - list.clientHeight;
    }
  }, [showing, selected, listId]);
  function close() { setValue(""); setDismissed(false); setOpen(false); onClose?.(); }
  function insert(agent: Agent) {
    if (!match) return;
    const start = cursor - match[1].length - 1;
    const next = value.slice(0, start) + handle(agent.handle) + " " + value.slice(cursor);
    const position = start + handle(agent.handle).length + 1;
    pendingCaret.current = position;
    setValue(next); setCursor(position); setDismissed(true);
  }
  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (showing && (event.key === "ArrowDown" || event.key === "ArrowUp")) { event.preventDefault(); setActive((selected + (event.key === "ArrowDown" ? 1 : results.length - 1)) % results.length); }
    else if (showing && event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); insert(results[selected]); }
    else if (event.key === "Escape" && showing) { event.preventDefault(); setDismissed(true); }
    else if (event.key === "Escape") { event.preventDefault(); close(); }
  }
  const spans: ReactNode[] = []; let offset = 0;
  for (const ref of references(value)) {
    spans.push(value.slice(offset, ref.start), <span key={ref.start} data-reference={ref.kind} className="text-chart-2">{ref.text}</span>); offset = ref.end;
  }
  spans.push(value.slice(offset), "\n");
  if (!open) return <button type="button" className="flex w-full items-center gap-2.5 rounded-md py-2 text-left text-[15px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring" onClick={() => setOpen(true)}><UserAvatar name={viewer.name} size={40} image={viewer.image} bloubSeed={viewer.bloubSeed} bloub={viewer.bloub} /><span>Écrire un commentaire…</span></button>;
  return <form className="flex gap-2.5 py-2" onSubmit={async e => { e.preventDefault(); if (!value.trim() || busy) return; setBusy(true); if (await submit(value)) close(); setBusy(false); }}>
    <UserAvatar name={viewer.name} size={40} image={viewer.image} bloubSeed={viewer.bloubSeed} bloub={viewer.bloub} />
    <div ref={composer} className="relative min-w-0 flex-1">
      {replyingTo && <p className="pt-0.5 text-xs text-muted-foreground">En réponse à <span className="text-chart-2">{replyingTo}</span></p>}
      <div className="relative">
        <div ref={highlight} aria-hidden="true" data-comment-highlight className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words border-b border-transparent py-2 text-[15px] leading-5 text-foreground" style={{ overflowWrap: "break-word" }}>{spans}</div>
        <textarea ref={field} aria-label="Votre commentaire" aria-autocomplete="list" aria-controls={showing ? listId : undefined} aria-activedescendant={showing ? `${listId}-${selected}` : undefined} className="relative block max-h-60 min-h-10 w-full resize-none border-b border-transparent bg-transparent py-2 text-[15px] leading-5 text-transparent caret-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-border selection:bg-chart-2/35" style={{ scrollbarWidth: "none", overflowWrap: "break-word" }} maxLength={10000} rows={1} value={value} onChange={e => { setValue(e.target.value); setCursor(e.target.selectionStart); setActive(0); setDismissed(false); }} onScroll={e => { if (highlight.current) { highlight.current.scrollTop = e.currentTarget.scrollTop; highlight.current.scrollLeft = e.currentTarget.scrollLeft; } }} onSelect={e => { setCursor(e.currentTarget.selectionStart); }} onKeyDown={keyDown} placeholder="Écrire un commentaire…" />
      </div>
      <div className="mt-1 flex items-center justify-end gap-1.5"><button type="button" aria-label="Fermer le composeur" className="rounded-full px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring" onClick={close} disabled={busy}>Annuler</button><button className="rounded-full bg-primary px-4 py-1.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-85 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-40" disabled={busy || !value.trim()}>{busy ? "Envoi…" : "Commenter"}</button></div>
      {showing && <div ref={palette} className={`absolute left-0 z-50 w-full max-w-[300px] overflow-hidden rounded-xl border bg-background text-foreground shadow-xl ${above ? "bottom-full mb-2" : "top-full mt-2"}`}><p className="px-3 pb-1 pt-2 text-[11px] font-medium text-muted-foreground">ΞAgents <span className="font-normal">· ↑↓ pour choisir</span></p><div id={listId} role="listbox" aria-label="Suggestions d’agents" className="max-h-48 overflow-y-auto p-1">{results.map((agent, index) => <div key={agent.id} id={`${listId}-${index}`} role="option" aria-selected={index === selected} onMouseDown={e => e.preventDefault()} onClick={() => insert(agent)} onMouseEnter={() => setActive(index)} className={`flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors ${index === selected ? "bg-accent" : "hover:bg-muted"}`}><UserAvatar name={agent.name} size={30} bloub={agent.bloub} /><span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-1.5"><span className="truncate text-sm font-medium">{agent.name}</span><span className="truncate text-xs text-muted-foreground">{handle(agent.handle)}</span></span>{index === selected && <span aria-hidden="true" className="text-xs text-muted-foreground">↵</span>}</div>)}</div></div>}
    </div>
  </form>;
}
