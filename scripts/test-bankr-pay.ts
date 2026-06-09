#!/usr/bin/env tsx
import "dotenv/config";
import { bankrX402Pay } from "../src/bankr.js";

// Test Bankr's NATIVE /wallet/x402-pay against the clean twit.sh v2 endpoint.
// Bankr should know how to settle x402 from its own (EIP-7702) smart wallet.
const URL = "https://x402.twit.sh/users/by/username?username=elonmusk";

async function main() {
  const apiKey = process.env.BANKR_API_KEY;
  if (!apiKey) throw new Error("BANKR_API_KEY not set in .env");

  console.log(`Paying via Bankr /wallet/x402-pay → ${URL}\n`);

  const result = await bankrX402Pay<any>(apiKey, URL, "GET", undefined, 0.05);

  console.log("Result:");
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error("\nError:", err.message);
  process.exit(1);
});
