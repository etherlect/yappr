import { withSchema } from "../db.js";
import { config } from "../config.js";
import type { Tweet } from "../x/types.js";
import { type Schedule, nextRunAt, describeSchedule } from "./schedule.js";

// Persistent cron jobs in the shared SQLite DB (see db.ts) — same pattern as
// state.ts/stats.ts: the feature owns its table, the DB survives redeploys (it
// lives at DB_PATH outside the wiped project dir) and rides the dashboard's
// backup system. The DB row is the ONLY scheduler state: there is no in-memory
// timer registry to keep in sync — the runner just reads `next_run_at` (see
// runner.ts for why that design).
//
// Security model: the stored prompt is replayed later through an LLM that can
// call skills, so treat it like code — it is shown verbatim by `list`, logged on
// every run, and grants nothing by itself: the creator's privileges are
// re-derived from ADMIN_HANDLES at each run (runner.ts), never from this table.

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS cron_jobs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    prompt          TEXT NOT NULL,
    schedule        TEXT NOT NULL,
    creator_id      TEXT NOT NULL,
    creator_handle  TEXT NOT NULL,
    source_tweet    TEXT,
    enabled         INTEGER NOT NULL DEFAULT 1,
    next_run_at     INTEGER NOT NULL,
    last_run_at     INTEGER,
    last_result     TEXT,
    last_error      TEXT,
    runs            INTEGER NOT NULL DEFAULT 0,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_cron_due ON cron_jobs(enabled, next_run_at);
`;
const conn = () => withSchema(SCHEMA);

export type CronJob = {
  id: number;
  prompt: string;            // self-contained instruction, replayed verbatim each run
  schedule: Schedule;
  creatorId: string;         // stable X user id (handles can be renamed/sniped)
  creatorHandle: string;     // lowercased; the runner re-checks it against ADMIN_HANDLES
  sourceTweet: Tweet | null; // the creating tweet — execution context + audit trail
  enabled: boolean;
  nextRunAt: number;         // epoch ms
  lastRunAt: number | null;
  lastResult: string | null; // final agent reply text of the last run (never posted)
  lastError: string | null;
  runs: number;
  consecutiveFailures: number;
  createdAt: number;
};

type Row = {
  id: number; prompt: string; schedule: string; creator_id: string; creator_handle: string;
  source_tweet: string | null; enabled: number; next_run_at: number; last_run_at: number | null;
  last_result: string | null; last_error: string | null; runs: number;
  consecutive_failures: number; created_at: number;
};

function rowToJob(r: Row): CronJob {
  let sourceTweet: Tweet | null = null;
  try { sourceTweet = r.source_tweet ? (JSON.parse(r.source_tweet) as Tweet) : null; } catch { /* keep null */ }
  return {
    id: r.id,
    prompt: r.prompt,
    schedule: JSON.parse(r.schedule) as Schedule,
    creatorId: r.creator_id,
    creatorHandle: r.creator_handle,
    sourceTweet,
    enabled: r.enabled === 1,
    nextRunAt: r.next_run_at,
    lastRunAt: r.last_run_at,
    lastResult: r.last_result,
    lastError: r.last_error,
    runs: r.runs,
    consecutiveFailures: r.consecutive_failures,
    createdAt: r.created_at,
  };
}

// Create a job. Error strings are written for the LLM observation (the skill
// returns them verbatim), so they read as something the model can relay to the
// user. The creator is snapshotted from the CREATING tweet's author — params are
// model-controlled, the tweet author is not.
export function addCronJob(input: {
  prompt: string;
  schedule: Schedule;
  tweet: Tweet;
}): { job: CronJob } | { error: string } {
  const d = conn();
  if (!d) return { error: "cron storage unavailable" };

  const prompt = input.prompt?.trim();
  if (!prompt) return { error: 'missing "prompt" — the self-contained instruction to run on schedule' };

  const author = input.tweet.author;
  if (!author?.id || !author?.username) {
    return { error: "could not identify the requesting user from the tweet" };
  }

  const active = d.prepare("SELECT COUNT(*) AS n FROM cron_jobs WHERE enabled = 1").get() as { n: number };
  if (active.n >= config.cronMaxJobs) {
    return { error: `cron job limit reached (${config.cronMaxJobs} active jobs) — remove one first` };
  }
  // Per-user cap on top of the global one, so when the skill is opened to
  // non-admins a single user can't exhaust the pool (every run costs money).
  const own = d.prepare("SELECT COUNT(*) AS n FROM cron_jobs WHERE enabled = 1 AND creator_id = ?")
    .get(author.id) as { n: number };
  if (own.n >= config.cronMaxJobsPerUser) {
    return { error: `you already have ${own.n} active cron jobs (limit ${config.cronMaxJobsPerUser}) — remove one first` };
  }

  const now = Date.now();
  const next = nextRunAt(input.schedule, now);
  // null = an absolute one-shot already in the past — refuse rather than store a
  // job that would either never fire or fire "late" immediately.
  if (next === null) return { error: "that time is already in the past — pick a future time" };

  const res = d.prepare(`
    INSERT INTO cron_jobs (prompt, schedule, creator_id, creator_handle, source_tweet, next_run_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    prompt,
    JSON.stringify(input.schedule),
    author.id,
    author.username.toLowerCase(),
    JSON.stringify(input.tweet),
    next,
    now,
  );

  const job = getCronJob(Number(res.lastInsertRowid));
  return job ? { job } : { error: "failed to store the cron job" };
}

export function getCronJob(id: number): CronJob | null {
  const d = conn();
  if (!d) return null;
  const row = d.prepare("SELECT * FROM cron_jobs WHERE id = ?").get(id) as Row | undefined;
  return row ? rowToJob(row) : null;
}

// Disabled jobs (spent one-shots, paused, auto-paused after repeated failures)
// stay listed until removed — `list` is the audit surface for stored prompts.
// `creatorId` filters to one user's jobs (matched on the stable X user id, not
// the handle, so renames don't detach a user from their jobs).
export function listCronJobs(opts: { includeDisabled?: boolean; creatorId?: string } = {}): CronJob[] {
  const d = conn();
  if (!d) return [];
  const { includeDisabled = true, creatorId } = opts;
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (!includeDisabled) where.push("enabled = 1");
  if (creatorId) { where.push("creator_id = ?"); args.push(creatorId); }
  const sql = `SELECT * FROM cron_jobs${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY id`;
  return (d.prepare(sql).all(...args) as Row[]).map(rowToJob);
}

export function setCronJobEnabled(id: number, enabled: boolean): boolean {
  const d = conn();
  if (!d) return false;
  // Re-arming a paused job recomputes next_run_at from now — otherwise a job
  // paused past its slot would fire immediately on resume.
  if (enabled) {
    const job = getCronJob(id);
    if (!job) return false;
    const next = nextRunAt(job.schedule, Date.now());
    if (next === null) return false; // spent one-shot can't be resumed
    return d.prepare("UPDATE cron_jobs SET enabled = 1, next_run_at = ?, consecutive_failures = 0 WHERE id = ?")
      .run(next, id).changes > 0;
  }
  return d.prepare("UPDATE cron_jobs SET enabled = 0 WHERE id = ?").run(id).changes > 0;
}

export function removeCronJob(id: number): boolean {
  const d = conn();
  if (!d) return false;
  return d.prepare("DELETE FROM cron_jobs WHERE id = ?").run(id).changes > 0;
}

// Runner internals ───────────────────────────────────────────────────────────

export function dueCronJobs(now: number): CronJob[] {
  const d = conn();
  if (!d) return [];
  return (d.prepare("SELECT * FROM cron_jobs WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at")
    .all(now) as Row[]).map(rowToJob);
}

// Advance the job's clock — called by the runner BEFORE executing, so a crash
// mid-run skips the slot instead of double-firing on restart (at-most-once).
// `enabled = 0` here is how one-shots are spent.
export function armCronJob(id: number, nextRunAt: number | null): void {
  const d = conn();
  if (!d) return;
  if (nextRunAt === null) {
    d.prepare("UPDATE cron_jobs SET enabled = 0 WHERE id = ?").run(id);
  } else {
    d.prepare("UPDATE cron_jobs SET next_run_at = ? WHERE id = ?").run(nextRunAt, id);
  }
}

export function markCronRun(id: number, outcome: { result?: string; error?: string }): void {
  const d = conn();
  if (!d) return;
  if (outcome.error !== undefined) {
    d.prepare(`
      UPDATE cron_jobs SET last_run_at = ?, last_error = ?, runs = runs + 1,
        consecutive_failures = consecutive_failures + 1 WHERE id = ?
    `).run(Date.now(), outcome.error, id);
  } else {
    d.prepare(`
      UPDATE cron_jobs SET last_run_at = ?, last_result = ?, last_error = NULL, runs = runs + 1,
        consecutive_failures = 0 WHERE id = ?
    `).run(Date.now(), outcome.result ?? "", id);
  }
}

export { describeSchedule };
