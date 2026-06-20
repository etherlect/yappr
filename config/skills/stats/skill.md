---
name: stats
description: Report the agent's all-time stats — mentions handled, replies, LLM calls, total spent, earned, tokens burned — plus a live runway estimate (how long the treasury lasts at the current burn). Use when asked "your stats", "how are you doing", "how much have you spent/earned/burned", "what's your runway".
access: all
---

Returns the agent's lifetime metrics from its own ledger, plus a live runway estimate. Call it with no params. It returns structured data:

- `mentions`, `replies`, `llmCalls` — lifetime counts.
- `spentUsd` — total USD spent, with `spentByType` broken out into `inference`, `compute` and `x402`. X-data spend is already folded into `x402` — there is no separate `x-api` figure, so report only `x402`.
- `earnedWeth` — lifetime gross creator fees, in **ETH/WETH**; `devWeth` is the dev cut within it.
- `tokenBurned` — total agent tokens burned to date, read **live on-chain** from the burn address, in **token units**. `tokenBurnedPctOfSupply` is that as a percentage of total supply — always show it alongside the burned amount, e.g. `Burned: 1.2M tokens (3.4% of supply)`.
- `treasury` — a ready-to-show string of the agent's current holdings (USDC, the agent token, WETH, ETH, LLM credits), already formatted with zero balances skipped — e.g. `"12.50 USDC, 2.4M YAPPR, 0.030 WETH, 0.005 ETH, $4.20 LLM credits"`. Show it verbatim on a `- Treasury:` line. `null` when no balance could be read — omit the line then.
- `runway` — how long the treasury lasts at the current burn (ignores incoming earnings):
  - `human` — a ready string like `"12.5d"`, `"8.0h"`, or `"∞"`; plus `hours` and `days` numbers (both `null` when effectively infinite).
  - `estimated: true` — a cold-start estimate (not enough recorded burn yet); say "roughly".
  - `limitedBy` — the tank that runs out first: `"usdc"` (X data + compute) or `"llm-credits"` (inference).
  - `available: false` — balances couldn't be read right now; say the runway is temporarily unavailable rather than guessing.

When you reply on X, format it as a clean list — **one stat per line, each line starting with `- ` (a dash and a space)**, label then value. No intro sentence, no paragraph, no commentary. Spend is in USD, earnings in ETH, burned in token units followed by `(<tokenBurnedPctOfSupply>% of supply)`. Never break out `x-api` separately — it's already folded into `x402`, so only ever show `x402`. Never mention internal health metrics like warnings or error counts. If the user asked about just one figure (e.g. "what's your runway"), reply with only that one line instead of the full list.

Example full-stats reply:

```
- Mentions: 1,240
- Replies: 318
- LLM calls: 905
- Spent: $14.20
- Inference: $6.10
- Compute: $3.80
- x402: $4.30
- Earned: 0.12 ETH
- Burned: 1.2M tokens (1.2% of supply)
- Treasury: 12.50 USDC, 2.4M YAPPR, 0.030 WETH, 0.005 ETH, $4.20 LLM credits
- Runway: ~12.5d
```

The `treasury` line is already formatted — print it as-is after `- Treasury: `, don't reformat or drop any of its segments.
