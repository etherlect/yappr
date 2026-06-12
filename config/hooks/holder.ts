import { agentPrompt, skillStore, log, config, type AgentHooks } from "yappr";

// Holder context. Resolves the asker's Bankr wallet address (via a Bankr
// agent job — their wallet is custodied by Bankr, keyed to their X handle) and
// their on-chain balance of the agent's own token, then injects both into the
// prompt context so the model knows whether it's talking to a holder.
// Delete this file to disable — nothing in the engine depends on it.
//
// Cost model:
//   - The agent-job lookup runs in Max Mode (billed from LLM credits per
//     request — see agent-prompt.ts), so it fires ONCE per user: a resolved
//     address is stored forever; a "no Bankr account" result is retried only
//     after NO_WALLET_RETRY_MS.
//   - The balance is a free public-RPC read, cached for BALANCE_TTL_MS so a
//     chatty user doesn't trigger a call per mention.
// Storage is the shared SQLite DB via skillStore("bankr-wallet"), so both
// caches survive restarts/redeploys and ride along in backups.

const BALANCE_TTL_MS = 3_600_000;            // re-check holdings at most hourly
const NO_WALLET_RETRY_MS = 24 * 3_600_000;   // re-ask Bankr for no-wallet users daily
// Cap on how long a reply waits for a first-time wallet lookup. The Bankr job
// usually answers in ~10-20s; past the cap the reply proceeds without the block
// and the still-running job stores its result for the user's next mention.
const RESOLVE_TIMEOUT_MS = 45_000;

const BASE_RPC = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const TOKEN_DECIMALS = 18; // Bankr launches are fixed 18-decimal Clanker deploys

const store = skillStore("bankr-wallet");

// wallet:<userId> — resolved once per user; address null = "no Bankr account".
type WalletEntry = { address: string | null; at: number };
// balance:<address> — bigint as string (JSON can't hold bigints).
type BalanceEntry = { raw: string; at: number };

// One lookup per user even when mentions arrive back-to-back.
const inflight = new Map<string, Promise<string | null>>();

function resolveWallet(userId: string, handle: string): Promise<string | null> {
  const cached = store.getJSON<WalletEntry>(`wallet:${userId}`);
  if (cached?.address) return Promise.resolve(cached.address);
  if (cached && Date.now() - cached.at < NO_WALLET_RETRY_MS) return Promise.resolve(null);
  const running = inflight.get(userId);
  if (running) return running;

  const p = (async (): Promise<string | null> => {
    try {
      const text = await agentPrompt(
        `What is the EVM wallet address of the X user @${handle}? ` +
        `Reply with only the address, or the word "none" if they have no Bankr account.`,
      );
      const address = text.match(/0x[a-fA-F0-9]{40}/)?.[0] ?? null;
      // Negative results are cached too (with a retry window) — without that,
      // every mention from a wallet-less user would burn a paid agent job.
      store.setJSON(`wallet:${userId}`, { address, at: Date.now() } satisfies WalletEntry);
      log.info({ user: handle, address }, "holder: resolved bankr wallet");
      return address;
    } catch (err) {
      // Transient failure — store nothing so the next mention retries.
      log.warn({ user: handle, err: err instanceof Error ? err.message : String(err) }, "holder: wallet lookup failed");
      return null;
    } finally {
      inflight.delete(userId);
    }
  })();
  inflight.set(userId, p);
  return p;
}

// Bare-bones eth_call helper (no client dependency needed for two views).
async function ethCall(to: string, data: string): Promise<string | null> {
  const res = await fetch(BASE_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await res.json()) as { result?: string };
  return body.result && /^0x[0-9a-fA-F]*$/.test(body.result) ? body.result : null;
}

// The token's ticker via symbol() — fetched once, then stored forever (it's
// immutable on-chain). Falls back to "your token" until the read succeeds.
async function tokenSymbol(): Promise<string> {
  const cached = store.get("meta:symbol");
  if (cached) return cached;
  try {
    const hex = await ethCall(config.tokenAddress, "0x95d89b41"); // symbol()
    if (hex && hex.length >= 2 + 64 * 2) {
      // Standard ABI string return: 32-byte offset, 32-byte length, then data.
      const len = Number(BigInt("0x" + hex.slice(2 + 64, 2 + 128)));
      const symbol = Buffer.from(hex.slice(2 + 128, 2 + 128 + len * 2), "hex").toString("utf8").trim();
      if (symbol) {
        store.set("meta:symbol", symbol);
        return symbol;
      }
    }
  } catch { /* fall through */ }
  return "your token";
}

// balanceOf(holder) via raw eth_call.
async function fetchBalance(holder: string): Promise<bigint | null> {
  const data = "0x70a08231" + holder.slice(2).toLowerCase().padStart(64, "0");
  const result = await ethCall(config.tokenAddress, data);
  return result && result !== "0x" ? BigInt(result) : null;
}

async function tokenBalance(holder: string): Promise<bigint | null> {
  const cached = store.getJSON<BalanceEntry>(`balance:${holder}`);
  if (cached && Date.now() - cached.at < BALANCE_TTL_MS) return BigInt(cached.raw);
  try {
    const bal = await fetchBalance(holder);
    if (bal !== null) {
      store.setJSON(`balance:${holder}`, { raw: bal.toString(), at: Date.now() } satisfies BalanceEntry);
      return bal;
    }
  } catch { /* fall through to stale */ }
  return cached ? BigInt(cached.raw) : null; // a stale figure beats none
}

// "12.34M" / "5.6K" / "0.42" — compact, the model doesn't need full precision.
function fmtTokens(v: bigint): string {
  const n = Number(v) / 10 ** TOKEN_DECIMALS;
  if (n === 0) return "0";
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  if (n >= 1) return n.toFixed(2);
  return n.toPrecision(2);
}

export const hooks: AgentHooks = {
  // PREPENDED like the user-memory block, so the current ask (ASKER TWEET)
  // stays last and most salient.
  async onBeforeInference({ tweet, question, context }) {
    const userId = tweet.author?.id;
    const handle = tweet.author?.username;
    if (!userId || !handle) return { question, context };

    const address = await Promise.race([
      resolveWallet(userId, handle),
      new Promise<null>((res) => setTimeout(res, RESOLVE_TIMEOUT_MS)),
    ]);
    if (!address) return { question, context };

    const [balance, symbol] = await Promise.all([tokenBalance(address), tokenSymbol()]);
    const block =
      `=== ASKER BANKR WALLET ===\n` +
      `@${handle}'s Bankr wallet address: ${address}\n` +
      `Their balance of ${symbol === "your token" ? symbol : `$${symbol}`} (your token): ${balance !== null ? fmtTokens(balance) : "unknown"}`;
    return { question, context: context ? `${block}\n\n${context}` : block };
  },
};
