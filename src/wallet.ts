import { config } from "./config.js";
import { log } from "./log.js";
import { bankrApi } from "./bankr.js";
import { createBankrSigner, createPayFetch } from "./x402.js";
import { resolveEvmAddress } from "./compute.js";
import { recordSpend } from "./stats.js";
import { sleep, envNumber } from "./util.js";

let _walletAddress: `0x${string}` | null = null;
let _payFetch: typeof fetch | null = null;

export async function initBankr(): Promise<`0x${string}`> {
  // `/wallet/me` returns the EVM wallet under `wallets[]` (the Bankr EIP-7702 wallet
  // has no top-level `address`), so resolve it the same robust way as everywhere else
  // — and throw clearly if it's missing, rather than silently storing `undefined`.
  _walletAddress = await resolveEvmAddress(config.bankrApiKey);
  return _walletAddress;
}

export function walletAddress(): `0x${string}` {
  if (!_walletAddress) throw new Error("initBankr() not called yet");
  return _walletAddress;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

// Redact credentials carried as query params (auth_token/ct0) before logging a URL.
function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const k of ["auth_token", "ct0"]) {
      if (u.searchParams.has(k)) u.searchParams.set(k, "[redacted]");
    }
    return u.toString();
  } catch {
    return url;
  }
}

// Atomic USDC amount paid for a given Response, captured from the X-PAYMENT header
// the x402 client attaches to its (paid) retry request. Keyed on the Response so
// concurrent paid calls can't clobber each other's amount. wrapFetchWithPayment
// returns the paid response object directly, so the lookup in payFetch hits.
const _paidAtomic = new WeakMap<Response, bigint>();

// Read the EIP-3009 `authorization.value` (atomic USDC) out of a base64 X-PAYMENT /
// PAYMENT-SIGNATURE header so we can report what each call actually cost.
function paymentAtomic(headers: Headers): bigint | undefined {
  const raw = headers.get("x-payment") ?? headers.get("payment-signature");
  if (!raw) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
    const value = decoded?.payload?.authorization?.value;
    return value != null ? BigInt(value) : undefined;
  } catch {
    return undefined;
  }
}

// Base fetch that records the paid amount per response, then delegates to fetch.
const tracedFetch: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);
  // wrapFetchWithPayment sends a Request object (headers on it, no init) on the
  // paid retry; a first, unpaid attempt carries no payment header and is ignored.
  const headers = input instanceof Request ? input.headers : new Headers(init?.headers as HeadersInit | undefined);
  const atomic = paymentAtomic(headers);
  if (atomic != null) _paidAtomic.set(res, atomic);
  return res;
};

// Client-side x402 paid fetch: the @x402/fetch client signs the EIP-3009 payment
// authorization locally (via Bankr /wallet/sign) and sends the X-PAYMENT header
// itself — instead of delegating the whole flow to Bankr's /wallet/x402-pay
// gateway. Built lazily (after initBankr() resolves the wallet address) and reused.
function paidFetch(): typeof fetch {
  if (!_payFetch) {
    const signer = createBankrSigner(config.bankrApiKey, walletAddress());
    _payFetch = createPayFetch(signer, tracedFetch);
  }
  return _payFetch;
}

export async function payFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const url = requestUrl(input);
  const method = (init.method ?? "GET").toUpperCase();
  const res = await paidFetch()(input, init);

  // /tweets/mentions is polled constantly — skip its success log to keep logs
  // clean. Failures are always logged. The per-call USD cost is captured per
  // response (see paidUsd) and logged by the caller (x/client, treasury) on the
  // line that's actually shown, so the amount appears next to the call itself.
  const isMentions = url.includes("/tweets/mentions");
  const safeUrl = redactUrl(url);
  // warn, not error: this layer rethrows nothing itself but every caller throws on
  // !res.ok and the failure is logged as ONE error where it's finally handled —
  // logging error here too would count a single failure 2-3× in the stats ledger.
  if (!res.ok) log.warn({ url: safeUrl, method, status: res.status }, "x402 payFetch failed");
  else if (!isMentions) log.info({ url: safeUrl, method, status: res.status }, "x402 payFetch ok");

  // Every x402 payment funnels through here, so it's the one place to record spend
  // into the ledger. Categorise by host: the compute API vs. the X data endpoint.
  // (Inference isn't x402 — it's recorded separately from the credit balance.)
  const paid = paidUsd(res);
  if (paid != null && paid > 0) recordSpend(url.includes("compute.x402layer.cc") ? "compute" : "x-api", paid);

  return res;
}

// USD cost (USDC, 6 decimals) of the paid call that produced `res`, or undefined if
// the response wasn't a paid one. Callers log this on their own success line so the
// amount shows up where the call is reported (e.g. "x-api GET ... ok {usd}").
export function paidUsd(res: Response): number | undefined {
  const atomic = _paidAtomic.get(res);
  return atomic != null ? Number(atomic) / 1e6 : undefined;
}

// Fixed pause before each submit so rapid back-to-back treasury txs (dev cut → burn →
// swap → extend) don't trip the Bankr signer's in-flight limit; and attempts/backoff for
// retrying transient signer/provider errors (provider_inflight_limit, 5xx, timeouts, …).
const SUBMIT_PAUSE_MS = envNumber("TX_SUBMIT_PAUSE_MS", 1500);
const SUBMIT_MAX_ATTEMPTS = envNumber("TX_SUBMIT_MAX_ATTEMPTS", 5);

export async function submitTx(to: string, data: string): Promise<string> {
  if (config.treasuryDryRun) {
    log.info({ to, data: data.slice(0, 66) + "..." }, "bankr [dry run] submitTx");
    return "0xdry000000000000000000000000000000000000000000000000000000000000";
  }
  // Space submissions out, then retry any failure with exponential backoff (2s, 4s, 8s,
  // 16s) — gives a busy signer time to clear before the next attempt.
  await sleep(SUBMIT_PAUSE_MS);
  let lastErr: unknown;
  for (let attempt = 1; attempt <= SUBMIT_MAX_ATTEMPTS; attempt++) {
    try {
      // Bankr's /wallet/submit expects the tx nested under `transaction` (not flat) and
      // returns `transactionHash`.
      const res = await bankrApi<{ transactionHash?: string; txHash?: string }>(config.bankrApiKey, "/wallet/submit", {
        method: "POST",
        body: JSON.stringify({
          transaction: { to, data, chainId: 8453 },
          waitForConfirmation: true,
        }),
      });
      return res.transactionHash ?? res.txHash ?? "";
    } catch (err) {
      lastErr = err;
      if (attempt < SUBMIT_MAX_ATTEMPTS) {
        const delayMs = 2000 * 2 ** (attempt - 1); // 2s → 4s → 8s → 16s
        log.warn({ to, attempt, maxAttempts: SUBMIT_MAX_ATTEMPTS, delayMs, err: err instanceof Error ? err.message : String(err) }, "submitTx failed — retrying after backoff");
        await sleep(delayMs);
      }
    }
  }
  throw lastErr;
}
