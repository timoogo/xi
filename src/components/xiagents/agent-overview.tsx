import type { ReactNode } from "react";
import { AlertTriangle, CalendarClock, Check, CircleDashed, Hourglass, Rss } from "lucide-react";
import type { ActivityItem, Attention, AttentionItem } from "@/lib/xiagents/attention";
import { CANDIDATE, LANE, OUTCOME } from "./labels";

/**
 * Top of the ΞAgent page: state and next windows, what needs the owner, and the autonomous
 * activity. Read-only; every action stays in its detailed section, reached through the links.
 */
const when = (iso: string) => new Date(iso).toLocaleString("fr-FR", { timeZone: "Europe/Paris", dateStyle: "medium", timeStyle: "short" });

type Status = { mode: string; tone: "ok" | "paused" | "off"; windows: string | null; control: { label: string } | null };
export function AgentStatus({ status }: { status: Status | null }) {
  if (!status) return <section aria-label="État du ΞAgent" className="border-b p-4 text-sm">Complétez la configuration éditoriale de ce ΞAgent pour le piloter.</section>;
  const dot = status.tone === "ok" ? "bg-emerald-500" : status.tone === "paused" ? "bg-amber-500" : "bg-muted-foreground";
  return <section aria-label="État du ΞAgent" className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b p-4 text-sm">
    <p className="flex items-center gap-2 font-medium"><span aria-hidden="true" className={`size-2 rounded-full ${dot}`} />{status.mode}</p>
    {status.windows && <p className="text-muted-foreground">{status.windows}</p>}
    {status.control && <a href="#xiagent-control" className="ml-auto inline-flex h-8 items-center rounded-md border px-3 font-medium hover:bg-accent">{status.control.label}</a>}
  </section>;
}

function Row({ item, icon, tone }: { item: AttentionItem; icon: ReactNode; tone: string }) {
  return <li className="flex gap-3 py-2">
    <span aria-hidden="true" className={`mt-0.5 shrink-0 [&>svg]:size-4 ${tone}`}>{icon}</span>
    <span className="min-w-0 flex-1">
      <a href={item.href} className="font-medium underline-offset-2 hover:underline">{item.label}</a>
      {(item.detail || item.at) && <span className="block break-words text-muted-foreground">{item.detail}{item.at ? ` ${item.detail ? "· " : ""}${when(item.at)}` : ""}</span>}
    </span>
  </li>;
}

export function AgentAttention({ attention }: { attention: Attention }) {
  const urgent = attention.blocked.length + attention.decisions.length > 0;
  const title = urgent ? "À faire maintenant" : attention.healthy ? "Tout fonctionne" : "Veille à l’arrêt";
  const intro = urgent ? null : attention.healthy ? "Aucune décision humaine requise : le ΞAgent poursuit sa veille et publie ses brouillons conformes selon ses règles."
    : "Aucune décision requise. Le ΞAgent ne collecte ni ne publie tant que sa veille est en pause, désactivée ou incomplète.";
  return <section aria-labelledby="xiagent-attention-title" className="space-y-2 border-b p-4 text-sm">
    <h2 id="xiagent-attention-title" className="flex items-center gap-2 text-lg font-bold">
      {urgent ? <AlertTriangle aria-hidden="true" className="size-5 text-amber-500" /> : attention.healthy ? <Check aria-hidden="true" className="size-5 text-emerald-500" /> : <CircleDashed aria-hidden="true" className="size-5 text-muted-foreground" />}
      {title}
    </h2>
    {intro && <p className="text-muted-foreground">{intro}</p>}
    {urgent && <ul className="divide-y">
      {attention.blocked.map(item => <Row key={item.label} item={item} icon={<AlertTriangle />} tone="text-destructive" />)}
      {attention.decisions.map(item => <Row key={item.label} item={item} icon={<AlertTriangle />} tone="text-amber-500" />)}
    </ul>}
    {(attention.scheduled.length > 0 || attention.waiting.length > 0) && <ul aria-label="Suivi automatique" className="divide-y">
      {attention.scheduled.map(item => <Row key={item.label} item={item} icon={<CalendarClock />} tone="text-sky-500" />)}
      {attention.waiting.map(item => <Row key={item.label} item={item} icon={<Hourglass />} tone="text-muted-foreground" />)}
    </ul>}
  </section>;
}

type LastFetch = { at: string; publisher: string; outcome: string; itemsNew: number } | null;
export function AgentActivity({ items, lastFetch, nextWindow }: { items: ActivityItem[]; lastFetch: LastFetch; nextWindow: string | null }) {
  return <section aria-labelledby="xiagent-activity-title" className="space-y-3 border-b p-4 text-sm">
    <h2 id="xiagent-activity-title" className="flex items-center gap-2 text-lg font-bold"><Rss aria-hidden="true" className="size-[18px] text-muted-foreground" />Activité autonome</h2>
    <p className="text-muted-foreground">{lastFetch ? <>Dernière collecte : {when(lastFetch.at)} · {lastFetch.publisher} · {OUTCOME[lastFetch.outcome] ?? lastFetch.outcome}{lastFetch.outcome === "ok" ? ` · ${lastFetch.itemsNew} nouveau(x)` : ""}</> : "Aucune collecte pour l’instant."}</p>
    {!items.length ? <p className="text-muted-foreground">Aucune actualité évaluée pour l’instant.</p>
      : <ul className="divide-y border-y">{items.map(item => <li key={item.storyId} className="flex gap-3 py-3">
        <span className="min-w-0 flex-1">
          <span className="block break-words font-medium">{item.title}</span>
          <span className="mt-1 block break-words text-muted-foreground">{item.scheduled ? `Publication automatique à la prochaine fenêtre${nextWindow ? ` (${when(nextWindow)})` : ""}, dans la limite des plafonds.` : item.reason}</span>
        </span>
        <span className="shrink-0 text-right text-xs text-muted-foreground">{item.scheduled ? "Programmée" : CANDIDATE[item.status] ?? item.status}{item.lane && <span className="block">{LANE[item.lane]}</span>}<span className="block">{when(item.updatedAt)}</span></span>
      </li>)}</ul>}
    <a href="#candidates-title" className="inline-block underline">Tous les candidats, brouillons et collectes</a>
  </section>;
}
