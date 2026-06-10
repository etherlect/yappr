import type { Tweet } from "../x/types.js";
import type { TreasuryBalances } from "../treasury/index.js";
import type { TreasuryCycleResult } from "../treasury/cycle.js";

export type OnMentionHook = (tweet: Tweet) => Promise<void> | void;
export type ShouldReplyHook = (tweet: Tweet) => Promise<boolean> | boolean;
export type OnBeforeInferenceHook = (input: {
  question: string;
  context: string | undefined;
}) => Promise<{ question: string; context: string | undefined }> | { question: string; context: string | undefined };
export type OnAfterInferenceHook = (input: {
  question: string;
  output: string;
}) => Promise<string> | string;
export type OnBeforeReplyHook = (input: {
  tweet: Tweet;
  text: string;
}) => Promise<string | null> | string | null;
export type OnAfterReplyHook = (input: { tweet: Tweet; text: string }) => Promise<void> | void;

export type OnBeforeClaimHook = (balances: TreasuryBalances) => Promise<void> | void;
export type OnAfterClaimHook = (result: TreasuryCycleResult) => Promise<void> | void;
export type OnSwapHook = (input: {
  kind: "burn" | "swap";
  amount: bigint;
}) => Promise<void> | void;

export type AgentHooks = {
  onMention?: OnMentionHook;
  shouldReply?: ShouldReplyHook;
  onBeforeInference?: OnBeforeInferenceHook;
  onAfterInference?: OnAfterInferenceHook;
  onBeforeReply?: OnBeforeReplyHook;
  onAfterReply?: OnAfterReplyHook;
  onBeforeClaim?: OnBeforeClaimHook;
  onAfterClaim?: OnAfterClaimHook;
  onSwap?: OnSwapHook;
};
