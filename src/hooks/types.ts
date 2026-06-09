import type { Tweet } from "../x/types.js";

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

export type OnBeforeClaimHook = (balances: {
  token: bigint;
  weth: bigint;
  usdc: bigint;
  eth: bigint;
}) => Promise<void> | void;
export type OnAfterClaimHook = (result: {
  tokenClaimed: bigint;
  wethClaimed: bigint;
  tokenBurned: bigint;
  tokenToDev: bigint;
  wethToDev: bigint;
  wethUnwrapped: bigint;
  wethSwapped: bigint;
  computeExtended: boolean;
}) => Promise<void> | void;
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
