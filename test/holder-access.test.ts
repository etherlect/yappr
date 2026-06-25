import "./setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkHolderAccess } from "../src/skills/holder-access.js";
import { skillStore } from "../src/storage.js";
import type { Tweet } from "../src/x/types.js";

// The code-side token-gate, fed only by the asker's X-API identity and DB-cached
// holdings — never model params. Seed the same store the holder hook writes to, then
// assert the gate. Distinct user ids per case keep them independent in the shared
// in-memory DB.

const store = skillStore("bankr-wallet");
const ONE_TOKEN = 10n ** 18n; // 18-decimal Clanker deploys
const tweet = (id: string): Tweet => ({ author: { id, username: id } } as unknown as Tweet);

test("denies when the tweet has no author id", () => {
  assert.equal(checkHolderAccess({ author: undefined } as unknown as Tweet, 0).ok, false);
});

test("denies when no Bankr wallet is known for the user", () => {
  assert.equal(checkHolderAccess(tweet("u-unknown"), 0).ok, false);
});

test("min holding 0: any known wallet passes (wallet on record is the gate)", () => {
  store.setJSON("wallet:u-zero", { address: "0xZERO", at: Date.now() });
  assert.deepEqual(checkHolderAccess(tweet("u-zero"), 0), { ok: true });
});

test("passes when the balance meets the threshold", () => {
  store.setJSON("wallet:u-rich", { address: "0xRICH", at: Date.now() });
  store.setJSON("balance:0xRICH", { raw: (1500n * ONE_TOKEN).toString(), at: Date.now() });
  assert.deepEqual(checkHolderAccess(tweet("u-rich"), 1000), { ok: true });
});

test("denies when the balance is below the threshold", () => {
  store.setJSON("wallet:u-poor", { address: "0xPOOR", at: Date.now() });
  store.setJSON("balance:0xPOOR", { raw: (10n * ONE_TOKEN).toString(), at: Date.now() });
  assert.equal(checkHolderAccess(tweet("u-poor"), 1000).ok, false);
});

test("denies when the wallet is known but the balance isn't (threshold > 0)", () => {
  store.setJSON("wallet:u-nobal", { address: "0xNOBAL", at: Date.now() });
  assert.equal(checkHolderAccess(tweet("u-nobal"), 1000).ok, false);
});
