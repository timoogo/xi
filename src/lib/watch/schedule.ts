import { createHash } from "node:crypto";
import type { WatchPolicy } from "../accounts/types";

/** Editorial calendar: publications mainly between 03:00 and 06:00, Paris time (DST-aware). */
export const WATCH_TIME_ZONE = "Europe/Paris";
const WINDOW_START_HOUR = 3;
const WINDOW_END_HOUR = 6;
/** Agents are spread over the first 150 minutes, leaving time for their jobs inside the window. */
const SLOT_SPREAD_MINUTES = 150;
/** The weekly review runs after the agent's own window job. */
const WEEKLY_OFFSET_MINUTES = 10;
const DAY = 86_400_000;
const WEEK = 7 * DAY;

const formatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: WATCH_TIME_ZONE, hourCycle: "h23",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
});
type Day = { year: number; month: number; day: number };

export function zonedParts(date: Date) {
  const parts = Object.fromEntries(formatter.formatToParts(date).filter(part => part.type !== "literal").map(part => [part.type, Number(part.value)]));
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute, second: parts.second };
}

/** Paris wall-clock time → instant. Only used for 03:00–06:00, which exists exactly once every day. */
export function zonedTime({ year, month, day }: Day, hour: number, minute = 0) {
  const wanted = Date.UTC(year, month - 1, day, hour, minute);
  let guess = wanted;
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(new Date(guess));
    const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    if (shown === wanted) break;
    guess += wanted - shown;
  }
  return new Date(guess);
}

const addDays = ({ year, month, day }: Day, days: number): Day => {
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
};
const isoDay = ({ year, month, day }: Day) => `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

/** The night window open at `now`, or the next one. */
export function nightWindow(now: Date) {
  const p = zonedParts(now);
  const day = p.hour >= WINDOW_END_HOUR ? addDays(p, 1) : { year: p.year, month: p.month, day: p.day };
  return { date: isoDay(day), sunday: new Date(Date.UTC(day.year, day.month - 1, day.day)).getUTCDay() === 0, start: zonedTime(day, WINDOW_START_HOUR), end: zonedTime(day, WINDOW_END_HOUR) };
}
export type NightWindow = ReturnType<typeof nightWindow>;

export function inNightWindow(now: Date) {
  const window = nightWindow(now);
  return now >= window.start && now < window.end;
}

/** Stable per-agent offset, so agents do not all run at 03:00. */
export function agentSlot(agentId: string, window: NightWindow) {
  const offset = parseInt(createHash("sha256").update(agentId).digest("hex").slice(0, 8), 16) % SLOT_SPREAD_MINUTES;
  return new Date(window.start.getTime() + offset * 60_000);
}

export type Lane = "night" | "immediate" | "weekly";
export type GateReason = "auto-disabled" | "inactive" | "invalid-policy" | "disabled" | "paused" | "outside-window" | "not-weekly-window" | "recent-publication" | "interval" | "daily-cap";
export type Gate = { allowed: true } | { allowed: false; reason: GateReason; retryAt: Date | null };

/**
 * Whether an agent may publish now on a lane. No minimum quota: only ceilings.
 * `publishedAt`: the agent's publication instants (any order). `retryAt` is null when only a
 * configuration change can lift the refusal.
 */
export function publicationGate(input: { lane: Lane; now: Date; autoPublish: boolean; active: boolean; policyValid: boolean; policy: WatchPolicy; publishedAt: readonly Date[] }): Gate {
  const { lane, now, policy } = input;
  const refuse = (reason: GateReason, retryAt: Date | null = null): Gate => ({ allowed: false, reason, retryAt });
  if (!input.autoPublish) return refuse("auto-disabled");
  if (!input.active) return refuse("inactive");
  if (!input.policyValid) return refuse("invalid-policy");
  if (!policy.enabled) return refuse("disabled");
  if (policy.paused) return refuse("paused");
  const window = nightWindow(now);
  if (lane !== "immediate" && !inNightWindow(now)) return refuse("outside-window", window.start);
  const times = input.publishedAt.map(date => date.getTime()).filter(time => time <= now.getTime()).sort((a, b) => b - a);
  if (lane === "weekly") {
    if (!window.sunday) return refuse("not-weekly-window");
    if (times.length && now.getTime() - times[0] < WEEK) return refuse("recent-publication");
  }
  // When both apply, the binding one is reported: the one lifted last.
  const interval = times.length && now.getTime() - times[0] < policy.minIntervalMinutes * 60_000 ? times[0] + policy.minIntervalMinutes * 60_000 : null;
  const lastDay = times.filter(time => now.getTime() - time < DAY);
  const cap = lastDay.length >= policy.maxPerDay ? lastDay[policy.maxPerDay - 1] + DAY : null;
  if (cap !== null && (interval === null || cap >= interval)) return refuse("daily-cap", new Date(cap));
  if (interval !== null) return refuse("interval", new Date(interval));
  return { allowed: true };
}

export type PlannedJob = { kind: "publication-window" | "weekly-review"; key: string; runAfter: Date; payload: { agentId: string; date: string } };

/** Jobs an agent needs for the coming window. Keys are per agent and date: re-planning is idempotent. */
export function planAgentJobs(agent: { id: string; active: boolean; watch: { valid: boolean; policy: WatchPolicy } }, now: Date): PlannedJob[] {
  if (!agent.active || !agent.watch.valid || !agent.watch.policy.enabled || agent.watch.policy.paused) return [];
  const window = nightWindow(now);
  const slot = agentSlot(agent.id, window);
  const payload = { agentId: agent.id, date: window.date };
  const jobs: PlannedJob[] = [{ kind: "publication-window", key: `publication-window:${agent.id}:${window.date}`, runAfter: slot, payload }];
  if (window.sunday) jobs.push({ kind: "weekly-review", key: `weekly-review:${agent.id}:${window.date}`, runAfter: new Date(slot.getTime() + WEEKLY_OFFSET_MINUTES * 60_000), payload });
  return jobs;
}
