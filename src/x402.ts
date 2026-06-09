import { wrapFetchWithPayment, x402Client, x402HTTPClient } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { bankrSignTypedData } from "./bankr.js";

// Config-free x402/Bankr wiring shared by the running agent (src/wallet.ts) and
// the one-shot deploy script (scripts/deploy.ts). Keep this module free of any
// config/env imports so deploy can use it before its own env validation runs.

export type Signer = {
  address: `0x${string}`;
  signTypedData: (args: unknown) => Promise<`0x${string}`>;
};

export function createBankrSigner(apiKey: string, address: `0x${string}`): Signer {
  return { address, signTypedData: (args) => bankrSignTypedData(apiKey, args) };
}

export function createPayFetch(signer: Signer, baseFetch: typeof fetch = fetch): typeof fetch {
  const client = new x402Client();
  registerExactEvmScheme(client, { signer });
  return wrapFetchWithPayment(baseFetch, new x402HTTPClient(client));
}
