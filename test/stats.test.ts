import "./setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  recordSpend, recordMention, recordReply, recordLlm,
  recordEarned, recordDevWeth, recordTokenBurned, summary,
} from "../src/stats.js";

// The spend/earn ledger is where the past metric bugs lived (runway/earnings).
// Record a known set of events into the in-memory DB and assert summary() adds
// them up correctly — including the gauge semantics of earnedWeth.

const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

test("summary() reflects the recorded events", () => {
  recordMention(3);
  recordMention(2);
  recordReply();
  recordReply();
  recordLlm();
  recordSpend("x-api", 0.10);
  recordSpend("inference", 0.05);
  recordSpend("x402", 0.20);
  recordEarned(0.5);       // gross creator fees (WETH) — a gauge: first reading sets the baseline
  recordDevWeth(0.1);      // dev cut, booked as an increment
  recordTokenBurned(1000); // agent tokens burned

  const s = summary();

  assert.equal(s.mentions, 5);
  assert.equal(s.replies, 2);
  assert.equal(s.llm, 1);

  assert.ok(near(s.spentUsd, 0.35), `spentUsd=${s.spentUsd}`);
  assert.ok(near(s.spentByType["x-api"], 0.10));
  assert.ok(near(s.spentByType.inference, 0.05));
  assert.ok(near(s.spentByType.x402, 0.20));
  assert.equal(s.spentByType.compute, 0);

  assert.ok(near(s.earnedWeth, 0.5), `earnedWeth=${s.earnedWeth}`);
  assert.ok(near(s.devWeth, 0.1));
  assert.equal(s.tokenBurned, 1000);
});

test("recordSpend ignores non-positive / non-finite amounts", () => {
  const before = summary().spentUsd;
  recordSpend("x402", 0);
  recordSpend("x402", -1);
  recordSpend("x402", Number.NaN);
  assert.ok(near(summary().spentUsd, before));
});
