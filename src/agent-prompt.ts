import { config } from "./config.js";
import { log } from "./log.js";
import { bankrApi } from "./bankr.js";
import { sleep } from "./util.js";

// Limited to 100 calls/day on non-Club accounts — use for ad-hoc/manual tasks,
// not for scheduled treasury operations.
export async function agentPrompt(prompt: string): Promise<string> {
  if (config.treasuryDryRun) {
    log.info({ prompt }, "agent-prompt [dry run]");
    return `[dry run] ${prompt}`;
  }

  log.info({ prompt }, "agent-prompt submitting");
  const { jobId } = await bankrApi<{ jobId: string }>(config.bankrApiKey, "/agent/prompt", {
    method: "POST",
    body: JSON.stringify({ prompt }),
  });
  log.info({ jobId }, "agent-prompt job queued");

  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    let job: { status: string; response?: string };
    try {
      job = await bankrApi(config.bankrApiKey, `/agent/job/${jobId}`);
    } catch {
      continue; // transient poll failure — retry
    }
    if (job.status === "completed") {
      log.info({ jobId, attempts: i + 1 }, "agent-prompt job completed");
      return job.response ?? "";
    }
    if (job.status === "failed") {
      log.error({ jobId }, "agent-prompt job failed");
      throw new Error(`Bankr agent job failed: ${job.response ?? "unknown"}`);
    }
  }
  log.error({ jobId }, "agent-prompt job timed out");
  throw new Error(`Bankr agent job timed out (jobId=${jobId})`);
}
