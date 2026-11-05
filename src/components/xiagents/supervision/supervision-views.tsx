import Link from "next/link";
import { cn } from "@/lib/utils";
import { localMinutes, formatTime, type Interval } from "@/lib/xiagents/calendar";
import { RUN_KIND_LABELS } from "@/lib/xiagents/runs";
import { ACTIVITY_STATE_LABELS, QUEUE_STATE_LABELS, supervisionHref, type ActivityState, type SupervisionParams } from "@/lib/xiagents/supervision-shared";
import type { ActivityItem, CalendarDay, DayLane, QueueRow } from "@/lib/xiagents/supervision";

/** Read-only views of the supervision page (server components: no client state, no polling). */
type Names = { agents: Map<string, string>; topics: Map<string, string> };

const STATE_STYLE: Record<ActivityState, string> = {
  done: "bg-emerald-600", empty: "bg-muted-foreground/50", waiting: "bg-amber-500", retrying: "bg-orange-500", running: "bg-sky-500", error: "bg-destructive",
};
const DECISION_LABELS: Record<string, string> = {
  "decision:published": "Publication", "decision:deferred": "Publication reportée", "decision:abandoned": "Publication abandonnée", "decision:skipped": "Publication non tentée", "decision:selected": "Sélection hebdomadaire",
  arbitration: "Arbitrage de @arbitre",
};
const kindLabel = (kind: string) => DECISION_LABELS[kind] ?? RUN_KIND_LABELS[kind] ?? kind;
const percent = (value: number) => `${Math.round(value * 100)} %`;
const time = (at: number, timeZone: string) => new Intl.DateTimeFormat("fr-FR", { timeZone, hour: "2-digit", minute: "2-digit" }).format(at);
const dateTime = (at: number, timeZone: string) => new Intl.DateTimeFormat("fr-FR", { timeZone, dateStyle: "short", timeStyle: "short" }).format(at);
const longDate = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const hours = (value: number) => `${Number.isInteger(value) ? value : value.toFixed(1).replace(".", ",")} h`;

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">{children}</p>;
}
export function StateBadge({ state }: { state: ActivityState }) {
  return <span data-state={state} className="inline-flex items-center gap-1.5 text-xs font-medium"><span aria-hidden className={cn("size-2 rounded-full", STATE_STYLE[state])} />{ACTIVITY_STATE_LABELS[state]}</span>;
}

// ---------------------------------------------------------------- month

const LEVELS = ["bg-muted", "bg-primary/25", "bg-primary/45", "bg-primary/70", "bg-primary"] as const;
const level = (ratio: number) => ratio <= 0 ? 0 : ratio < 0.25 ? 1 : ratio < 0.5 ? 2 : ratio < 0.75 ? 3 : 4;

/** Heatmap: configured windows (two bars, share of the day covered over the agents) and real executions (counts). */
export function MonthHeatmap({ month, days, selected, today, agentCount, params }: { month: string; days: CalendarDay[]; selected: string; today: string; agentCount: number; params: SupervisionParams }) {
  const [year, monthIndex] = month.split("-").map(Number);
  const previous = new Date(Date.UTC(year, monthIndex - 2, 1)).toISOString().slice(0, 7), next = new Date(Date.UTC(year, monthIndex, 1)).toISOString().slice(0, 7);
  const lead = (new Date(`${month}-01T12:00:00Z`).getUTCDay() + 6) % 7;
  const capacity = 24 * Math.max(1, agentCount);
  const title = new Date(`${month}-01T12:00:00Z`).toLocaleDateString("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" });
  return <section aria-labelledby="supervision-month" className="space-y-3">
    <div className="flex flex-wrap items-center gap-2">
      <h2 id="supervision-month" className="text-lg font-bold first-letter:uppercase">{title}</h2>
      <div className="ml-auto flex gap-2 text-sm">
        <Link className="rounded-md border px-2 py-1 hover:bg-muted" href={supervisionHref(params, { month: previous, date: undefined })}>Mois précédent</Link>
        <Link className="rounded-md border px-2 py-1 hover:bg-muted" href={supervisionHref(params, { month: undefined, date: undefined })}>Aujourd’hui</Link>
        <Link className="rounded-md border px-2 py-1 hover:bg-muted" href={supervisionHref(params, { month: next, date: undefined })}>Mois suivant</Link>
      </div>
    </div>
    <ol aria-label="Jours du mois" className="grid grid-cols-7 gap-1 text-xs">
      {["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"].map(day => <li key={day} aria-hidden className="text-center font-medium text-muted-foreground">{day}</li>)}
      {Array.from({ length: lead }, (_, i) => <li key={`lead${i}`} aria-hidden />)}
      {days.map(day => {
        const label = `${longDate(day.date)}${day.date === today ? " (aujourd’hui)" : ""} : fenêtres de veille ${hours(day.watchHours)} (${day.watchAgents} ΞAgent(s)), de publication ${hours(day.publishHours)} (${day.publishAgents} ΞAgent(s)) ; ${day.future ? "à venir" : `${day.runs} exécution(s), ${day.errors} en erreur, ${day.published} publication(s)`}`;
        return <li key={day.date} data-date={day.date}>
          <Link href={supervisionHref(params, { month, date: day.date })} aria-label={label} aria-current={day.date === selected ? "date" : undefined} title={label}
            className={cn("flex min-h-16 flex-col gap-1 rounded-md border p-1 hover:bg-muted", day.date === selected && "ring-2 ring-foreground", day.date === today && "border-foreground", day.future && "border-dashed")}>
            <span className="font-medium">{Number(day.date.slice(8))}</span>
            <span aria-hidden className={cn("h-1.5 rounded-full", LEVELS[level(day.watchHours / capacity)])} />
            <span aria-hidden className={cn("h-1.5 rounded-full", level(day.publishHours / capacity) ? "bg-emerald-600" : "bg-muted", ["", "opacity-30", "opacity-50", "opacity-75", ""][level(day.publishHours / capacity)])} />
            <span aria-hidden className="mt-auto flex flex-wrap gap-x-1 leading-tight">
              {day.published > 0 && <span>{day.published}&nbsp;publ.</span>}
              {day.errors > 0 && <span className="font-semibold text-destructive">{day.errors}&nbsp;err.</span>}
            </span>
          </Link>
        </li>;
      })}
    </ol>
    <div aria-hidden className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
      <span className="inline-flex items-center gap-1"><span className="h-1.5 w-6 rounded-full bg-primary" />veille configurée</span>
      <span className="inline-flex items-center gap-1"><span className="h-1.5 w-6 rounded-full bg-emerald-600" />publication autorisée</span>
      <span>« publ. », « err. » : exécutions réelles</span>
      <span>Bordure pointillée : à venir</span>
    </div>
  </section>;
}

// ---------------------------------------------------------------- day

const union = (spans: Interval[][]) => spans.flat().sort((a, b) => a.start - b.start).reduce<Interval[]>((merged, span) => {
  const last = merged.at(-1);
  if (last && span.start <= last.end) last.end = Math.max(last.end, span.end); else merged.push({ ...span });
  return merged;
}, []);

function Track({ spans, start, end, className }: { spans: Interval[]; start: number; end: number; className: string }) {
  const at = (value: number) => `${(value - start) / (end - start) * 100}%`;
  return <div aria-hidden className="relative h-2 overflow-hidden rounded-full bg-muted">
    {spans.map(span => <span key={span.start} className={cn("absolute inset-y-0", className)} style={{ left: at(span.start), width: `${(span.end - span.start) / (end - start) * 100}%` }} />)}
  </div>;
}
const describe = (spans: Interval[], timeZone: string) => spans.length ? spans.map(span => `${time(span.start, timeZone)}–${time(span.end, timeZone)}`).join(", ") : "aucune";

/** One local date: configured windows per agent (and over all), then the executions of that day. */
export function DayTimeline({ day, timeZone, names, params }: { day: { date: string; start: number; end: number; hours: number[]; lanes: DayLane[]; activity: ActivityItem[] }; timeZone: string; names: Names; params: SupervisionParams }) {
  const { start, end } = day;
  const position = (value: number) => `${Math.min(100, Math.max(0, (value - start) / (end - start) * 100))}%`;
  const rows = day.lanes.length > 1 ? [{ agentId: "", handle: "Ensemble des ΞAgents", timeZone, explicit: true, status: "active" as const, watch: union(day.lanes.map(lane => lane.watch)), publish: union(day.lanes.map(lane => lane.publish)) }, ...day.lanes] : day.lanes;
  const STATUS = { active: "", paused: " · en pause", disabled: " · désactivé" };
  return <section aria-labelledby="supervision-day" className="space-y-3">
    <h2 id="supervision-day" className="text-lg font-bold first-letter:uppercase">{longDate(day.date)}</h2>
    <p className="text-xs text-muted-foreground">Fuseau {timeZone}{day.hours.length !== 24 ? ` · journée de ${day.hours.length} h (changement d’heure)` : ""}. Les fenêtres de publication sont des autorisations : le diffuseur central choisit le moment de chaque publication selon la queue éditoriale ; aucun horaire n’est réservé à l’avance.</p>
    <div aria-hidden className="relative ml-40 h-4 text-[10px] text-muted-foreground">
      {day.hours.map((at, index) => index % 3 === 0 && <span key={at} className="absolute -translate-x-1/2" style={{ left: position(at) }}>{formatTime(localMinutes(at, timeZone))}</span>)}
    </div>
    <ul aria-label="Fenêtres configurées et exécutions par ΞAgent" className="space-y-3">
      {rows.map(lane => {
        const items = lane.agentId ? day.activity.filter(item => item.agentId === lane.agentId) : [];
        return <li key={lane.agentId || "all"} data-lane={lane.agentId || "all"} className="grid grid-cols-[9.5rem_1fr] items-center gap-2 text-sm">
          <div className="min-w-0">
            <p className="truncate font-medium">{lane.agentId ? `@${lane.handle}` : lane.handle}</p>
            <p className="truncate text-xs text-muted-foreground">{STATUS[lane.status]}{lane.agentId && lane.timeZone !== timeZone ? ` · ${lane.timeZone}` : ""}{lane.agentId && !lane.explicit ? " · calendrier historique" : ""}</p>
          </div>
          <div className={cn("space-y-1", lane.status !== "active" && "opacity-50")}>
            <Track spans={lane.watch} start={start} end={end} className="bg-primary/70" />
            <Track spans={lane.publish} start={start} end={end} className="bg-emerald-600/80" />
            {lane.agentId && <div aria-hidden className="relative h-3">
              {items.map(item => <span key={`${item.type}${item.id}`} title={`${time(item.at, timeZone)} · ${kindLabel(item.kind)} · ${ACTIVITY_STATE_LABELS[item.state]}`}
                className={cn("absolute top-0.5 size-2 -translate-x-1/2", item.type === "decision" ? "rotate-45" : "rounded-full", STATE_STYLE[item.state])} style={{ left: position(item.at) }} />)}
            </div>}
            <p className="sr-only">Veille configurée : {describe(lane.watch, timeZone)} ; publication autorisée : {describe(lane.publish, timeZone)}{lane.agentId ? ` ; ${items.length} événement(s) réel(s)` : ""}.</p>
          </div>
        </li>;
      })}
    </ul>
    <div aria-hidden className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
      <span className="inline-flex items-center gap-1"><span className="h-2 w-6 rounded-full bg-primary/70" />veille configurée</span>
      <span className="inline-flex items-center gap-1"><span className="h-2 w-6 rounded-full bg-emerald-600/80" />publication autorisée</span>
      <span className="inline-flex items-center gap-1"><span className="size-2 rounded-full bg-foreground" />exécution réelle</span>
      <span className="inline-flex items-center gap-1"><span className="size-2 rotate-45 bg-foreground" />décision de publication</span>
    </div>
    <h3 className="font-medium">Ce qui s’est réellement passé</h3>
    {day.activity.length ? <ActivityList items={day.activity} timeZone={timeZone} names={names} params={params} timeOnly /> : <Empty>Aucune exécution ni décision enregistrée ce jour-là pour cette sélection.</Empty>}
  </section>;
}

// ---------------------------------------------------------------- activity

export function ActivityList({ items, timeZone, names, params, timeOnly = false }: { items: ActivityItem[]; timeZone: string; names: Names; params: SupervisionParams; timeOnly?: boolean }) {
  return <ol aria-label="Exécutions et décisions" className="divide-y rounded-xl border">
    {items.map(item => <li key={`${item.type}:${item.id}`} data-activity={item.type} data-state={item.state} className="space-y-1 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <time dateTime={new Date(item.at).toISOString()} className="tabular-nums text-muted-foreground">{timeOnly ? time(item.at, timeZone) : dateTime(item.at, timeZone)}</time>
        <span className="font-medium">{kindLabel(item.kind)}</span>
        <span className="text-muted-foreground">{item.agentId ? `@${names.agents.get(item.agentId) ?? "ΞAgent"}` : "Instance"}</span>
        <StateBadge state={item.state} />
        {item.type === "run" && item.maxAttempts !== null && item.maxAttempts > 1 && <span className="text-xs text-muted-foreground">tentative {item.attempt}/{item.maxAttempts}</span>}
      </div>
      {item.storyTitle && <p>« {item.storyTitle} » {item.storyId && params.story !== item.storyId && <Link className="text-xs underline" href={supervisionHref({ ...params, view: "activity", date: undefined, month: undefined, state: undefined }, { story: item.storyId })}>Historique de cette actualité</Link>}</p>}
      {item.reason && <p className="break-words text-muted-foreground">{item.reason}</p>}
    </li>)}
  </ol>;
}

// ---------------------------------------------------------------- queue

const QUEUE_STYLE = { ready: "bg-sky-500", published: "bg-emerald-600", withdrawn: "bg-muted-foreground/50", expired: "bg-amber-500" } as const;
const ARBITRATION_LABELS = { pending: "en attente de décision", favorable: "prioritaire : oui", refused: "prioritaire : non", unavailable: "arbitre indisponible", disabled: "arbitre désactivé", expired: "délai dépassé", obsolete: "actualité obsolète" } as const;

/** The editorial queue as stored: read-only (publishing stays with the diffuser and its checks). */
export function QueueList({ rows, timeZone, names, params }: { rows: QueueRow[]; timeZone: string; names: Names; params: SupervisionParams }) {
  return <ol aria-label="Contenus de la queue éditoriale" className="divide-y rounded-xl border">
    {rows.map(row => <li key={row.draftId} data-queue={row.state} className="space-y-1 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="inline-flex items-center gap-1.5 text-xs font-medium"><span aria-hidden className={cn("size-2 rounded-full", QUEUE_STYLE[row.state])} />{QUEUE_STATE_LABELS[row.state]}</span>
        <span className="font-medium">« {row.title ?? "Actualité sans titre"} »</span>
      </div>
      <p className="text-muted-foreground">
        @{names.agents.get(row.agentId) ?? "ΞAgent"}{row.topicId ? ` · #${names.topics.get(row.topicId) ?? "Topic indisponible"}` : ""}
        {` · ${row.lane === "immediate" ? "alerte" : row.weekly ? "bilan hebdomadaire" : "circuit normal"}`}
      </p>
      <dl className="flex flex-wrap gap-x-4 text-xs">
        <div className="flex gap-1"><dt>Importance</dt><dd className="font-medium">{percent(row.importance)}</dd></div>
        <div className="flex gap-1"><dt>Pertinence</dt><dd className="font-medium">{percent(row.relevance)}</dd></div>
        <div className="flex gap-1"><dt>Fraîcheur</dt><dd className="font-medium">{percent(row.freshness)}</dd></div>
        <div className="flex gap-1"><dt>Prêt le</dt><dd>{dateTime(row.readyAt, timeZone)}</dd></div>
        <div className="flex gap-1"><dt>{row.state === "ready" ? "Expire le" : "Sorti le"}</dt><dd>{dateTime(row.state === "ready" ? row.expiresAt : row.updatedAt, timeZone)}</dd></div>
      </dl>
      {row.state === "ready" ? <p data-wait={row.wait?.code ?? "eligible"} className="text-xs">
        {row.wait ? <>En attente : {row.wait.reason}{row.wait.retryAt ? ` Au plus tôt le ${dateTime(row.wait.retryAt, timeZone)}.` : ""}</> : "Éligible : le diffuseur central la tentera à son prochain passage, après les contrôles de publication."}
      </p> : row.reason && <p className="break-words text-muted-foreground">Motif : {row.reason}</p>}
      {row.arbitration && <p className="text-xs">@arbitre : {ARBITRATION_LABELS[row.arbitration.status]}{row.arbitration.justification ? ` — ${row.arbitration.justification}` : ""}</p>}
      <Link className="text-xs underline" href={supervisionHref({ ...params, view: "activity", state: undefined }, { story: row.storyId })}>Historique de cette actualité</Link>
    </li>)}
  </ol>;
}
