"use client";

import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DAY_MINUTES, WEEKDAYS, addDays, applyRanges, crossesMidnight, describeRanges, formatTime, hoursByDate, localDate, mergeRanges, parseTime, rangeMinutes, rangesForDate, weekday,
  type Calendar, type TimeRange,
} from "@/lib/xiagents/calendar";
import { cn } from "@/lib/utils";

/**
 * Editor of one permission calendar (watch or publication): weekly template, date exceptions,
 * heatmap of the coming weeks, day editor and grouped edits. Every interaction works with the
 * keyboard (no drag), every visual has a text equivalent; times can be typed precisely.
 * Ranges whose end is not after their start cross midnight; 00:00–00:00 is a full day.
 */
const WEEKS = 13;
const MAX_EXCEPTIONS = 400;
const LEVELS = ["bg-muted", "bg-primary/25", "bg-primary/45", "bg-primary/70", "bg-primary"] as const;
const level = (hours: number) => hours <= 0 ? 0 : hours < 6 ? 1 : hours < 12 ? 2 : hours < 18 ? 3 : 4;
const dateLabel = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const hoursLabel = (hours: number) => `${Number.isInteger(hours) ? hours : hours.toFixed(1).replace(".", ",")} h`;

type Target = { type: "weekday"; index: number } | { type: "date"; date: string };

/** 24-hour bar; a range crossing midnight is drawn as its two parts. */
export function Timeline({ ranges, spill = [], className }: { ranges: readonly TimeRange[]; spill?: readonly TimeRange[]; className?: string }) {
  const parts = (range: TimeRange) => crossesMidnight(range) ? [[range.start, DAY_MINUTES], [0, range.end]] : [[range.start, range.end]];
  return <div aria-hidden className={cn("relative h-3 w-full overflow-hidden rounded-full bg-muted", className)}>
    {[6, 12, 18].map(hour => <span key={hour} className="absolute inset-y-0 w-px bg-background" style={{ left: `${hour / 24 * 100}%` }} />)}
    {spill.map((range, i) => <span key={`s${i}`} className="absolute inset-y-0 bg-primary/40" style={{ left: 0, width: `${range.end / DAY_MINUTES * 100}%` }} />)}
    {ranges.flatMap(parts).map(([start, end], i) => <span key={i} className="absolute inset-y-0 bg-primary" style={{ left: `${start / DAY_MINUTES * 100}%`, width: `${(end - start) / DAY_MINUTES * 100}%` }} />)}
  </div>;
}

/** Ranges of the previous day that continue after midnight on this date. */
function spillOf(calendar: Calendar, date: string) {
  return rangesForDate(calendar, addDays(date, -1)).ranges.filter(crossesMidnight).map(range => ({ start: 0, end: range.end }));
}

export function CalendarEditor({ label, calendar, timeZone, onChange, now = Date.now() }: {
  label: string; calendar: Calendar; timeZone: string; onChange: (calendar: Calendar) => void; now?: number;
}) {
  const id = useId();
  const [editing, setEditing] = useState<Target | null>(null);
  const [days, setDays] = useState<number[]>([]);
  const [dates, setDates] = useState<string[]>([]);
  const [focused, setFocused] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const today = localDate(now, timeZone);
  const first = addDays(today, -weekday(today));
  const grid = useMemo(() => Array.from({ length: WEEKS * 7 }, (_, i) => addDays(first, i)), [first]);
  const hours = useMemo(() => hoursByDate(calendar, timeZone, grid), [calendar, timeZone, grid]);
  const cells = useRef(new Map<string, HTMLButtonElement>());
  const active = focused && grid.includes(focused) ? focused : today;
  const exceptionCount = Object.keys(calendar.exceptions).length;

  function setException(next: Calendar, date: string, ranges: TimeRange[]) {
    if (!Object.hasOwn(next.exceptions, date) && Object.keys(next.exceptions).length >= MAX_EXCEPTIONS) throw new Error(`Au plus ${MAX_EXCEPTIONS} exceptions par calendrier.`);
    next.exceptions[date] = ranges;
  }
  function save(target: Target, ranges: TimeRange[]) {
    const merged = mergeRanges(ranges);
    const next: Calendar = { week: calendar.week.map(day => [...day]), exceptions: { ...calendar.exceptions } };
    if (target.type === "weekday") next.week[target.index] = merged;
    else setException(next, target.date, merged);
    onChange(next);
  }
  function resetDate(date: string) {
    const exceptions = { ...calendar.exceptions };
    delete exceptions[date];
    onChange({ ...calendar, exceptions });
  }
  function move(event: KeyboardEvent, date: string) {
    const steps: Record<string, number> = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -7, ArrowRight: 7, Home: -weekday(date), End: 6 - weekday(date) };
    if (!(event.key in steps)) return;
    event.preventDefault();
    const target = addDays(date, steps[event.key]);
    if (!grid.includes(target)) return;
    setFocused(target);
    cells.current.get(target)?.focus();
  }
  const toggle = <T,>(list: T[], value: T) => list.includes(value) ? list.filter(item => item !== value) : [...list, value];
  const detail = rangesForDate(calendar, active);
  const detailSpill = spillOf(calendar, active);

  return <div className="space-y-5">
    <p className="sr-only" role="status" aria-live="polite">{notice}</p>
    <section aria-labelledby={`${id}-week`} className="space-y-2">
      <h4 id={`${id}-week`} className="font-medium">Semaine type</h4>
      <p className="text-xs text-muted-foreground">Cochez un ou plusieurs jours pour les modifier ensemble, ou ouvrez l’éditeur d’un jour.</p>
      <ul className="space-y-1">
        {WEEKDAYS.map((name, index) => <li key={name} className="grid grid-cols-[auto_5.5rem_1fr_auto] items-center gap-2">
          <input type="checkbox" id={`${id}-day-${index}`} checked={days.includes(index)} onChange={() => setDays(toggle(days, index))} aria-label={`Sélectionner ${name}`} className="size-4" />
          <label htmlFor={`${id}-day-${index}`} className="text-sm">{name}</label>
          <div className="min-w-0"><Timeline ranges={calendar.week[index]} /><p className="mt-0.5 truncate text-xs text-muted-foreground">{describeRanges(calendar.week[index])}</p></div>
          <Button type="button" size="sm" variant="ghost" onClick={() => setEditing({ type: "weekday", index })} aria-label={`Modifier les plages du ${name.toLowerCase()} (${label})`}>Modifier</Button>
        </li>)}
      </ul>
    </section>

    <section aria-labelledby={`${id}-heat`} className="space-y-2">
      <h4 id={`${id}-heat`} className="font-medium">Prochaines semaines</h4>
      <p id={`${id}-heat-help`} className="text-xs text-muted-foreground">Intensité = heures programmées (fuseau {timeZone}). Flèches pour se déplacer, Entrée ou Espace pour sélectionner une date, puis modifiez-la seule ou avec d’autres. Point = exception à la semaine type.</p>
      <div className="overflow-x-auto pb-1">
        <div role="group" aria-label={`${label} : heures programmées par date`} aria-describedby={`${id}-heat-help`} className="grid w-max grid-flow-col grid-rows-7 gap-1">
          {grid.map(date => {
            const value = hours.get(date) ?? 0;
            const { ranges, exception } = rangesForDate(calendar, date);
            const selected = dates.includes(date);
            return <button key={date} type="button" ref={node => { if (node) cells.current.set(date, node); else cells.current.delete(date); }}
              tabIndex={date === active ? 0 : -1} aria-pressed={selected}
              aria-label={`${dateLabel(date)}${date === today ? " (aujourd’hui)" : ""} : ${hoursLabel(value)} programmées${exception ? ", exception" : ""} — ${describeRanges(ranges)}`}
              title={`${date} · ${hoursLabel(value)} · ${describeRanges(ranges)}${exception ? " · exception" : ""}`}
              onFocus={() => setFocused(date)} onKeyDown={event => move(event, date)} onClick={() => { setFocused(date); setDates(toggle(dates, date)); }}
              className={cn("relative size-4 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring sm:size-5", LEVELS[level(value)], date < today && "opacity-50", selected && "ring-2 ring-foreground ring-offset-1 ring-offset-background", date === today && "outline outline-1 outline-foreground")}>
              {exception && <span aria-hidden className="absolute right-0.5 top-0.5 size-1.5 rounded-full border border-background bg-foreground" />}
            </button>;
          })}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground" aria-hidden>
        <span>0 h</span>{LEVELS.map(className => <span key={className} className={cn("size-3 rounded-sm", className)} />)}<span>24 h</span>
        <span className="ml-3 inline-flex items-center gap-1"><span className="relative size-3 rounded-sm bg-muted"><span className="absolute right-0 top-0 size-1.5 rounded-full bg-foreground" /></span>exception</span>
      </div>
      <div className="rounded-md border p-3 text-sm" aria-live="polite">
        <p className="font-medium first-letter:uppercase">{dateLabel(active)}{detail.exception ? " — exception" : " — semaine type"}</p>
        <Timeline ranges={detail.ranges} spill={detailSpill} className="my-2" />
        <p>Plages : {describeRanges(detail.ranges)} · {hoursLabel(hours.get(active) ?? 0)} ce jour-là</p>
        {detailSpill.length > 0 && <p className="text-xs text-muted-foreground">Suite de la veille après minuit : {describeRanges(detailSpill)}.</p>}
        <div className="mt-2 flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" onClick={() => setEditing({ type: "date", date: active })}>Modifier cette date</Button>
          {detail.exception && <Button type="button" size="sm" variant="ghost" onClick={() => { resetDate(active); setNotice(`${active} revient à la semaine type.`); }}>Revenir à la semaine type</Button>}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{exceptionCount} exception(s) enregistrée(s).</p>
    </section>

    <GroupEdit label={label} days={days} dates={dates} calendar={calendar} onClear={() => { setDays([]); setDates([]); }}
      onApply={(ranges, mode) => {
        const next: Calendar = { week: calendar.week.map(day => [...day]), exceptions: { ...calendar.exceptions } };
        for (const index of days) next.week[index] = applyRanges(next.week[index], ranges, mode);
        for (const date of dates) setException(next, date, applyRanges(rangesForDate(calendar, date).ranges, ranges, mode));
        onChange(next);
        setNotice(`${mode === "add" ? "Plages ajoutées" : "Plages remplacées"} sur ${days.length + dates.length} jour(s).`);
        setDays([]); setDates([]);
      }} />

    {editing && <DayEditor key={JSON.stringify(editing)} label={label} target={editing}
      initial={editing.type === "weekday" ? calendar.week[editing.index] : rangesForDate(calendar, editing.date).ranges}
      onCancel={() => setEditing(null)}
      onSave={ranges => { save(editing, ranges); setEditing(null); setNotice("Plages enregistrées."); }} />}
  </div>;
}

function TimeField({ label, value, onChange }: { label: string; value: number; onChange: (minutes: number) => void }) {
  return <label className="grid gap-1 text-xs">{label}
    <input type="time" step={300} required value={formatTime(value % DAY_MINUTES)} className="rounded-md border bg-background px-2 py-1.5 text-sm"
      onChange={event => { const minutes = parseTime(event.target.value); if (minutes !== null) onChange(minutes); }} />
  </label>;
}
/** End values are stored 1–1440: 00:00 as an end means midnight. */
const asEnd = (minutes: number) => minutes === 0 ? DAY_MINUTES : minutes;

function GroupEdit({ label, days, dates, calendar, onApply, onClear }: {
  label: string; days: number[]; dates: string[]; calendar: Calendar; onApply: (ranges: TimeRange[], mode: "add" | "replace") => void; onClear: () => void;
}) {
  const [range, setRange] = useState<TimeRange>({ start: 9 * 60, end: 18 * 60 });
  const [mode, setMode] = useState<"add" | "replace">("add");
  const [closed, setClosed] = useState(false);
  const id = useId();
  if (!days.length && !dates.length) return null;
  const ranges = closed ? [] : [range];
  const targets: [string, TimeRange[]][] = [
    ...days.map(index => [WEEKDAYS[index], calendar.week[index]] as [string, TimeRange[]]),
    ...[...dates].sort().map(date => [date, rangesForDate(calendar, date).ranges] as [string, TimeRange[]]),
  ];
  return <section aria-labelledby={`${id}-title`} className="space-y-3 rounded-md border border-primary/40 p-3">
    <h4 id={`${id}-title`} className="font-medium">Modification groupée — {targets.length} jour(s) ({label})</h4>
    <fieldset className="flex flex-wrap gap-4 text-sm"><legend className="sr-only">Mode</legend>
      <label className="flex items-center gap-1"><input type="radio" name={`${id}-mode`} checked={mode === "add"} onChange={() => setMode("add")} /> Ajouter aux plages existantes</label>
      <label className="flex items-center gap-1"><input type="radio" name={`${id}-mode`} checked={mode === "replace"} onChange={() => setMode("replace")} /> Remplacer les plages</label>
    </fieldset>
    {mode === "replace" && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={closed} onChange={event => setClosed(event.target.checked)} /> Journée fermée (aucune plage)</label>}
    {!closed && <div className="flex flex-wrap items-end gap-3">
      <TimeField label="Début" value={range.start} onChange={start => setRange({ ...range, start: Math.min(start, DAY_MINUTES - 1) })} />
      <TimeField label="Fin" value={range.end} onChange={end => setRange({ ...range, end: asEnd(end) })} />
      <p className="pb-2 text-xs text-muted-foreground">{crossesMidnight(range) ? "Se termine le lendemain." : ""} {Math.round(rangeMinutes(range) / 6) / 10} h</p>
    </div>}
    <div><p className="text-sm font-medium">Aperçu</p>
      <ul className="text-sm">{targets.map(([name, current]) => <li key={name}><span className="font-medium">{name}</span> : {describeRanges(current)} → <span className="font-medium">{describeRanges(applyRanges(current, ranges, mode))}</span></li>)}</ul>
      {dates.length > 0 && <p className="text-xs text-muted-foreground">Les dates modifiées deviennent des exceptions à la semaine type.</p>}
    </div>
    <div className="flex gap-2"><Button type="button" size="sm" onClick={() => onApply(ranges, mode)}>Appliquer</Button><Button type="button" size="sm" variant="ghost" onClick={onClear}>Annuler la sélection</Button></div>
  </section>;
}

function DayEditor({ label, target, initial, onSave, onCancel }: { label: string; target: Target; initial: TimeRange[]; onSave: (ranges: TimeRange[]) => void; onCancel: () => void }) {
  const [ranges, setRanges] = useState<TimeRange[]>(initial.map(range => ({ ...range })));
  const title = target.type === "weekday" ? `${WEEKDAYS[target.index]} (semaine type)` : dateLabel(target.date);
  const merged = mergeRanges(ranges);
  const update = (index: number, patch: Partial<TimeRange>) => setRanges(ranges.map((range, i) => i === index ? { ...range, ...patch } : range));
  return <Dialog open onOpenChange={open => { if (!open) onCancel(); }}>
    <DialogContent className="max-h-[90vh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle className="first-letter:uppercase">{title}</DialogTitle>
        <DialogDescription>{label}. Plages horaires sur 24 h ; une fin antérieure au début se termine le lendemain, 00:00–00:00 couvre la journée.{target.type === "date" ? " Enregistrer crée une exception pour cette date." : ""}</DialogDescription>
      </DialogHeader>
      <div className="space-y-1">
        <Timeline ranges={merged} />
        <div aria-hidden className="flex justify-between text-[10px] text-muted-foreground"><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>24:00</span></div>
      </div>
      <ul className="space-y-2">
        {ranges.map((range, index) => <li key={index} className="flex flex-wrap items-end gap-2 rounded-md border p-2">
          <TimeField label={`Début de la plage ${index + 1}`} value={range.start} onChange={start => update(index, { start: Math.min(start, DAY_MINUTES - 1) })} />
          <TimeField label={`Fin de la plage ${index + 1}`} value={range.end} onChange={end => update(index, { end: asEnd(end) })} />
          <span className="pb-2 text-xs text-muted-foreground">{crossesMidnight(range) ? "lendemain · " : ""}{Math.round(rangeMinutes(range) / 6) / 10} h</span>
          <Button type="button" size="sm" variant="ghost" onClick={() => setRanges(ranges.filter((_, i) => i !== index))} aria-label={`Supprimer la plage ${index + 1}`}>Supprimer</Button>
        </li>)}
      </ul>
      {!ranges.length && <p className="text-sm text-muted-foreground">Aucune plage : journée fermée.</p>}
      <Button type="button" variant="outline" size="sm" onClick={() => setRanges([...ranges, { start: 9 * 60, end: 12 * 60 }])}>Ajouter une plage</Button>
      {merged.length !== ranges.length && <p className="text-xs text-muted-foreground">Les plages qui se chevauchent seront fusionnées : {describeRanges(merged)}.</p>}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel}>Retour sans enregistrer</Button>
        <Button type="button" onClick={() => onSave(ranges)}>Enregistrer</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
