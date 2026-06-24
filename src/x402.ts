import { wrapFetchWithPayment, x402Client, x402HTTPClient } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { bankrSignTypedData } from "./bankr.js";

// Config-free x402/Bankr wiring shared by the running agent (src/wallet.ts) and
// the deploy command (src/cli/deploy.ts). Keep this module free of any
// config/env imports so deploy can use it before its own env validation runs.

export type Signer = {
  address: `0x${string}`;
  signTypedData: (args: unknown) => Promise<`0x${string}`>;
};

export function createBankrSigner(apiKey: string, address: `0x${string}`): Signer {
  return { address, signTypedData: (args) => bankrSignTypedData(apiKey, args) };
}

// `maxUsd`, when set, is a hard per-call ceiling on the CLIENT-SIDE x402 path. Without
// it the x402 client signs an EIP-3009 USDC authorization for whatever amount the endpoint
// demands — no upper bound — so a single malicious 402 could drain the wallet in one call.
// The onBeforePaymentCreation hook aborts before signing when the demand exceeds the cap.
// This mirrors the limit the /wallet/x402-pay fallback already enforces (src/wallet.ts
// FALLBACK_MAX_USD), making $5 a symmetric per-call ceiling across BOTH payment paths. The
// requirement's `amount` is atomic USDC (6 decimals), read the same way as the fallback's
// requiredUsd(). Pass `undefined` (e.g. operator-run deploy) to leave the path uncapped.
export function createPayFetch(signer: Signer, baseFetch: typeof fetch = fetch, maxUsd?: number): typeof fetch {
  const client = new x402Client();
  registerExactEvmScheme(client, { signer });
  if (maxUsd != null) {
    client.onBeforePaymentCreation(async ({ selectedRequirements }) => {
      // registerExactEvmScheme registers BOTH the v2 and v1 schemes, so the requirement
      // here may be v2 (`amount`) or v1 (`maxAmountRequired`) — read either, mirroring
      // requiredUsd() below, so a v1 response can't slip the cap. Atomic USDC (6 decimals).
      const r = selectedRequirements as { amount?: string; maxAmountRequired?: string };
      const usd = Number(r.amount ?? r.maxAmountRequired) / 1e6;
      if (Number.isFinite(usd) && usd > maxUsd) {
        return { abort: true, reason: `x402 payment $${usd.toFixed(4)} exceeds the $${maxUsd} per-call cap` };
      }
    });
  }
  return wrapFetchWithPayment(baseFetch, new x402HTTPClient(client));
}
