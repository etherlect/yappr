import type { Logger } from "pino";
import type { Tweet } from "../x/types.js";
import { config } from "../config.js";
import { runAgentLoop } from "../reply/agent.js";
import { BLOCK, contextBlock } from "../reply/context-blocks.js";
import { nextRunAt, describeSchedule } from "./schedule.js";
import { dueCronJobs, armCronJob, markCronRun, setCronJobEnabled, type CronJob } from "./store.js";

// The cron scheduler — the third long-running loop (after the mention poller and
// the treasury cycle). One setInterval tick reads due jobs from the cron_jobs
// table and replays each job's stored prompt through the SAME agent loop a live
// mention uses, so skills, access checks and step limits behave identically.
//
// Results are NEVER posted to X by the runner ("always silent" by design): the
// final agent reply is stored in last_result, readable via the cron skill's
// `list` action. A job that should post must say so in its prompt and use a
// posting skill it has access to.

// Reject if `fn` hasn't settled within `ms` — a hung skill (Bankr agent jobs can
// poll for minutes) must not stall the whole scheduler forever.
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms / 1000}s`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

export function startCron(log: Logger): () => void {
  // A run can easily exceed the tick cadence (LLM steps + paid skill calls), so
  // overlapping ticks are skipped instead of queueing up behind each other.
  let ticking = false;

  const timer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    void tick(log).catch((err) => log.error({ err }, "cron tick failed"))
      .finally(() => { ticking = false; });
  }, config.cronTickMs);

  log.info({ tickMs: config.cronTickMs }, "cron scheduler started");
  return () => clearInterval(timer);
}

async function tick(log: Logger): Promise<void> {
  const due = dueCronJobs(Date.now());
  // Jobs run SEQUENTIALLY, never in parallel: the Bankr signer has in-flight
  // limits (see submitTx's pacing) and concurrent wallet ops also amplify the
  // EIP-7702 delegation flapping — one job at a time keeps money paths calm.
  for (const job of due) {
    await runJob(job, log);
  }
}

async function runJob(job: CronJob, log: Logger): Promise<void> {
  const lateMs = Date.now() - job.nextRunAt;

  // Advance the clock BEFORE executing — at-most-once-per-slot: if the process
  // crashes mid-run, the slot is skipped on restart rather than double-fired
  // (the right bias for money-moving jobs). Recurring jobs schedule the next
  // occurrence after NOW (slots missed while the box was down are skipped);
  // one-shots are spent here (enabled = 0) and simply run late if overdue — a
  // late reminder/transfer beats a silently dropped one.
  const next = job.schedule.type === "once" ? null : nextRunAt(job.schedule, Date.now());
  armCronJob(job.id, next);

  // Privileges are re-derived EVERY run from the current ADMIN_HANDLES — never
  // from creation-time status. This is the kill switch: remove a handle from the
  // env and their jobs drop to the public skill set on the next tick (same skill
  // access a live mention from them would get — enforced in code by the agent
  // loop, not trusted to the LLM).
  const isAdmin = config.adminHandles.includes(job.creatorHandle);

  const desc = describeSchedule(job.schedule);
  log.info(
    { id: job.id, schedule: desc, creator: job.creatorHandle, isAdmin, run: job.runs + 1, lateS: Math.round(lateMs / 1000) },
    `cron job #${job.id} due (${desc}) — running`,
  );

  // Synthesize the agent input the same way the reply pipeline does: the stored
  // prompt rides in the ASKER TWEET block (so AGENT_INSTRUCTIONS' "the ASKER
  // TWEET is the request" contract holds unchanged), and a CRON JOB header tells
  // the model this is a scheduled replay, not a live mention. The source tweet
  // keeps the creator's identity attached for skills that read tweet.author.
  const tweet: Tweet = { ...(job.sourceTweet ?? ({} as Tweet)), text: job.prompt };
  // The creating tweet id is surfaced so a prompt can reference its origin
  // (e.g. "reply to the tweet that created this job").
  const origin = job.sourceTweet?.id ? ` in tweet ${job.sourceTweet.id}` : "";
  const header = contextBlock("CRON JOB", [
    `This is scheduled cron job #${job.id} (${desc}), created by @${job.creatorHandle}${origin} on ${new Date(job.createdAt).toISOString()}.`,
    `Run #${job.runs + 1}. The ${BLOCK.asker} below is the job's stored instruction being executed now — it is not a live tweet.`,
    `Your final reply text is stored as the job result (it is NOT posted to X).`,
  ].join("\n"));
  const context = `${header}\n\n${contextBlock(BLOCK.asker, JSON.stringify(tweet, null, 2))}`;

  const startedAt = Date.now();
  try {
    const result = await withTimeout(runAgentLoop(context, isAdmin, tweet, log), config.cronRunTimeoutMs);
    markCronRun(job.id, { result });
    log.info({ id: job.id, ms: Date.now() - startedAt, result: result.slice(0, 200) }, `cron job #${job.id} ok`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    markCronRun(job.id, { error: message });
    const failures = job.consecutiveFailures + 1;
    log.error({ id: job.id, failures, max: config.cronMaxConsecutiveFailures, err: message }, `cron job #${job.id} failed`);
    // A persistently failing job must not burn inference/skill spend forever —
    // auto-pause after N consecutive failures; `resume` re-arms it.
    if (failures >= config.cronMaxConsecutiveFailures && job.schedule.type !== "once") {
      setCronJobEnabled(job.id, false);
      log.error({ id: job.id }, `cron job #${job.id} auto-paused after ${failures} consecutive failures`);
    }
  }
}
