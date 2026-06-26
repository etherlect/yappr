import "./setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateSchedule, nextRunAt, describeSchedule } from "../src/cron/schedule.js";

// Cron schedule grammar + next-run math. The wall-clock/DST conversion is exactly
// the kind of date arithmetic that breaks silently, so we round-trip the result
// back through Intl and assert the local wall clock, which holds across DST.

test("validateSchedule: a valid interval", () => {
  assert.deepEqual(validateSchedule({ schedule: "interval", minutes: "30" }), { type: "interval", minutes: 30 });
});

test("validateSchedule: interval below the minimum is rejected", () => {
  const r = validateSchedule({ schedule: "interval", minutes: "1" });
  assert.ok("error" in r);
});

test("validateSchedule: daily requires an explicit timezone", () => {
  const r = validateSchedule({ schedule: "daily", time: "09:00" });
  assert.ok("error" in r && /timezone/i.test(r.error));
});

test("validateSchedule: daily rejects an unknown timezone", () => {
  assert.ok("error" in validateSchedule({ schedule: "daily", time: "09:00", timezone: "Mars/Phobos" }));
});

test("validateSchedule: a valid daily schedule", () => {
  assert.deepEqual(
    validateSchedule({ schedule: "daily", time: "09:00", timezone: "UTC" }),
    { type: "daily", time: "09:00", timezone: "UTC" },
  );
});

test("validateSchedule: unknown type is rejected", () => {
  assert.ok("error" in validateSchedule({ schedule: "weekly" }));
});

test("nextRunAt: interval adds the minutes", () => {
  const after = Date.UTC(2026, 0, 1, 0, 0);
  assert.equal(nextRunAt({ type: "interval", minutes: 15 }, after), after + 15 * 60_000);
});

test("validateSchedule: interval with a start time -> anchored interval", () => {
  const r = validateSchedule({ schedule: "interval", minutes: "120", time: "09:00", timezone: "UTC" });
  assert.ok(!("error" in r) && r.type === "interval");
  assert.equal(r.minutes, 120);
  assert.ok(r.anchor && r.anchor.time === "09:00" && r.anchor.timezone === "UTC");
  assert.match(r.anchor!.date, /^\d{4}-\d{2}-\d{2}$/); // date resolved at creation
});

test("validateSchedule: interval start time still requires a timezone", () => {
  assert.ok("error" in validateSchedule({ schedule: "interval", minutes: "120", time: "09:00" }));
});

test("validateSchedule: interval with an explicit start date", () => {
  assert.deepEqual(
    validateSchedule({ schedule: "interval", minutes: "120", time: "09:00", timezone: "UTC", date: "2026-12-25" }),
    { type: "interval", minutes: 120, anchor: { date: "2026-12-25", time: "09:00", timezone: "UTC" } },
  );
});

test("nextRunAt: anchored interval fires first at the start, then phase-aligned", () => {
  const sched = { type: "interval" as const, minutes: 120, anchor: { date: "2026-06-26", time: "09:00", timezone: "UTC" } };
  const at = (h: number, m = 0) => Date.UTC(2026, 5, 26, h, m);
  // before the start -> the first run IS the start time
  assert.equal(nextRunAt(sched, at(9) - 60_000), at(9));
  // exactly on a phase point -> strictly after -> the next one
  assert.equal(nextRunAt(sched, at(11)), at(13));
  // mid-phase (14:00) -> next aligned slot is 15:00
  assert.equal(nextRunAt(sched, at(14)), at(15));
});

test("describeSchedule: anchored interval", () => {
  assert.equal(
    describeSchedule({ type: "interval", minutes: 120, anchor: { date: "2026-06-26", time: "09:00", timezone: "UTC" } }),
    "every 120 min from 09:00 UTC (starting 2026-06-26)",
  );
});

// Read the HH:MM a given instant shows in a timezone (the invariant a daily schedule
// must hold, regardless of the UTC offset on that date).
function wallClock(ms: number, tz: string): string {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(ms);
  return `${p.find((x) => x.type === "hour")!.value}:${p.find((x) => x.type === "minute")!.value}`;
}

test("nextRunAt: daily lands on the target wall clock (UTC)", () => {
  const after = Date.UTC(2026, 5, 1, 12, 0);
  const t = nextRunAt({ type: "daily", time: "09:00", timezone: "UTC" }, after);
  assert.ok(t && t > after);
  assert.equal(wallClock(t!, "UTC"), "09:00");
});

test("nextRunAt: daily is DST-correct across spring-forward (Europe/Paris)", () => {
  // Paris springs forward on Sun 29 Mar 2026; from the day before, the next 09:00
  // must still read 09:00 local even though the UTC offset changed overnight.
  const after = Date.UTC(2026, 2, 28, 12, 0);
  const t = nextRunAt({ type: "daily", time: "09:00", timezone: "Europe/Paris" }, after);
  assert.ok(t);
  assert.equal(wallClock(t!, "Europe/Paris"), "09:00");
});

test("describeSchedule formats each kind", () => {
  assert.equal(describeSchedule({ type: "interval", minutes: 30 }), "every 30 min");
  assert.equal(describeSchedule({ type: "daily", time: "09:00", timezone: "UTC" }), "daily at 09:00 UTC");
});
