import { config } from "../config.js";

// Schedule grammar for cron jobs. Three forms, chosen to match how people phrase
// requests on X ("every 30min", "in one hour", "every day at 9am Paris time"):
//
//   interval — recurring, every N minutes from each run.
//   once     — one-shot: either relative ("in N minutes") or absolute
//              (date? + time + timezone; date omitted = the next occurrence).
//   daily    — recurring, every day at HH:MM in an IANA timezone.
//
// Timezones are IANA names ("Europe/Paris", "UTC") resolved via Intl, so daily
// schedules follow DST like a human expects. An absolute time WITHOUT a timezone
// is rejected — the error message tells the model to ask the user, never to guess.
export type Schedule =
  | { type: "interval"; minutes: number }
  | { type: "once"; minutes?: number; date?: string; time?: string; timezone?: string }
  | { type: "daily"; time: string; timezone: string };

const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/; // HH:MM, 24h
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;          // YYYY-MM-DD

function validTimezone(tz: string): boolean {
  // Intl is the source of truth for zone names: constructing a formatter with an
  // unknown timeZone throws a RangeError. "UTC" is itself a valid IANA zone.
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Build a validated Schedule from the raw string params the LLM passed to the
// skill. Returns `{ error }` with a message written FOR the model (it becomes the
// skill observation), so a bad request turns into a helpful reply to the user.
export function validateSchedule(raw: Record<string, string>): Schedule | { error: string } {
  const type = raw.schedule;

  if (type === "interval") {
    const minutes = Number(raw.minutes);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      return { error: `interval schedules need a positive "minutes" param (got "${raw.minutes}")` };
    }
    if (minutes < config.cronMinIntervalMin) {
      return { error: `interval too short — the minimum is every ${config.cronMinIntervalMin} minute${config.cronMinIntervalMin === 1 ? "" : "s"}` };
    }
    return { type: "interval", minutes: Math.round(minutes) };
  }

  if (type === "once") {
    if (raw.minutes !== undefined && raw.minutes !== "") {
      const minutes = Number(raw.minutes);
      if (!Number.isFinite(minutes) || minutes <= 0) {
        return { error: `one-shot relative schedules need a positive "minutes" param (got "${raw.minutes}")` };
      }
      return { type: "once", minutes: Math.round(minutes) };
    }
    // Absolute one-shot: time (+ optional date) in an explicit timezone.
    const abs = validateWallClock(raw, "a one-shot at a specific time");
    if ("error" in abs) return abs;
    return { type: "once", date: raw.date || undefined, time: abs.time, timezone: abs.timezone };
  }

  if (type === "daily") {
    const abs = validateWallClock(raw, "a daily schedule");
    if ("error" in abs) return abs;
    return { type: "daily", time: abs.time, timezone: abs.timezone };
  }

  return { error: `unknown schedule type "${type}" — use "interval", "once" or "daily"` };
}

// Shared validation for wall-clock (time + timezone) schedules. The timezone is
// REQUIRED by design: if the user didn't state one, the agent must ask, not guess.
function validateWallClock(
  raw: Record<string, string>,
  what: string,
): { time: string; timezone: string } | { error: string } {
  if (!raw.time || !TIME_RE.test(raw.time)) {
    return { error: `${what} needs a "time" param in 24h HH:MM format (got "${raw.time ?? ""}")` };
  }
  if (!raw.timezone) {
    return {
      error: `${what} needs an explicit timezone — ask the user which timezone they mean (an IANA name like Europe/Paris, America/New_York, or UTC)`,
    };
  }
  if (!validTimezone(raw.timezone)) {
    return { error: `unknown timezone "${raw.timezone}" — ask the user for an IANA timezone name like Europe/Paris or UTC` };
  }
  if (raw.date && !DATE_RE.test(raw.date)) {
    return { error: `"date" must be YYYY-MM-DD (got "${raw.date}")` };
  }
  return { time: raw.time, timezone: raw.timezone };
}

// ── Wall-clock → instant conversion ─────────────────────────────────────────
//
// JS has no native "instant for 09:00 on 2026-06-12 in Europe/Paris". Intl can
// only go the other way (instant → zone-local wall time), so we invert it by
// fixed-point iteration:
//
//   1. guess: treat the wall time as if it were UTC → t0
//   2. format t0 in the target zone, measure how far the result is from the
//      wanted wall time, and shift the guess by that difference
//   3. repeat once — the zone offset is piecewise-constant, so this converges
//      in ≤2 steps even across DST transitions.
//
// DST edge cases (documented, accepted): a nonexistent local time (the
// spring-forward gap, e.g. 02:30 the night clocks jump) resolves ~1h shifted;
// an ambiguous time (fall-back hour) resolves to one of the two instants.

// Wall-clock fields of `t` in `timeZone`, read via Intl (en-CA gives YYYY-MM-DD).
function wallParts(t: number, timeZone: string): { y: number; mo: number; d: number; h: number; mi: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(t);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { y: get("year"), mo: get("month"), d: get("day"), h: get("hour"), mi: get("minute") };
}

// Epoch ms of `y-mo-d hh:mm` wall time in `timeZone` (fixed-point, see above).
function zonedTimeToInstant(y: number, mo: number, d: number, hh: number, mm: number, timeZone: string): number {
  let t = Date.UTC(y, mo - 1, d, hh, mm);
  for (let i = 0; i < 2; i++) {
    const w = wallParts(t, timeZone);
    const diff = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi) - Date.UTC(y, mo - 1, d, hh, mm);
    t -= diff;
  }
  return t;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Next occurrence of `s` strictly after `after` (epoch ms). Returns null for a
// spent one-shot (absolute time already in the past — the runner treats overdue
// one-shots separately; at creation the store rejects null).
export function nextRunAt(s: Schedule, after: number): number | null {
  if (s.type === "interval") return after + s.minutes * 60_000;

  if (s.type === "once") {
    if (s.minutes !== undefined) return after + s.minutes * 60_000;
    const [hh, mm] = s.time!.split(":").map(Number);
    if (s.date) {
      const [y, mo, d] = s.date.split("-").map(Number);
      const t = zonedTimeToInstant(y, mo, d, hh, mm, s.timezone!);
      return t > after ? t : null;
    }
    // No date: the next time the wall clock reads HH:MM in that zone.
    return nextWallClock(hh, mm, s.timezone!, after);
  }

  // daily
  const [hh, mm] = s.time.split(":").map(Number);
  return nextWallClock(hh, mm, s.timezone, after);
}

// Next instant after `after` at which it is HH:MM in `timeZone`: try today (in
// the zone), then advance day by day. The +DAY_MS probe moves the wall-clock
// date forward; the exact instant is recomputed from the new date each step, so
// DST days (23h/25h long) can't drift the result.
function nextWallClock(hh: number, mm: number, timeZone: string, after: number): number {
  let probe = after;
  for (let i = 0; i < 3; i++) {
    const w = wallParts(probe, timeZone);
    const t = zonedTimeToInstant(w.y, w.mo, w.d, hh, mm, timeZone);
    if (t > after) return t;
    probe += DAY_MS;
  }
  // Unreachable (within 2 days there is always a next HH:MM), but never loop forever.
  return after + DAY_MS;
}

// Human/one-line form for logs and the skill's `list` output.
export function describeSchedule(s: Schedule): string {
  if (s.type === "interval") return `every ${s.minutes} min`;
  if (s.type === "once") {
    if (s.minutes !== undefined) return `once, ${s.minutes} min after creation`;
    return `once at ${s.date ? `${s.date} ` : ""}${s.time} ${s.timezone}`;
  }
  return `daily at ${s.time} ${s.timezone}`;
}
