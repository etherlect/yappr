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
export type { Treasury } from "./treasury/index.js";

// ── Engine services ──
export { agentPrompt } from "./agent-prompt.js";
export { getTreasury } from "./treasury/index.js";
export { log } from "./log.js";
export { config } from "./config.js";
export { payFetch, paidUsd, walletAddress } from "./wallet.js";

// ── Full X/Twitter SDK (extractTweetId, getTweetById, postTweet, …) ──
export * from "./x/client.js";
