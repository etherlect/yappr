import "./setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPayFetch } from "../src/x402.js";

// The client-side x402 spend cap: a single paid call must never authorize more than
// the per-call ceiling. Drive the real createPayFetch with a mock fetch that serves a
// 402, and assert the cap aborts over the limit (on both the v2 `amount` and the v1
// `maxAmountRequired` wire shapes, since registerExactEvmScheme registers both).

const signer = {
  address: "0x0000000000000000000000000000000000000001" as `0x${string}`,
  signTypedData: async () => ("0x" + "11".repeat(65)) as `0x${string}`,
};
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAYTO = "0x0000000000000000000000000000000000000002";
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");

function v2Resp(amountAtomic: string): Response {
  const pr = {
    x402Version: 2,
    resource: { resource: "https://test.local/api", description: "t" },
    accepts: [{ scheme: "exact", network: "eip155:8453", amount: amountAtomic, asset: USDC, payTo: PAYTO, maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } }],
  };
  return new Response("", { status: 402, headers: { "PAYMENT-REQUIRED": b64(pr) } });
}
function v1Resp(amountAtomic: string): Response {
  const pr = {
    x402Version: 1,
    accepts: [{ scheme: "exact", network: "base", maxAmountRequired: amountAtomic, resource: "https://test.local/api", description: "t", payTo: PAYTO, maxTimeoutSeconds: 60, asset: USDC, extra: { name: "USD Coin", version: "2" } }],
  };
  return new Response(JSON.stringify(pr), { status: 402, headers: { "Content-Type": "application/json" } });
}

async function run(make: () => Response, capUsd = 5): Promise<{ blocked: boolean; msg: string }> {
  let calls = 0;
  const mockFetch = (async () => {
    calls += 1;
    return calls === 1 ? make() : new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;
  const payFetch = createPayFetch(signer, mockFetch, capUsd);
  try {
    const res = await payFetch("https://test.local/api", { method: "GET" });
    return { blocked: false, msg: `resolved ${res.status}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { blocked: /per-call cap/.test(msg), msg };
  }
}

test("blocks a v2 payment over the $5 cap", async () => {
  const r = await run(() => v2Resp("10000000")); // $10
  assert.equal(r.blocked, true, r.msg);
});

test("allows a v2 payment under the cap", async () => {
  const r = await run(() => v2Resp("4000000")); // $4
  assert.equal(r.blocked, false, r.msg);
});

test("blocks a v1 (maxAmountRequired) payment over the cap", async () => {
  const r = await run(() => v1Resp("10000000")); // $10
  assert.equal(r.blocked, true, r.msg);
});
