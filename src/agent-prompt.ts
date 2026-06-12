import { config } from "./config.js";
import { log } from "./log.js";
import { bankrApi } from "./bankr.js";
import { sleep } from "./util.js";

// Always submitted in Max Mode (an explicit model id), which bills the job
// per-request from the LLM credit balance instead of counting against the
// account's prompt quota (100/day for non-Club) — so callers don't need to
// ration these. Uses the same model as the reply loop (LLM_MODEL): both run
// against the LLM gateway's model catalog, so one knob configures all inference.
export async function agentPrompt(prompt: string): Promise<string> {
  if (config.treasuryDryRun) {
    log.info({ prompt }, "agent-prompt [dry run]");
    return `[dry run] ${prompt}`;
  }

  log.info({ prompt, model: config.llmModel }, "agent-prompt submitting");
  const { jobId } = await bankrApi<{ jobId: string }>(config.bankrApiKey, "/agent/prompt", {
    method: "POST",
    body: JSON.stringify({
      prompt,
      maxMode: { enabled: true, model: config.llmModel },
    }),
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
      // warn before throwing: the catch site logs the (counted) error — see log.ts.
      log.warn({ jobId }, "agent-prompt job failed");
      throw new Error(`Bankr agent job failed: ${job.response ?? "unknown"}`);
    }
  }
  log.warn({ jobId }, "agent-prompt job timed out");
  throw new Error(`Bankr agent job timed out (jobId=${jobId})`);
}
