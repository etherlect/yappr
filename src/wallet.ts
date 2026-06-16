import { config } from "./config.js";
import { log } from "./log.js";
import { bankrApi, bankrX402Pay, type BankrX402PayResult } from "./bankr.js";
import { createBankrSigner, createPayFetch } from "./x402.js";
import { resolveEvmAddress } from "./compute.js";
import { recordSpend, type SpendType } from "./stats.js";
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

// Safety cap on what the /wallet/x402-pay fallback may authorize per call — used
// verbatim when the 402's payment requirements can't be parsed, and as a ceiling
// when they can (guards against an endpoint demanding an absurd amount).
const FALLBACK_MAX_USD = envNumber("X402_FALLBACK_MAX_USD", 5);
const FALLBACK_ATTEMPTS = 2;

// USD price asked by a 402 response: the base64 payment-required header (Bankr
// style) or the JSON body (Coinbase x402 style), whichever parses.
async function requiredUsd(res: Response): Promise<number | undefined> {
  let req: { accepts?: Array<{ maxAmountRequired?: string; amount?: string }> } | undefined;
  const raw = res.headers.get("payment-required") ?? res.headers.get("x-payment-required");
  if (raw) {
    try { req = JSON.parse(Buffer.from(raw, "base64").toString("utf8")); } catch { /* try body */ }
  }
  if (!req) {
    try { req = await res.clone().json() as typeof req; } catch { return undefined; }
  }
  const accept = req?.accepts?.[0];
  const atomic = accept?.maxAmountRequired ?? accept?.amount;
  const n = Number(atomic);
  return atomic != null && Number.isFinite(n) ? n / 1e6 : undefined;
}

// Repackage a /wallet/x402-pay gateway result as a Response so callers see the
// same shape as the client-side path, including the paid amount for paidUsd().
function gatewayResponse(result: BankrX402PayResult): Response {
  const body = typeof result.response === "string" ? result.response : JSON.stringify(result.response ?? null);
  const res = new Response(body, {
    status: result.status || (result.success ? 200 : 402),
    headers: typeof result.response === "string" ? undefined : { "Content-Type": "application/json" },
  });
  if (result.paymentMade?.amountUsd) {
    _paidAtomic.set(res, BigInt(Math.round(result.paymentMade.amountUsd * 1e6)));
  }
  return res;
}

// Which spend category an x402 call bills to, by host: the compute API
// (compute.x402layer.cc) and the X data endpoint (x402.twit.sh) keep their own lines;
// everything else a skill/hook pays for (image gen, other x402 APIs) rolls up under "x402".
function spendCategory(url: string): SpendType {
  if (url.includes("compute.x402layer.cc")) return "compute";
  if (url.includes("twit.sh")) return "x-api";
  return "x402";
}

export async function payFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const url = requestUrl(input);
  const method = (init.method ?? "GET").toUpperCase();

  let res: Response | undefined;
  let clientErr: unknown;
  try {
    res = await paidFetch()(input, init);
  } catch (err) {
    clientErr = err;
  }

  // Fallback: a 402 left after the client-side payment retry (or a thrown payment
  // error) is usually Bankr having EIP-7702-delegated the wallet to a smart account
  // after a server-side op (transfer/swap/fee claim) — the EOA then has code, USDC
  // validates EIP-3009 signatures via ERC-1271 on the delegate, and the plain
  // /wallet/sign signature is rejected. Bankr's /wallet/x402-pay gateway clears the
  // delegation and pays in one call, so route the same request through it.
  if (!res || res.status === 402) {
    const maxUsd = Math.min((res && (await requiredUsd(res))) ?? FALLBACK_MAX_USD, FALLBACK_MAX_USD);
    log.warn(
      { url: redactUrl(url), method, status: res?.status, maxUsd, err: clientErr instanceof Error ? clientErr.message : clientErr },
      "x402 client-side payment failed — falling back to Bankr /wallet/x402-pay",
    );
    for (let attempt = 1; attempt <= FALLBACK_ATTEMPTS; attempt++) {
      try {
        const result = await bankrX402Pay(
          config.bankrApiKey, url, method as "GET" | "POST" | "PUT" | "DELETE",
          typeof init.body === "string" ? init.body : undefined, maxUsd,
        );
        if (result.success) {
          res = gatewayResponse(result);
          break;
        }
        log.warn({ url: redactUrl(url), attempt, status: result.status, err: result.error }, "x402-pay fallback failed");
      } catch (err) {
        log.warn({ url: redactUrl(url), attempt, err: err instanceof Error ? err.message : String(err) }, "x402-pay fallback errored");
      }
    }
    // Both paths exhausted: surface the original client-side failure — the 402
    // response if there was one, otherwise the thrown error.
    if (!res) throw clientErr;
  }

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
  // into the ledger. Categorise by host: the compute API, the X data endpoint, or any
  // other x402 endpoint a skill/hook calls (image gen, etc.) → the generic "x402".
  // (Inference isn't x402 — it's recorded separately from the credit balance.)
  const paid = paidUsd(res);
  if (paid != null && paid > 0) recordSpend(spendCategory(url), paid);

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
