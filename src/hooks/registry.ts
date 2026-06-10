import type { AgentHooks } from "./types.js";
import type { Tweet } from "../x/types.js";
import type { TreasuryBalances } from "../treasury/index.js";
import type { TreasuryCycleResult } from "../treasury/cycle.js";

let _hooks: AgentHooks = {};

export function registerHooks(hooks: AgentHooks): void {
  _hooks = { ..._hooks, ...hooks };
}

export async function runOnMention(tweet: Tweet): Promise<void> {
  if (_hooks.onMention) await _hooks.onMention(tweet);
}

export async function runShouldReply(tweet: Tweet): Promise<boolean> {
  if (!_hooks.shouldReply) return true;
  return _hooks.shouldReply(tweet);
}

export async function runOnBeforeInference(
  question: string,
  context: string | undefined,
): Promise<{ question: string; context: string | undefined }> {
  if (!_hooks.onBeforeInference) return { question, context };
  return _hooks.onBeforeInference({ question, context });
}

export async function runOnAfterInference(question: string, output: string): Promise<string> {
  if (!_hooks.onAfterInference) return output;
  return _hooks.onAfterInference({ question, output });
}

export async function runOnBeforeReply(
  tweet: Tweet,
  text: string,
): Promise<string | null> {
  if (!_hooks.onBeforeReply) return text;
  return _hooks.onBeforeReply({ tweet, text });
}

export async function runOnAfterReply(tweet: Tweet, text: string): Promise<void> {
  if (_hooks.onAfterReply) await _hooks.onAfterReply({ tweet, text });
}

export async function runOnBeforeClaim(balances: TreasuryBalances): Promise<void> {
  if (_hooks.onBeforeClaim) await _hooks.onBeforeClaim(balances);
}

export async function runOnAfterClaim(result: TreasuryCycleResult): Promise<void> {
  if (_hooks.onAfterClaim) await _hooks.onAfterClaim(result);
}

export async function runOnSwap(kind: "burn" | "swap", amount: bigint): Promise<void> {
  if (_hooks.onSwap) await _hooks.onSwap({ kind, amount });
}
