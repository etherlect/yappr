import type { AgentHooks } from "./types.js";
import type { Tweet } from "../x/types.js";
import type { TreasuryBalances } from "../treasury/index.js";
import type { TreasuryCycleResult } from "../treasury/cycle.js";

// Every loaded hook file registers its own AgentHooks set; they COMPOSE rather
// than overwrite (multiple files can implement the same hook — e.g. user-memory
// and holder both use onBeforeInference; a spread-merge here used to let the
// last file silently clobber the others). Sets run in registration order (the
// loader's alphabetical file order):
//   - observers (onMention, onAfterReply, treasury hooks) all run;
//   - shouldReply is a veto chain — any false skips the reply;
//   - transformers (onBeforeInference, onAfterInference, onBeforeReply) thread
//     their value through each set in turn; onBeforeReply short-circuits on null.
const _hookSets: AgentHooks[] = [];

export function registerHooks(hooks: AgentHooks): void {
  _hookSets.push(hooks);
}

export async function runOnMention(tweet: Tweet): Promise<void> {
  for (const h of _hookSets) {
    if (h.onMention) await h.onMention(tweet);
  }
}

export async function runShouldReply(tweet: Tweet): Promise<boolean> {
  for (const h of _hookSets) {
    if (h.shouldReply && !(await h.shouldReply(tweet))) return false;
  }
  return true;
}

export async function runOnBeforeInference(
  tweet: Tweet,
  question: string,
  context: string | undefined,
): Promise<{ question: string; context: string | undefined }> {
  let cur = { question, context };
  for (const h of _hookSets) {
    if (h.onBeforeInference) cur = await h.onBeforeInference({ tweet, ...cur });
  }
  return cur;
}

export async function runOnAfterInference(question: string, output: string): Promise<string> {
  let cur = output;
  for (const h of _hookSets) {
    if (h.onAfterInference) cur = await h.onAfterInference({ question, output: cur });
  }
  return cur;
}

export async function runOnBeforeReply(
  tweet: Tweet,
  text: string,
): Promise<string | null> {
  let cur = text;
  for (const h of _hookSets) {
    if (!h.onBeforeReply) continue;
    const next = await h.onBeforeReply({ tweet, text: cur });
    if (next === null) return null; // vetoed — later sets don't resurrect it
    cur = next;
  }
  return cur;
}

export async function runOnAfterReply(tweet: Tweet, text: string): Promise<void> {
  for (const h of _hookSets) {
    if (h.onAfterReply) await h.onAfterReply({ tweet, text });
  }
}

export async function runOnBeforeClaim(balances: TreasuryBalances): Promise<void> {
  for (const h of _hookSets) {
    if (h.onBeforeClaim) await h.onBeforeClaim(balances);
  }
}

export async function runOnAfterClaim(result: TreasuryCycleResult): Promise<void> {
  for (const h of _hookSets) {
    if (h.onAfterClaim) await h.onAfterClaim(result);
  }
}

export async function runOnSwap(kind: "burn" | "swap", amount: bigint): Promise<void> {
  for (const h of _hookSets) {
    if (h.onSwap) await h.onSwap({ kind, amount });
  }
}
