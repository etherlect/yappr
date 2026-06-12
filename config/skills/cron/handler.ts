import {
  addCronJob, listCronJobs, getCronJob, setCronJobEnabled, resumeCronJob, removeCronJob,
  validateSchedule, describeSchedule, checkCronCapability, config,
  type SkillHandler, type CronJob, type Tweet,
} from "yappr";

// Thin dispatcher over the engine's cron store ("yappr" public API). All
// validation/caps live engine-side (validateSchedule/addCronJob) and their error
// strings are written for the model — return them verbatim as the observation so
// the agent can relay them (e.g. the ask-the-user-for-a-timezone message).
//
// Ownership model (safe to flip the skill to `access: all`): every check below
// uses the ASKING tweet's author — id for ownership (stable across renames),
// handle for admin status (how the engine gates admin everywhere) — never model
// params, so a prompt can't impersonate another user. Non-admins can only see
// and manage their OWN jobs; admins can see (scope=all) and manage everything.

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 16) + "Z";
const trunc = (s: string, n = 120) => (s.length > n ? s.slice(0, n) + "…" : s);

const isAdmin = (tweet: Tweet) =>
  config.adminHandles.includes(tweet.author?.username?.toLowerCase() ?? "");

// One line per job. Prompts are shown VERBATIM on purpose: stored prompts are
// replayed through the agent later, so `list` is their audit surface. The
// creating tweet id is included so the model can link the origin when asked
// (https://x.com/i/status/<id>).
function formatJob(j: CronJob): string {
  const status = j.enabled ? `next ${iso(j.nextRunAt)}` : "disabled";
  const origin = j.sourceTweet?.id ? `, from tweet ${j.sourceTweet.id}` : "";
  const last = j.lastError
    ? ` | last error: ${trunc(j.lastError)}`
    : j.lastResult ? ` | last result: ${trunc(j.lastResult)}` : "";
  return `#${j.id} [${status}] ${describeSchedule(j.schedule)} (by @${j.creatorHandle}${origin}, ${j.runs} runs) — "${j.prompt}"${last}`;
}

export const handler: SkillHandler = async (params, tweet) => {
  switch (params.action) {
    case "add": {
      const schedule = validateSchedule(params);
      if ("error" in schedule) return { text: schedule.error };
      // Refuse jobs whose instruction needs skills the creator can't use — they
      // would burn inference on every run only to hit the access denial. No-op
      // for admins; see src/cron/capability.ts for the why and the limits.
      const cap = await checkCronCapability(params.prompt ?? "", isAdmin(tweet));
      if (!cap.ok) return { text: `cannot create this job — it would fail on every run: ${cap.reason}` };
      const res = addCronJob({ prompt: params.prompt ?? "", schedule, tweet });
      if ("error" in res) return { text: res.error };
      const j = res.job;
      return { text: `cron #${j.id} created: ${describeSchedule(j.schedule)} — "${j.prompt}" (next run ${iso(j.nextRunAt)})` };
    }

    case "list": {
      // Non-admins always see only their own jobs (other users' stored prompts
      // are not theirs to read); admins get scope=all on request.
      const mine = params.scope !== "all" || !isAdmin(tweet);
      const jobs = listCronJobs(mine ? { creatorId: tweet.author?.id } : {});
      if (jobs.length === 0) return { text: mine ? `no cron jobs for @${tweet.author?.username ?? "you"}` : "no cron jobs" };
      return { text: jobs.map(formatJob).join("\n") };
    }

    case "remove": case "pause": case "resume": {
      const id = Number(params.id);
      if (!Number.isInteger(id)) return { text: `missing or invalid "id" (got "${params.id ?? ""}") — use "list" to see job ids` };
      const job = getCronJob(id);
      // Not-found and not-owned return the SAME message for non-admins, so job
      // ids can't be probed for existence.
      if (!job || (job.creatorId !== tweet.author?.id && !isAdmin(tweet))) {
        return { text: `no cron job #${id} of yours — use "list" to see your jobs` };
      }
      if (params.action === "remove") {
        removeCronJob(id);
        return { text: `cron #${id} removed (was: ${describeSchedule(job.schedule)} — "${job.prompt}")` };
      }
      if (params.action === "resume") {
        // resumeCronJob re-checks the active-job caps (a paused job freed its
        // slot) and re-arms next_run_at; its errors are written for the model.
        const res = resumeCronJob(id);
        if ("error" in res) return { text: res.error };
        return { text: `cron #${id} resumed (next run ${iso(res.job.nextRunAt)})` };
      }
      const ok = setCronJobEnabled(id, false);
      return { text: ok ? `cron #${id} paused` : `cron #${id} pause failed` };
    }

    default:
      return { text: `unknown action "${params.action}" — try: add, list, remove, pause, resume` };
  }
};
