---
name: cron
description: Manage scheduled jobs (cron). Use when the user asks to do something on a schedule ("every 30 min...", "every day at 9am...", "in one hour..."), or to list/remove/pause/resume their scheduled jobs.
access: admin
---

Extract these params from the request:
- action (required): one of "add", "list", "remove", "pause", "resume"
- id (required for remove/pause/resume): the job id (a number)
- scope (optional, for "list"): "list" shows the asking user's own jobs by default ("what cron jobs do I have scheduled?" → action=list). Pass scope=all when they ask for everyone's/all jobs (honored for admins only).

Ownership: users can only see and manage (remove/pause/resume) their OWN jobs; admins can manage all jobs. This is enforced by the skill itself from the asking tweet's author — you don't need to check it.

A job whose instruction needs skills the creator has no access to is refused at creation ("cannot create this job — it would fail on every run: …") — relay that message; don't retry with a reworded prompt.

For "add", also extract:
- prompt (required): the instruction to execute on schedule. It MUST be SELF-CONTAINED — at execution time there is no conversation, so resolve every reference now: "me" → the asker's @handle, "this token" → the actual token, relative amounts → concrete values. Example: user says "send me 10$ every 1h" → prompt: "send $10 of USDC to @theirhandle".
- schedule (required): one of "interval", "once", "daily"
- minutes: for interval ("every 30 min" → 30) and relative once ("in one hour" → 60)
- time: 24h "HH:MM" for daily, absolute once, and an interval's optional start time ("9am" → "09:00")
- date: "YYYY-MM-DD" for absolute once, or an interval's optional start date (omit for "the next occurrence of that time" / today)
- timezone: IANA name ("Europe/Paris", "America/New_York", "UTC") — REQUIRED whenever `time` is used

Schedule mapping examples:
- "every 30 min" → schedule=interval, minutes=30
- "every 2 hours starting at 9am UTC" → schedule=interval, minutes=120, time=09:00, timezone=UTC (first run at 09:00, then every 2h)
- "every 12h starting at 19:14 UTC" → schedule=interval, minutes=720, time=19:14, timezone=UTC (first run 19:14, then 07:14, 19:14 … — ONE job)
- "in one hour" → schedule=once, minutes=60
- "every day at 9am UTC" → schedule=daily, time=09:00, timezone=UTC
- "tomorrow at 9 Paris time" → schedule=once, date=<tomorrow's date>, time=09:00, timezone=Europe/Paris

ONE INTERVAL = ONE JOB: any "every N minutes/hours" request is a SINGLE interval job (with an optional start time), no matter how large N is. NEVER split a recurring interval into several daily jobs — "every 12h starting 19:14 UTC" is one interval job (minutes=720), NOT two daily jobs at 19:14 and 07:14. There is no maximum interval; use minutes=720 for 12h, 1440 for 24h, etc.

TIMEZONE RULE: resolve whatever the user says to an IANA name yourself ("Paris time" → Europe/Paris, "CET" → Europe/Paris, "New York" → America/New_York, "9am UTC" → UTC). Only if the user gives a clock time with NO timezone information at all ("at 9am"), do NOT call this skill — reply asking which timezone they mean.

Each job stores the tweet it was created from; "list" shows that tweet id — link it as https://x.com/i/status/<id> when the user asks where a job came from.

Job runs are SILENT: the agent executes the prompt and stores the outcome, visible via "list" — nothing is posted to X. If the user wants the job to post or notify them each run, the prompt itself must say so (e.g. "...then reply to tweet <id> with the result").

After creating a job, confirm to the user: the job id, the schedule in plain words, the exact stored prompt, and the next run time (UTC).
