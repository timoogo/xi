import { z } from "zod";
import { calendarSchema, currentInterval, everyDay, isOpen, isValidTimeZone, localDate, nextOpening, weekday, type Calendar } from "./calendar";

/**
 * Operating schedule of a ΞAgent: top-level `schedule` key of its generator file, beside
 * `editorial`, `watch` and `bloub`, which the other writers preserve. Calendars are permissions,
 * not activity: they never make an agent "working", they only allow work to start.
 *
 * - `watch`: when ordinary monitoring tasks (collection, discovery, evaluation, drafting) may start;
 * - `publish`: when publications may be made, on top of the existing ceilings and gates;
 * - `graceMinutes`: a task started inside the watch window may run that long after it closes;
 * - `catchUpHours`: after an involuntary outage, missed watch time is caught up within this limit;
 * - `majorEvents.enabled`: light off-hours detection and alerts outside the calendars, still
 *   bounded by the watch policy (alert threshold, verification, alert ceiling, interval);
 * - `retentionDays`: detailed execution logs of this agent (null: the global setting).
 *
 * Agents without the key keep their historical behaviour (`LEGACY_SCHEDULE`, `explicit: false`):
 * monitoring at any time, publications between 03:00 and 06:00 Paris time, alerts allowed.
 */
export const DEFAULT_GRACE_MINUTES = 30;
export const DEFAULT_CATCH_UP_HOURS = 72;
export const DEFAULT_RETENTION_DAYS = 30;

export const scheduleSchema = z.object({
  version: z.literal(1),
  timeZone: z.string().min(1).max(100).refine(isValidTimeZone, "Fuseau horaire IANA inconnu."),
  watch: calendarSchema,
  publish: calendarSchema,
  graceMinutes: z.number().int().min(0).max(240).default(DEFAULT_GRACE_MINUTES),
  catchUpHours: z.number().int().min(0).max(168).default(DEFAULT_CATCH_UP_HOURS),
  majorEvents: z.object({ enabled: z.boolean() }).strict().default({ enabled: false }),
  retentionDays: z.number().int().min(1).max(365).nullable().default(null),
}).strict();
export type Schedule = z.infer<typeof scheduleSchema>;

/**
 * Top-level `pause` key: when a pause started and, optionally, when and how it ends. Only read
 * while `watch.paused` is true, which stays the single switch every reader already honours.
 */
export const pauseSchema = z.object({
  since: z.iso.datetime(), resumeAt: z.iso.datetime().nullable(), resumeWith: z.enum(["now", "catch-up"]),
}).strict();
export type Pause = z.infer<typeof pauseSchema>;
export const storedScheduleSchema = scheduleSchema.extend({ revision: z.uuid(), updatedAt: z.iso.datetime(), updatedBy: z.string().min(1) });

export type ResolvedSchedule = Schedule & { explicit: boolean; valid: boolean; revision: string | null };

export const LEGACY_SCHEDULE: Schedule = {
  version: 1, timeZone: "Europe/Paris", watch: everyDay([{ start: 0, end: 1440 }]), publish: everyDay([{ start: 180, end: 360 }]),
  graceMinutes: DEFAULT_GRACE_MINUTES, catchUpHours: DEFAULT_CATCH_UP_HOURS, majorEvents: { enabled: true }, retentionDays: null,
};

/** Starting point offered by the creation flow (labelled as defaults, never as an AI proposal). */
export function defaultSchedule(timeZone: string): Schedule {
  return {
    version: 1, timeZone: isValidTimeZone(timeZone) ? timeZone : "Europe/Paris",
    watch: everyDay([{ start: 7 * 60, end: 23 * 60 }]), publish: everyDay([{ start: 180, end: 360 }]),
    graceMinutes: DEFAULT_GRACE_MINUTES, catchUpHours: DEFAULT_CATCH_UP_HOURS, majorEvents: { enabled: false }, retentionDays: null,
  };
}

/**
 * The stored value, or the legacy behaviour when absent. An unreadable value is reported
 * (`valid: false`) and closes both calendars: the agent does nothing until its owner rewrites it.
 */
export function readSchedule(raw: unknown): ResolvedSchedule {
  if (raw === undefined || raw === null) return { ...LEGACY_SCHEDULE, explicit: false, valid: true, revision: null };
  const parsed = storedScheduleSchema.safeParse(raw);
  if (!parsed.success) return { ...LEGACY_SCHEDULE, watch: everyDay([]), publish: everyDay([]), majorEvents: { enabled: false }, explicit: true, valid: false, revision: null };
  return { ...scheduleSchema.strip().parse(parsed.data), explicit: true, valid: true, revision: parsed.data.revision };
}

type Scheduled = { schedule?: ResolvedSchedule };
const resolved = (agent: Scheduled): ResolvedSchedule => agent.schedule ?? { ...LEGACY_SCHEDULE, explicit: false, valid: true, revision: null };
export const agentSchedule = resolved;

export const watchOpen = (agent: Scheduled, at: number) => { const s = resolved(agent); return isOpen(s.watch, s.timeZone, at); };
export const publishOpen = (agent: Scheduled, at: number) => { const s = resolved(agent); return isOpen(s.publish, s.timeZone, at); };
export const nextWatchOpening = (agent: Scheduled, at: number) => { const s = resolved(agent); return nextOpening(s.watch, s.timeZone, at); };
export const nextPublishOpening = (agent: Scheduled, at: number) => { const s = resolved(agent); return nextOpening(s.publish, s.timeZone, at); };
/** End of the open watch interval containing `at`, or null when closed. */
export const watchWindowEnd = (agent: Scheduled, at: number) => { const s = resolved(agent); return currentInterval(s.watch, s.timeZone, at)?.end ?? null; };
export const publishWindow = (agent: Scheduled, at: number) => { const s = resolved(agent); return currentInterval(s.publish, s.timeZone, at); };
/** Sunday in the agent's own time zone (weekly review). */
export const localSunday = (agent: Scheduled, at: number) => weekday(localDate(at, resolved(agent).timeZone)) === 6;

/** Calendar of one kind, for display and planning. */
export const calendarOf = (schedule: Schedule, kind: "watch" | "publish"): Calendar => schedule[kind];
