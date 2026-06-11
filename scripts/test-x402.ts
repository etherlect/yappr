#!/usr/bin/env tsx
import "dotenv/config";
import { bankrApi } from "../src/bankr.js";
import { createBankrSigner, createPayFetch } from "../src/x402.js";

// const URL = "https://x402.twit.sh/users/by/username?username=elonmusk"; // route that settles
// The /tweets/mentions route the poller uses (the one failing CDP settle). auth_token/ct0
// come from the instance .env (loaded via DOTENV_CONFIG_PATH), same as the running agent.
const URL = `https://x402.twit.sh/tweets/mentions?auth_token=${process.env.TWITTER_AUTH_TOKEN}&ct0=${process.env.TWITTER_CT0}`;

// Logging fetch passed as BASE to wrapFetchWithPayment, so every request
// (initial 402 probe AND payment retry) flows through here.
function makeLoggingFetch(): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = req.url;
    const method = req.method;

    const headers: Record<string, string> = Object.fromEntries(req.headers.entries());
    const loggable: Record<string, unknown> = { ...headers };

    // Decode payment headers for readability
    for (const key of ["x-payment", "payment-signature", "X-PAYMENT", "PAYMENT-SIGNATURE"]) {
      const match = Object.keys(loggable).find((k) => k.toLowerCase() === key.toLowerCase());
      if (match && loggable[match]) {
        try {
          loggable[`${match} (decoded)`] = JSON.parse(
            Buffer.from(loggable[match] as string, "base64").toString(),
          );
          delete loggable[match];
        } catch { /* keep raw */ }
      }
    }

    let body: unknown;
    try {
      const text = await req.clone().text();
      if (text) body = JSON.parse(text);
    } catch { /* no body */ }

    console.log(`\n→ ${method} ${url}`);
    console.log(JSON.stringify({ headers: loggable, ...(body !== undefined ? { body } : {}) }, null, 2));

    const res = await fetch(input, init);

    // Log 402 response details (payment requirements)
    if (res.status === 402) {
      const reqHeader = res.headers.get("payment-required") ?? res.headers.get("x-payment-required");
      if (reqHeader) {
        try {
          console.log("\n  402 payment-required (decoded):");
          console.log(JSON.stringify(JSON.parse(Buffer.from(reqHeader, "base64").toString()), null, 2));
        } catch { /* keep raw */ }
      }
    }

    console.log(`← ${res.status}`);
    return res;
  };
}

async function main() {
  const apiKey = process.env.BANKR_API_KEY;
  if (!apiKey) throw new Error("BANKR_API_KEY not set in .env");

  const me = await bankrApi<any>(apiKey, "/wallet/me");
  const address: `0x${string}` =
    me.wallets?.find((w: any) => w.chain === "evm")?.address ?? me.address;
  if (!address) throw new Error("Could not resolve EVM wallet address");
  console.log(`Wallet: ${address}`);

  const signer = createBankrSigner(apiKey, address);
  const payFetch = createPayFetch(signer, makeLoggingFetch());

  console.log(`\nFetching: ${URL}`);
  const res = await payFetch(URL);

  const text = await res.text();
  let responseBody: unknown;
  try { responseBody = JSON.parse(text); } catch { responseBody = text; }

  console.log("\n=== Final Response ===");
  console.log("Status:", res.status);
  console.log("Body:", JSON.stringify(responseBody, null, 2));
}

main().catch((err) => {
  console.error("\nError:", err.message);
  process.exit(1);
});
