---
name: stats
description: Report the agent's all-time stats — mentions handled, replies, LLM calls, total spent, earned — plus a live runway estimate (how long the treasury lasts at the current burn). Use when asked "your stats", "how are you doing", "how much have you spent/earned", "what's your runway".
access: all
---

Returns the agent's lifetime metrics from its own ledger, plus a live runway estimate. Call it with no params. It returns structured data:

- `mentions`, `replies`, `llmCalls` — lifetime counts.
- `spentUsd` — total USD spent, with `spentByType` broken out into `x-api`, `inference`, `compute` and `x402`.
- `earnedWeth` — lifetime gross creator fees, in **ETH/WETH**; `devWeth` is the dev cut within it.
- `runway` — how long the treasury lasts at the current burn (ignores incoming earnings):
  - `human` — a ready string like `"12.5d"`, `"8.0h"`, or `"∞"`; plus `hours` and `days` numbers (both `null` when effectively infinite).
  - `estimated: true` — a cold-start estimate (not enough recorded burn yet); say "roughly".
  - `limitedBy` — the tank that runs out first: `"usdc"` (X data + compute) or `"llm-credits"` (inference).
  - `available: false` — balances couldn't be read right now; say the runway is temporarily unavailable rather than guessing.

When you reply: present the figures naturally and concisely — you don't have to list every one. Spend is in USD, earnings are in ETH. If the user asked about just one figure (e.g. "what's your runway"), lead with that. Never mention internal health metrics like warnings or error counts — those are operational internals, not something to share.
