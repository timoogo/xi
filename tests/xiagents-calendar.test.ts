import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyRanges, calendarSchema, currentInterval, describeRanges, emptyCalendar, everyDay, hoursByDate, intervals, isOpen, localDate,
  mergeRanges, nextOpening, parseTime, rangeMinutes, rangesForDate, weekday, zonedInstant, type Calendar,
} from "../src/lib/xiagents/calendar";
import { LEGACY_SCHEDULE, readSchedule, watchOpen, publishOpen, defaultSchedule } from "../src/lib/xiagents/schedule";

const H = 60;
const iso = (ms: number) => new Date(ms).toISOString();

test("calendar: overlapping, touching and duplicate ranges merge; add vs replace", () => {
  assert.deepEqual(mergeRanges([{ start: 9 * H, end: 12 * H }, { start: 11 * H, end: 14 * H }, { start: 9 * H, end: 12 * H }, { start: 14 * H, end: 15 * H }]), [{ start: 9 * H, end: 15 * H }]);
  const existing = [{ start: 8 * H, end: 10 * H }];
  assert.deepEqual(applyRanges(existing, [{ start: 9 * H, end: 11 * H }], "add"), [{ start: 8 * H, end: 11 * H }]);
  assert.deepEqual(applyRanges(existing, [{ start: 9 * H, end: 11 * H }], "replace"), [{ start: 9 * H, end: 11 * H }]);
  assert.deepEqual(applyRanges(existing, [{ start: 8 * H, end: 10 * H }], "add"), existing, "no duplicate");
  // A range crossing midnight merges with a late-evening one and keeps crossing.
  assert.deepEqual(mergeRanges([{ start: 22 * H, end: 2 * H }, { start: 21 * H, end: 23 * H }]), [{ start: 21 * H, end: 2 * H }]);
  // Never more than 24 h from the first start.
  assert.deepEqual(mergeRanges([{ start: 0, end: 1440 }, { start: 22 * H, end: 2 * H }]), [{ start: 0, end: 1440 }]);
  assert.equal(rangeMinutes({ start: 22 * H, end: 2 * H }), 4 * H);
  assert.equal(parseTime("24:00"), 1440); assert.equal(parseTime("7:5"), null); assert.equal(parseTime("25:00"), null);
  assert.equal(describeRanges([{ start: 22 * H, end: 2 * H }]), "22:00–02:00 (lendemain)");
});

test("calendar: weekly template, dated exceptions and validation", () => {
  const calendar: Calendar = { ...everyDay([{ start: 9 * H, end: 17 * H }]), exceptions: { "2026-12-25": [] , "2026-12-24": [{ start: 10 * H, end: 12 * H }] } };
  assert.equal(weekday("2026-10-26"), 0); assert.equal(weekday("2026-10-25"), 6);
  assert.deepEqual(rangesForDate(calendar, "2026-12-25"), { ranges: [], exception: true });
  assert.deepEqual(rangesForDate(calendar, "2026-12-24"), { ranges: [{ start: 10 * H, end: 12 * H }], exception: true });
  assert.equal(rangesForDate(calendar, "2026-12-23").exception, false);
  const hours = hoursByDate(calendar, "UTC", ["2026-12-23", "2026-12-24", "2026-12-25"]);
  assert.deepEqual([...hours.values()], [8, 2, 0]);
  assert.equal(calendarSchema.safeParse({ ...calendar, exceptions: { "2026-02-30": [] } }).success, false);
  assert.equal(calendarSchema.safeParse({ ...calendar, week: calendar.week.slice(1) }).success, false);
});

test("calendar: ranges crossing midnight split their hours between both dates and stay open across", () => {
  const calendar = everyDay([{ start: 22 * H, end: 2 * H }]);
  const hours = hoursByDate(calendar, "UTC", ["2026-10-20", "2026-10-21"]);
  assert.deepEqual([...hours.values()], [4, 4], "2 h after midnight from the previous day + 2 h before midnight");
  // An exception on the start date also removes the spill-over into the next date.
  const excepted: Calendar = { ...calendar, exceptions: { "2026-10-20": [] } };
  assert.deepEqual([...hoursByDate(excepted, "UTC", ["2026-10-20", "2026-10-21"]).values()], [2, 2]);
  const at = Date.parse("2026-10-21T01:30:00Z");
  assert.ok(isOpen(calendar, "UTC", at));
  const span = currentInterval(calendar, "UTC", Date.parse("2026-10-20T23:00:00Z"))!;
  assert.equal(iso(span.start), "2026-10-20T22:00:00.000Z"); assert.equal(iso(span.end), "2026-10-21T02:00:00.000Z");
  // Two days whose ranges touch at midnight form one continuous interval.
  const touching: Calendar = { week: [[{ start: 20 * H, end: 1440 }], [{ start: 0, end: 3 * H }], [], [], [], [], []], exceptions: {} };
  const joined = currentInterval(touching, "UTC", Date.parse("2026-10-19T23:00:00Z"))!; // Monday
  assert.equal(iso(joined.end), "2026-10-20T03:00:00.000Z");
});

test("calendar: time zones and daylight saving transitions (Europe/Paris)", () => {
  const tz = "Europe/Paris";
  // Spring forward 2026-03-29 02:00 → 03:00: 02:30 does not exist and is shifted forward by the gap.
  assert.equal(iso(zonedInstant("2026-03-29", 2 * H + 30, tz)), "2026-03-29T01:30:00.000Z");
  assert.equal(localDate(zonedInstant("2026-03-29", 2 * H + 30, tz), tz), "2026-03-29");
  // Fall back 2026-10-25 03:00 → 02:00: 02:30 is ambiguous, the earlier occurrence (CEST) is used.
  assert.equal(iso(zonedInstant("2026-10-25", 2 * H + 30, tz), ), "2026-10-25T00:30:00.000Z");
  const night = everyDay([{ start: 1 * H, end: 4 * H }]);
  const hours = hoursByDate(night, tz, ["2026-03-28", "2026-03-29", "2026-10-25"]);
  assert.deepEqual([...hours.values()], [3, 2, 4], "real hours: 3 normally, 2 in spring, 4 in autumn");
  const full = hoursByDate(everyDay([{ start: 0, end: 1440 }]), tz, ["2026-03-29", "2026-10-25"]);
  assert.deepEqual([...full.values()], [23, 25]);
  // Wall-clock opening in another zone.
  const calendar = everyDay([{ start: 9 * H, end: 10 * H }]);
  assert.ok(isOpen(calendar, "America/New_York", Date.parse("2026-07-01T13:30:00Z")));
  assert.ok(!isOpen(calendar, "America/New_York", Date.parse("2026-07-01T09:30:00Z")));
  assert.equal(iso(nextOpening(calendar, "Asia/Tokyo", Date.parse("2026-07-01T02:00:00Z"))!), "2026-07-02T00:00:00.000Z");
  assert.equal(nextOpening(emptyCalendar(), tz, Date.now(), 30), null);
  const list = intervals(calendar, "UTC", Date.parse("2026-07-01T09:30:00Z"), Date.parse("2026-07-02T09:15:00Z"));
  assert.deepEqual(list.map(span => [iso(span.start), iso(span.end)]), [["2026-07-01T09:30:00.000Z", "2026-07-01T10:00:00.000Z"], ["2026-07-02T09:00:00.000Z", "2026-07-02T09:15:00.000Z"]]);
});

test("schedule: legacy agents keep their behaviour; unreadable values close the calendars", () => {
  const legacy = readSchedule(undefined);
  assert.equal(legacy.explicit, false);
  assert.ok(watchOpen({ schedule: legacy }, Date.parse("2026-10-21T14:00:00Z")));
  assert.ok(publishOpen({ schedule: legacy }, Date.parse("2026-10-21T02:30:00Z")), "04:30 Paris");
  assert.ok(!publishOpen({ schedule: legacy }, Date.parse("2026-10-21T10:00:00Z")));
  assert.ok(publishOpen({}, Date.parse("2026-10-21T02:30:00Z")), "absent schedule = legacy");
  assert.deepEqual(LEGACY_SCHEDULE.majorEvents, { enabled: true });
  const broken = readSchedule({ version: 1, timeZone: "Nowhere/City" });
  assert.equal(broken.valid, false);
  assert.ok(!watchOpen({ schedule: broken }, Date.now()));
  assert.equal(defaultSchedule("Invalid/Zone").timeZone, "Europe/Paris");
});
