import { z } from "zod";

/**
 * Activity calendars of a ΞAgent: a recurring week plus dated exceptions, in the agent's own IANA
 * time zone. Pure and client-safe (the editor and the worker share it).
 *
 * A range is `{ start, end }` in minutes of wall-clock time: `start` in 0–1439, `end` in 1–1440.
 * `end <= start` means the range crosses midnight and ends the next day (22:00–02:00); a range
 * whose end equals its start covers 24 hours. A range belongs to the day it starts on: an
 * exception for a date replaces that date's ranges, including the part spilling into the next day.
 *
 * Wall-clock → instant follows the "compatible" rule of Temporal:
 * - a non-existent time (spring-forward gap) is shifted forward by the gap length
 *   (02:30 on the last Sunday of March in Paris becomes 03:30 CEST);
 * - an ambiguous time (fall-back overlap) takes its earlier occurrence (02:30 CEST).
 * A range is therefore followed on the wall clock: 01:00–04:00 lasts 2 real hours on the
 * spring-forward night and 4 on the fall-back night. Hour counts use real durations.
 */
export const DAY_MINUTES = 1440;
const MINUTE = 60_000;
const DAY_MS = 86_400_000;

export const timeRangeSchema = z.object({ start: z.number().int().min(0).max(DAY_MINUTES - 1), end: z.number().int().min(1).max(DAY_MINUTES) }).strict();
export type TimeRange = z.infer<typeof timeRangeSchema>;
export const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}, "Date invalide.");
const dayRanges = z.array(timeRangeSchema).max(24);
export const calendarSchema = z.object({
  /** Monday first. */
  week: z.array(dayRanges).length(7),
  exceptions: z.record(isoDateSchema, dayRanges).refine(value => Object.keys(value).length <= 400, "Trop d’exceptions."),
}).strict();
export type Calendar = z.infer<typeof calendarSchema>;
export const WEEKDAYS = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"] as const;

export const rangeMinutes = (range: TimeRange) => range.end > range.start ? range.end - range.start : range.end + DAY_MINUTES - range.start;
export const crossesMidnight = (range: TimeRange) => range.end <= range.start;

/** Sorted ranges without overlaps or duplicates: overlapping or touching ranges are merged. */
export function mergeRanges(ranges: readonly TimeRange[]): TimeRange[] {
  const spans = ranges.map(range => [range.start, range.start + rangeMinutes(range)] as [number, number]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [];
  for (const [start, end] of spans) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  // A day never schedules more than 24 hours from its first start.
  return merged.map(([start, end]) => {
    const length = Math.min(end - start, DAY_MINUTES);
    const stop = start + length;
    return { start, end: stop > DAY_MINUTES ? stop - DAY_MINUTES : stop };
  });
}

/** Grouped edit: add (merged with the existing ranges) or replace them. */
export const applyRanges = (existing: readonly TimeRange[], ranges: readonly TimeRange[], mode: "add" | "replace") =>
  mergeRanges(mode === "add" ? [...existing, ...ranges] : ranges);

export const formatTime = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
/** "HH:MM" → minutes; "24:00" is accepted as an end of day. */
export function parseTime(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return Number(match[2]) < 60 && minutes <= DAY_MINUTES ? minutes : null;
}
export const describeRange = (range: TimeRange) => `${formatTime(range.start)}–${formatTime(range.end)}${crossesMidnight(range) ? " (lendemain)" : ""}`;
export const describeRanges = (ranges: readonly TimeRange[]) => ranges.length ? ranges.map(describeRange).join(", ") : "aucune plage";

// ---------------------------------------------------------------- dates

export function addDays(date: string, days: number) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
/** 0 = Monday … 6 = Sunday. */
export function weekday(date: string) {
  const [y, m, d] = date.split("-").map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}
export function rangesForDate(calendar: Calendar, date: string): { ranges: TimeRange[]; exception: boolean } {
  const exception = Object.hasOwn(calendar.exceptions, date);
  return { ranges: exception ? calendar.exceptions[date] : calendar.week[weekday(date)], exception };
}
export const emptyCalendar = (): Calendar => ({ week: Array.from({ length: 7 }, () => []), exceptions: {} });
export const everyDay = (ranges: TimeRange[]): Calendar => ({ week: Array.from({ length: 7 }, () => ranges.map(range => ({ ...range }))), exceptions: {} });

// ---------------------------------------------------------------- time zones

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string) {
  let value = formatters.get(timeZone);
  if (!value) {
    value = new Intl.DateTimeFormat("en-GB", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    formatters.set(timeZone, value);
  }
  return value;
}
export function isValidTimeZone(timeZone: string) {
  try { formatter(timeZone); return true; } catch { return false; }
}
function wallClock(ms: number, timeZone: string) {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(new Date(ms)).filter(part => part.type !== "literal").map(part => [part.type, Number(part.value)]));
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute, second: parts.second };
}
/** UTC offset in minutes at an instant. */
export function offsetAt(ms: number, timeZone: string) {
  const p = wallClock(ms, timeZone);
  return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000) / MINUTE);
}
export function localDate(ms: number, timeZone: string) {
  const p = wallClock(ms, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}
export function localMinutes(ms: number, timeZone: string) {
  const p = wallClock(ms, timeZone);
  return p.hour * 60 + p.minute;
}

/** Instant of a wall-clock time (see the module comment for gaps and overlaps). `minutes` may be 1440. */
export function zonedInstant(date: string, minutes: number, timeZone: string) {
  if (minutes >= DAY_MINUTES) return zonedInstant(addDays(date, 1), minutes - DAY_MINUTES, timeZone);
  const [y, m, d] = date.split("-").map(Number);
  const wall = Date.UTC(y, m - 1, d, 0, minutes);
  const before = offsetAt(wall - 14 * 3_600_000, timeZone);
  const after = offsetAt(wall + 14 * 3_600_000, timeZone);
  const valid = [...new Set([before, after])].map(offset => wall - offset * MINUTE).filter(ms => offsetAt(ms, timeZone) * MINUTE === wall - ms).sort((a, b) => a - b);
  // Overlap: earlier occurrence. Gap: the offset in force before it, i.e. shifted forward by the gap.
  return valid.length ? valid[0] : wall - before * MINUTE;
}

export type Interval = { start: number; end: number };

/** Open intervals (UTC ms) of a calendar overlapping [from, to), merged across days and clipped. */
export function intervals(calendar: Calendar, timeZone: string, from: number, to: number): Interval[] {
  if (to <= from) return [];
  const spans: Interval[] = [];
  const last = localDate(to, timeZone);
  for (let date = addDays(localDate(from, timeZone), -1); date <= last; date = addDays(date, 1)) {
    for (const range of rangesForDate(calendar, date).ranges) {
      const start = zonedInstant(date, range.start, timeZone);
      const end = zonedInstant(date, range.start + rangeMinutes(range), timeZone);
      if (end > start) spans.push({ start, end });
    }
  }
  spans.sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  for (const span of spans) {
    const previous = merged.at(-1);
    if (previous && span.start <= previous.end) previous.end = Math.max(previous.end, span.end);
    else merged.push({ ...span });
  }
  return merged.filter(span => span.end > from && span.start < to).map(span => ({ start: Math.max(span.start, from), end: Math.min(span.end, to) }));
}

/** The open interval containing `at` (seen up to two days around it), or null. */
export function currentInterval(calendar: Calendar, timeZone: string, at: number): Interval | null {
  return intervals(calendar, timeZone, at - 2 * DAY_MS, at + 2 * DAY_MS).find(span => span.start <= at && span.end > at) ?? null;
}
export const isOpen = (calendar: Calendar, timeZone: string, at: number) => currentInterval(calendar, timeZone, at) !== null;
/** Next opening at or after `at` (`at` itself when open), within `horizonDays`; null when the calendar is empty. */
export function nextOpening(calendar: Calendar, timeZone: string, at: number, horizonDays = 400): number | null {
  for (let from = at; from < at + horizonDays * DAY_MS; from += 30 * DAY_MS) {
    const found = intervals(calendar, timeZone, from, Math.min(from + 30 * DAY_MS, at + horizonDays * DAY_MS))[0];
    if (found) return found.start;
  }
  return null;
}
/** Total open time inside [from, to). */
export const openMs = (calendar: Calendar, timeZone: string, from: number, to: number) =>
  intervals(calendar, timeZone, from, to).reduce((total, span) => total + span.end - span.start, 0);

/** Real scheduled hours of each local date (a range crossing midnight counts on both dates). */
export function hoursByDate(calendar: Calendar, timeZone: string, dates: readonly string[]) {
  return new Map(dates.map(date => {
    const start = zonedInstant(date, 0, timeZone);
    const end = zonedInstant(addDays(date, 1), 0, timeZone);
    return [date, openMs(calendar, timeZone, start, end) / 3_600_000] as const;
  }));
}
