---
name: stats
description: Report the agent's all-time stats — mentions handled, replies, LLM calls, total spent, earned, tokens burned — plus a live runway estimate (how long the treasury lasts at the current burn). Use when asked "your stats", "how are you doing", "how much have you spent/earned/burned", "what's your runway".
access: all
---

Returns the agent's metrics from its own ledger, plus live balances and a runway estimate. Call it with no params. The data is grouped into three objects:

**`daily`** — activity over the **last 24h**: `mentions`, `replies`, `llmCalls`; `spentUsd` with `spentByType` (`inference` / `compute` / `x402`); `earnedWeth` (ETH/WETH); `tokenBurned` (tokens burned in the window).

**`allTime`** — the same lifetime totals: `mentions`, `replies`, `llmCalls`; `spentUsd` + `spentByType`; `earnedWeth` with `devWeth` (the dev cut within it); `tokenBurned` (total burned to date, read **live on-chain**) and `tokenBurnedPctOfSupply` (always show alongside the amount, e.g. `1.2M tokens (3.4% of supply)`).

**`balance`** — current state:
- `treasury` — a ready-to-show holdings string (USDC, the agent token, WETH, ETH, LLM credits), already formatted with zero balances skipped, e.g. `"12.50 USDC, 2.4M YAPPR, 0.030 WETH, 0.005 ETH, $4.20 LLM credits"`. Print it verbatim; `null` ⇒ omit the line.
- `runway` — how long the treasury lasts at the current burn (ignores incoming earnings): `human` (`"12.5d"` / `"8.0h"` / `"∞"`) plus `hours`/`days`; `treasuryUsd` is the combined pool (USDC + prepaid LLM credits, since credits auto-refill from USDC — a low credit balance does NOT shorten runway); `estimated: true` ⇒ a cold-start guess, say "roughly"; `available: false` ⇒ couldn't read balances, say so rather than guessing.

In **every** `spentByType`, X-data spend is already folded into `x402` — there is no separate `x-api`, so only ever show `x402`.

When you reply on X, format it as a clean list under three short section headers — `Last 24h`, `All-time`, `Balance` — with **one stat per line, each line starting with `- ` (a dash and a space)**. No intro sentence, no paragraph, no commentary. Spend in USD, earnings in ETH, burned in token units (all-time followed by `(<tokenBurnedPctOfSupply>% of supply)`). Never mention internal health metrics like warnings or error counts. If the user asked about just one figure (e.g. "what's your runway"), reply with only that one line and skip the rest.

Example full reply:

```
Last 24h
- Mentions: 42
- Replies: 12
- LLM calls: 38
- Spent: $1.20
- Earned: 0.004 ETH
- Burned: 48K tokens

All-time
- Mentions: 1,240
- Replies: 318
- LLM calls: 905
- Spent: $14.20
- Inference: $6.10
- Compute: $3.80
- x402: $4.30
- Earned: 0.12 ETH
- Burned: 1.2M tokens (1.2% of supply)

Balance
- Treasury: 12.50 USDC, 2.4M YAPPR, 0.030 WETH, 0.005 ETH, $4.20 LLM credits
- Runway: ~12.5d
```

The `treasury` line is already formatted — print it as-is after `- Treasury: `, don't reformat or drop any of its segments.
