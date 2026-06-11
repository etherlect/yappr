// Public API for config authors. Skills and hooks import from "yappr" instead of
// reaching into engine internals (../../../src/...), so:
//   - a user's project (which has no src/) can author and edit skills, and
//   - the import resolves to the single running engine instance — no duplicate
//     `config`/`db`/wallet singletons.
//
// Keep this surface intentional: it's the contract third-party skill/hook authors
// build against.

// ── Types ──
export type { SkillHandler, SkillResult, SkillDef, SkillAccess } from "./skills/types.js";
export type { AgentHooks } from "./hooks/types.js";
export type { Tweet, SearchResponse } from "./x/types.js";
export type { Treasury, TreasuryBalances } from "./treasury/index.js";
export type { TreasuryCycleResult } from "./treasury/cycle.js";
export type { CronJob } from "./cron/store.js";
export type { Schedule } from "./cron/schedule.js";
export type { SkillStore, SkillStoreEntry } from "./storage.js";
// The shared connection's handle type, so skill authors using withSchema() get
// typechecking without depending on better-sqlite3 themselves.
export type { Database } from "better-sqlite3";

// ── Engine services ──
export { agentPrompt } from "./agent-prompt.js";
export { getTreasury } from "./treasury/index.js";
export { log } from "./log.js";
export { config } from "./config.js";
export { payFetch, paidUsd, walletAddress } from "./wallet.js";

// ── Storage for skills/hooks — namespaced KV (skillStore) for the common case,
// withSchema for skills that need their own tables in the shared DB ──
export { skillStore } from "./storage.js";
export { withSchema } from "./db.js";

// ── Cron jobs (scheduled prompts) — store/validation only; the runner loop is
// engine-internal (started by yappr.ts), skills only manage the table ──
export { addCronJob, listCronJobs, getCronJob, setCronJobEnabled, removeCronJob, describeSchedule } from "./cron/store.js";
export { validateSchedule } from "./cron/schedule.js";

// ── Full X/Twitter SDK (extractTweetId, getTweetById, postTweet, …) ──
export * from "./x/client.js";
