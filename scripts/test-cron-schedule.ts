#!/usr/bin/env tsx
// Throwaway check of src/cron/schedule.ts: validation rules and next-run math,
// including IANA timezone/DST behavior. Run: npx tsx scripts/test-cron-schedule.ts
// (needs the instance env? no — config only reads CRON_* with defaults, but
// config.ts requires the agent env vars, so run with the instance .env or stubs.)
process.env.AGENT_HANDLE ??= "test";
process.env.BANKR_API_KEY ??= "test";
process.env.TWITTER_AUTH_TOKEN ??= "test";
process.env.TWITTER_CT0 ??= "test";
process.env.TOKEN_ADDRESS ??= "0x0000000000000000000000000000000000000000";

const { validateSchedule, nextRunAt, describeSchedule } = await import("../src/cron/schedule.js");

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.error(`  FAIL ${name}`, extra ?? ""); }
}

// ── validation ──
const iv = validateSchedule({ schedule: "interval", minutes: "30" });
check("interval 30 valid", !("error" in iv) && iv.type === "interval" && iv.minutes === 30);
check("interval below floor rejected", "error" in validateSchedule({ schedule: "interval", minutes: "1" }));
check("interval junk rejected", "error" in validateSchedule({ schedule: "interval", minutes: "soon" }));

const once = validateSchedule({ schedule: "once", minutes: "60" });
check("once in 60min valid", !("error" in once) && once.type === "once" && once.minutes === 60);

const dailyNoTz = validateSchedule({ schedule: "daily", time: "09:00" });
check("daily without timezone rejected with ask-the-user error",
  "error" in dailyNoTz && dailyNoTz.error.includes("ask the user"), dailyNoTz);
check("daily bad zone rejected", "error" in validateSchedule({ schedule: "daily", time: "09:00", timezone: "Mars/Olympus" }));
check("daily bad time rejected", "error" in validateSchedule({ schedule: "daily", time: "9am", timezone: "UTC" }));
const daily = validateSchedule({ schedule: "daily", time: "09:00", timezone: "Europe/Paris" });
check("daily Paris valid", !("error" in daily) && daily.type === "daily");

// ── next-run math ──
const T = Date.UTC(2026, 0, 15, 12, 0); // 2026-01-15 12:00Z (winter)
check("interval next = +30min", nextRunAt({ type: "interval", minutes: 30 }, T) === T + 30 * 60_000);
check("once relative next = +60min", nextRunAt({ type: "once", minutes: 60 }, T) === T + 60 * 60_000);

// Paris is UTC+1 in winter → 09:00 Paris = 08:00Z; from 12:00Z that's tomorrow.
const winter = nextRunAt({ type: "daily", time: "09:00", timezone: "Europe/Paris" }, T);
check("daily 09:00 Paris from winter noon = next day 08:00Z",
  winter === Date.UTC(2026, 0, 16, 8, 0), winter && new Date(winter).toISOString());

// Paris is UTC+2 in summer → 09:00 Paris = 07:00Z.
const S = Date.UTC(2026, 6, 15, 12, 0); // 2026-07-15 12:00Z
const summer = nextRunAt({ type: "daily", time: "09:00", timezone: "Europe/Paris" }, S);
check("daily 09:00 Paris from summer noon = next day 07:00Z",
  summer === Date.UTC(2026, 6, 16, 7, 0), summer && new Date(summer).toISOString());

// Across the spring-forward transition (Paris: 2026-03-29, 02:00→03:00). From the
// 28th at 12:00Z, the next 09:00 Paris is the 29th — already UTC+2 → 07:00Z.
const D = Date.UTC(2026, 2, 28, 12, 0);
const dst = nextRunAt({ type: "daily", time: "09:00", timezone: "Europe/Paris" }, D);
check("daily 09:00 Paris across spring-forward = 29th 07:00Z",
  dst === Date.UTC(2026, 2, 29, 7, 0), dst && new Date(dst).toISOString());

// Nonexistent local time on the gap day (02:30 doesn't exist on Mar 29): accept a
// result within an hour of either candidate instant rather than a precise value.
const gap = nextRunAt({ type: "daily", time: "02:30", timezone: "Europe/Paris" }, D)!;
check("spring-forward gap time resolves to a sane instant (~01:30Z ±1h)",
  Math.abs(gap - Date.UTC(2026, 2, 29, 1, 30)) <= 60 * 60_000, new Date(gap).toISOString());

// Absolute once: in the past → null; in the future → exact instant.
check("absolute once in the past = null",
  nextRunAt({ type: "once", date: "2026-01-01", time: "09:00", timezone: "UTC" }, T) === null);
check("absolute once future = exact instant",
  nextRunAt({ type: "once", date: "2026-02-01", time: "09:00", timezone: "UTC" }, T) === Date.UTC(2026, 1, 1, 9, 0));

// Once with time but no date = next occurrence of that wall time.
const todayLater = nextRunAt({ type: "once", time: "15:00", timezone: "UTC" }, T);
check("once 15:00 UTC (no date) from 12:00Z = same day 15:00Z", todayLater === Date.UTC(2026, 0, 15, 15, 0));

// describe
check("describe interval", describeSchedule({ type: "interval", minutes: 30 }) === "every 30 min");
check("describe daily", describeSchedule({ type: "daily", time: "09:00", timezone: "Europe/Paris" }) === "daily at 09:00 Europe/Paris");

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
