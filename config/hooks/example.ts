import type { AgentHooks } from "yappr";

export const hooks: AgentHooks = {
  // onMention: async (tweet) => {
  //   console.log(`mention from @${tweet.author?.username}: ${tweet.text.slice(0, 80)}`);
  // },

  // Return false to skip replying to this tweet.
  // shouldReply: (tweet) => {
  //   const blocked = ["spambot"];
  //   return !blocked.includes(tweet.author?.username?.toLowerCase() ?? "");
  // },

  // Mutate the question or context before it reaches the LLM. Also receives the
  // asker tweet, for per-user logic — see user-memory.ts for a real example.
  // onBeforeInference: async ({ tweet, question, context }) => {
  //   return { question, context };
  // },

  // Post-process the LLM output before it is sent.
  // onAfterInference: async ({ output }) => {
  //   return output;
  // },

  // Mutate the reply text or return null to cancel sending.
  // onBeforeReply: async ({ text }) => {
  //   return text;
  //   // return `${text}\n\npowered by x402`; // append footer
  //   // return null; // veto
  // },

  // onAfterReply: async ({ tweet, text }) => {
  //   console.log(`replied to ${tweet.id}: ${text.slice(0, 80)}`);
  // },

  // onBeforeClaim: async (balances) => {
  //   console.log("treasury cycle starting", balances);
  // },

  // onAfterClaim: async (result) => {
  //   console.log("treasury cycle done", result);
  // },

  // onSwap: async ({ kind, amount }) => {
  //   console.log(`treasury swap: ${kind} ${amount.toString()}`);
  // },
};
