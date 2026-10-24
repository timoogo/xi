import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CalendarEditor } from "../src/components/xiagents/schedule/calendar-editor";
import { ScheduleForm } from "../src/components/xiagents/schedule/schedule-form";
import { contrast, READABLE_COLORS } from "../src/lib/bloub/colors";
import { everyDay } from "../src/lib/xiagents/calendar";
import { defaultSchedule } from "../src/lib/xiagents/schedule";

const now = Date.parse("2026-03-25T10:00:00Z");

test("calendar editor: text equivalents, exception marker, keyboard-reachable cells", () => {
  const calendar = { ...everyDay([{ start: 22 * 60, end: 2 * 60 }]), exceptions: { "2026-03-27": [] } };
  const html = renderToStaticMarkup(<CalendarEditor label="Calendrier de veille" calendar={calendar} timeZone="Europe/Paris" onChange={() => {}} now={now} />);
  // 13 weeks × 7 days, one tab stop (roving tabindex) on today.
  assert.equal((html.match(/aria-pressed="false"/g) ?? []).length, 91);
  assert.equal((html.match(/tabindex="0"/g) ?? []).length, 1);
  assert.match(html, /mercredi 25 mars 2026 \(aujourd’hui\) : 4 h programmées — 22:00–02:00 \(lendemain\)/);
  // Exception: closed day, but the previous evening still spills after midnight (2 h).
  assert.match(html, /vendredi 27 mars 2026 : 2 h programmées, exception — aucune plage/);
  // The closed Friday does not spill into Saturday: only 22:00–24:00.
  assert.match(html, /samedi 28 mars 2026 : 2 h programmées/);
  // DST night (29 March in Paris): 00:00 → 02:00 local ends at the shifted 03:00 CEST, still 2 real hours, plus 22:00–24:00.
  assert.match(html, /dimanche 29 mars 2026 : 4 h programmées/);
  assert.match(html, /Modifier les plages du lundi/);
  assert.match(html, /Suite de la veille après minuit : 00:00–02:00/);
});

test("schedule form: tabs and advanced settings are labelled", () => {
  const html = renderToStaticMarkup(<ScheduleForm value={defaultSchedule("Europe/Paris")} onChange={() => {}} />);
  assert.match(html, /role="tablist"/);
  assert.equal((html.match(/role="tab"/g) ?? []).length, 2);
  assert.match(html, /aria-selected="true"[^>]*>Veille</);
  assert.match(html, /Tolérance en fin de plage/);
  assert.match(html, /Rattrapage maximal/);
  assert.match(html, /Autoriser les exceptions pour événement majeur/);
});

test("bloub colours: only readable ones with white eyes, black first", () => {
  assert.equal(READABLE_COLORS[0].id, "encre");
  assert.ok(READABLE_COLORS.every(color => contrast(color.hex, "#ffffff") >= 3));
  assert.ok(!READABLE_COLORS.some(color => ["creme", "gris", "ambre"].includes(color.id)));
});
