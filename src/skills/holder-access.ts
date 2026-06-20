import { skillStore } from "../storage.js";
import type { Tweet } from "../x/types.js";

// Code-side gate for `access: holder` skills, mirroring the admin check in
// reply/agent.ts: enforced HERE, never trusted to the LLM. Every input is
// outside the model's reach — the asker's identity comes from the pipeline's
// tweet object (tweet.author.id, set by the X API, not by skill params), the
// threshold comes from skill.md frontmatter, and the holdings come from the
// shared DB — so a prompt-injected "I hold a billion tokens" changes nothing.
//
// The holdings themselves are the ones the holder hook (config/hooks/holder.ts)
// cached in skillStore("bankr-wallet"): the asker's Bankr wallet (resolved once
// per user) and their token balance (refreshed at most hourly). The hook runs
// before the agent loop on every mention, so by the time a skill call is being
// gated the asker's entries are as fresh as they'll get. If the hook was
// removed, no holdings exist in the DB and every holder skill denies — closed
// by default, never open.
//
// The balance is the asker's BANKR wallet balance only — the wallet Bankr
// auto-custodies for their X handle. Tokens the asker holds in any other (non-Bankr)
// wallet are invisible here and don't count toward the gate; the threshold is
// measured against their Bankr-wallet holdings specifically.

// Mirrors the hook's storage layout (namespace + key shapes + entry types).
const STORE_NS = "bankr-wallet";
type WalletEntry = { address: string | null; at: number };
type BalanceEntry = { raw: string; at: number };

const TOKEN_DECIMALS = 18n; // Bankr launches are fixed 18-decimal Clanker deploys

// Whole tokens → wei, via BigInt(string) so large thresholds (e.g. 1e9 tokens)
// don't round through float math.
function toWei(wholeTokens: number): bigint {
  return BigInt(Math.floor(wholeTokens)) * 10n ** TOKEN_DECIMALS;
}

const fmtWhole = (wei: bigint): string => (wei / 10n ** TOKEN_DECIMALS).toLocaleString("en-US");

export function checkHolderAccess(
  tweet: Tweet,
  minHolding: number,
): { ok: true } | { ok: false; reason: string } {
  const userId = tweet.author?.id;
  if (!userId) return { ok: false, reason: "could not identify the requesting user" };

  const store = skillStore(STORE_NS);
  const wallet = store.getJSON<WalletEntry>(`wallet:${userId}`);
  if (!wallet?.address) {
    return { ok: false, reason: "this skill is for holders of the agent's token, and no Bankr wallet is known for you yet" };
  }

  const required = toWei(minHolding);
  if (required === 0n) return { ok: true }; // wallet on record is the whole bar

  const balance = store.getJSON<BalanceEntry>(`balance:${wallet.address}`);
  let held: bigint | null = null;
  try { held = balance ? BigInt(balance.raw) : null; } catch { /* malformed → unknown */ }
  if (held === null) {
    return { ok: false, reason: "this skill is for holders of the agent's token, and your holdings aren't known yet — try again in a moment" };
  }

  if (held < required) {
    return {
      ok: false,
      reason: `this skill requires holding at least ${fmtWhole(required)} of the agent's token — you hold ${fmtWhole(held)}`,
    };
  }
  return { ok: true };
}
