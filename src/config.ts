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

  agentMaxSteps: numeric("AGENT_MAX_STEPS", "4"),
  llmModel: optional("LLM_MODEL", "deepseek-v4-flash"),
  pollIntervalMs: numeric("POLL_INTERVAL_MS", "20000"),
  treasuryIntervalMs: numeric("TREASURY_INTERVAL_MS", "3600000"),
  burnBps: numeric("BURN_BPS", "5000"),
  devAddress: (process.env.DEV_ADDRESS && process.env.DEV_ADDRESS !== "none" ? process.env.DEV_ADDRESS : null) as `0x${string}` | null,
  devTokenBps: numeric("DEV_TOKEN_BPS", "0"),
  devWethBps: numeric("DEV_WETH_BPS", "0"),
  treasuryDryRun: optional("TREASURY_DRY_RUN", "false") === "true",
} as const;
