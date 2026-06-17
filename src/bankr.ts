// Single client for the Bankr REST API (https://api.bankr.bot). Every Bankr
// call goes through bankrApi() so the base URL, auth header, and error handling
// live in exactly one place. Config-free (takes the API key as an argument) so
// the deploy script can use it before env validation runs.

const BANKR_API = "https://api.bankr.bot";

type BankrAuth = "key" | "bearer";

export type BankrX402PayResult<T = unknown> = {
  success: boolean;
  status: number;
  response: T;
  error?: string;
  paymentMade?: {
    amountUsd: number;
    network: string;
  };
};

function jsonStringify(value: unknown): string {
  return JSON.stringify(value, (key, v) => {
    if (typeof v !== "bigint") return v;
    if (key === "chainId" && v <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(v);
    return v.toString();
  });
}

export async function bankrApi<T = unknown>(
  apiKey: string,
  path: string,
  init: Omit<RequestInit, "headers"> & {
    auth?: BankrAuth;
    headers?: Record<string, string>;
    // When set, a non-2xx response whose body is valid JSON is returned instead
    // of throwing. Used for /wallet/x402-pay, which returns HTTP 400 with a
    // structured BankrX402PayResult body when the payment itself fails.
    tolerateHttpError?: boolean;
  } = {},
): Promise<T> {
  const { auth = "key", headers, tolerateHttpError, ...rest } = init;
  const res = await fetch(`${BANKR_API}${path}`, {
    ...rest,
    headers: {
      "Content-Type": "application/json",
      ...(auth === "bearer" ? { Authorization: `Bearer ${apiKey}` } : { "X-API-Key": apiKey }),
      ...headers,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    if (tolerateHttpError) {
      try {
        return JSON.parse(body) as T;
      } catch {
        // not JSON — fall through to the throw below
      }
    }
    throw new Error(`Bankr ${path} failed: ${res.status} ${body}`);
  }
  return res.json() as Promise<T>;
}

export async function bankrSignTypedData(apiKey: string, typedData: unknown): Promise<`0x${string}`> {
  const { signature } = await bankrApi<{ signature: string }>(apiKey, "/wallet/sign", {
    method: "POST",
    body: jsonStringify({ signatureType: "eth_signTypedData_v4", typedData }),
  });
  return signature as `0x${string}`;
}

// EIP-191 personal_sign over a UTF-8 message. Used for x402 Compute's wallet-
// signature auth (X-Auth-* headers) on instance management endpoints.
export async function bankrSignMessage(apiKey: string, message: string): Promise<`0x${string}`> {
  const { signature } = await bankrApi<{ signature: string }>(apiKey, "/wallet/sign", {
    method: "POST",
    body: jsonStringify({ signatureType: "personal_sign", message }),
  });
  return signature as `0x${string}`;
}

export async function bankrX402Pay<T = unknown>(
  apiKey: string,
  url: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  body: string | undefined,
  maxPaymentUsd: number,
): Promise<BankrX402PayResult<T>> {
  return bankrApi<BankrX402PayResult<T>>(apiKey, "/wallet/x402-pay", {
    method: "POST",
    body: JSON.stringify({ url, method, body, maxPaymentUsd }),
    // A failed payment comes back as HTTP 400 with a structured result body — let
    // payFetch see it (and log paymentMade vs response) instead of throwing here.
    tolerateHttpError: true,
  });
}

// Launch a fixed-supply token on Base via Bankr (gas sponsored). `feeRecipient`
// routes trading fees: we send `{ type:"x", value:<agent handle> }` so the agent's
// token funds the agent. Used by `yappr deploy` when the operator has no token yet.
// Never pass simulateOnly (it skips the deploy).
//
// Token launches require a Bankr Club subscription, which forked operators won't
// have — so launches always go through TOKEN_LAUNCH_API_KEY (below), NOT the
// operator's own key. Trading fees still route to the operator's own handle via
// `feeRecipient`, so the launch key never captures them.
//
// Field names mirror the official @bankr/cli DeployTokenRequest EXACTLY — the API
// silently ignores unknown keys, so the link fields MUST be `tweetUrl`/`websiteUrl`
// (not `tweet`/`website`), or they're dropped.
export type TokenLaunchInput = {
  tokenName: string;
  tokenSymbol: string;
  feeRecipient?: { type: "wallet" | "x" | "farcaster" | "ens"; value: string };
  image?: string;
  description?: string;
  tweetUrl?: string;
  websiteUrl?: string;
};
export type TokenLaunchResult = {
  success?: boolean;
  tokenAddress?: string;   // the deployed CA
  poolId?: string;
  txHash?: string;
  chain?: string;
  [k: string]: unknown;
};
// Dedicated launch-only Bankr key. Holds ONLY the token-launch permission (no
// wallet/sign/spend), so every deployed instance can launch its agent token through
// a Bankr Club account even when the operator has no Club key of their own. Shared
// deliberately — note it ships compiled in the published package, so treat it as
// public; rotate it on the Bankr side if it's ever abused (launches are the only
// thing it can do, and fees always go to the operator's handle, not here).
const TOKEN_LAUNCH_API_KEY = "bk_usr_F3xe6wBW_JCkQRJv2LMe769G3YsQxLBKQ942SAfAF";

export async function deployTokenLaunch(input: TokenLaunchInput): Promise<TokenLaunchResult> {
  return bankrApi<TokenLaunchResult>(TOKEN_LAUNCH_API_KEY, "/token-launches/deploy", {
    method: "POST",
    body: JSON.stringify(input),
  });
}
