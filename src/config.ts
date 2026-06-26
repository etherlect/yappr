import "dotenv/config";
import { requireEnv } from "./util.js";

// Central, validated view of all environment configuration. `requireEnv` throws
// at startup if a required var is missing; `optional` supplies a default. Every
// module reads from this object rather than touching process.env directly.

function optional(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

// Numeric env var, validated at startup. A silent NaN here is dangerous — e.g. a
// typo'd POLL_INTERVAL_MS would make setInterval fire every ~1ms, each tick a PAID
// x402 call — so a malformed value fails the boot instead.
function numeric(name: string, fallback: string): number {
  const raw = optional(name, fallback);
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${raw}"`);
  return n;
}

export const config = {
  agentHandle: requireEnv("AGENT_HANDLE"),
  bankrApiKey: requireEnv("BANKR_API_KEY"),
  twitterAuthToken: requireEnv("TWITTER_AUTH_TOKEN"),
  twitterCt0: requireEnv("TWITTER_CT0"),
  xApiBaseUrl: "https://x402.twit.sh",
  tokenAddress: requireEnv("TOKEN_ADDRESS") as `0x${string}`,
  computeInstanceId: process.env.COMPUTE_INSTANCE_ID || null,

  adminHandles: (process.env.ADMIN_HANDLES ?? "")
    .split(",").map((h) => h.trim().toLowerCase()).filter(Boolean),

  // How to poll for mentions: "search" uses /tweets/search (mentioning the agent),
  // "mentions" uses the dedicated /tweets/mentions endpoint. Defaults to "search".
  pollMethod: (optional("POLL_METHOD", "search").toLowerCase() === "mentions" ? "mentions" : "search") as "mentions" | "search",

  agentMaxSteps: numeric("AGENT_MAX_STEPS", "6"),
  // Used by both the reply loop (LLM gateway) and Bankr agent jobs (Max Mode,
  // agent-prompt.ts) — both draw on the same gateway model catalog.
  llmModel: optional("LLM_MODEL", "deepseek-v4-flash"),
  // Vision-capable model the reply loop routes to ONLY when a mention carries an
  // image (otherwise it stays on the cheaper text-only llmModel). Must be a model
  // whose `/v1/models` input modalities include "image" (see bankr.bot/llm).
  visionModel: optional("VISION_MODEL", "gemini-2.5-flash"),
  // Cap on how many images (across the asker tweet + the tweets it references) are
  // sent to the vision model in one reply — each image is thousands of prompt
  // tokens, so this bounds the cost of an image-heavy thread.
  maxImages: numeric("MAX_IMAGES", "8"),
  // When false (default), each LLM call logs only a compact summary (model, message count,
  // token usage, cost), keeping prompts and user/tweet content out of the logs. Set true to
  // log the FULL context instead — every request message verbatim plus the full response
  // text — for debugging. The token/cost ledger is unaffected either way.
  logLlmContext: optional("LOG_LLM_CONTEXT", "false") === "true",
  pollIntervalMs: numeric("POLL_INTERVAL_MS", "20000"),
  treasuryIntervalMs: numeric("TREASURY_INTERVAL_MS", "3600000"),
  burnBps: numeric("BURN_BPS", "5000"),
  devAddress: (process.env.DEV_ADDRESS && process.env.DEV_ADDRESS !== "none" ? process.env.DEV_ADDRESS : null) as `0x${string}` | null,
  devTokenBps: numeric("DEV_TOKEN_BPS", "0"),
  devWethBps: numeric("DEV_WETH_BPS", "0"),
  treasuryDryRun: optional("TREASURY_DRY_RUN", "false") === "true",

  // ── Cron jobs (scheduled prompts, see src/cron/) ──
  // How often the scheduler checks for due jobs. Cheap (one local SQLite read).
  cronTickMs: numeric("CRON_TICK_MS", "10000"),
  // Cap on ACTIVE jobs — each run costs inference + whatever paid skills it calls.
  cronMaxJobs: numeric("CRON_MAX_JOBS", "20"),
  // Per-creator cap under the global one — matters once the cron skill is opened
  // to non-admins (one user must not be able to exhaust the pool).
  cronMaxJobsPerUser: numeric("CRON_MAX_JOBS_PER_USER", "10"),
  // Floor for interval schedules: every run spends money, so no sub-5-min loops.
  // One-shots ("in N minutes") are exempt — the floor only guards recurrence.
  cronMinIntervalMin: numeric("CRON_MIN_INTERVAL_MIN", "5"),
  // Per-run cap — skills like `wallet` poll Bankr agent jobs for minutes, but a
  // hung run must not stall the (sequential) scheduler forever.
  cronRunTimeoutMs: numeric("CRON_RUN_TIMEOUT_MS", "300000"),
  // Auto-pause a recurring job after this many consecutive failures, so a broken
  // prompt can't drain credits indefinitely.
  cronMaxConsecutiveFailures: numeric("CRON_MAX_CONSECUTIVE_FAILURES", "5"),
} as const;
