# Tests

A focused suite over the **deterministic, high-consequence** parts of the engine —
the code where a bug silently loses money or breaks an access boundary. It does not
chase coverage, and it does not try to test the LLM (see below).

```bash
npm test          # node's built-in runner via tsx
```

Run via Node's built-in test runner (`node:test`) transpiled on the fly by `tsx` — no
extra dependencies. Each file imports `./setup.js` first, which points the SQLite layer
at an in-memory DB and sets dummy env, so tests never touch a real `.env`, the network,
or your `yappr.db`. External boundaries (X, Bankr, the chain, the LLM gateway) are faked.

## What's covered

| File | Module | Why |
|------|--------|-----|
| `gating.test.ts` | `reply/gating.ts` | mention positioning — decides whether to engage |
| `holder-access.test.ts` | `skills/holder-access.ts` | the code-side token-gate (security) |
| `schedule.test.ts` | `cron/schedule.ts` | schedule grammar + DST-safe next-run math |
| `parse-step.test.ts` | `reply/agent.ts` | parsing the model's per-turn JSON |
| `stats.test.ts` | `stats.ts` | the spend/earn ledger (past metric bugs lived here) |
| `x402-cap.test.ts` | `x402.ts` | the per-call x402 spend cap |

## What's deliberately *not* here

- **Model behaviour** (does it refuse a prompt injection, pick the right skill) is
  non-deterministic — that's **evals** (scored over a prompt set), not pass/fail unit
  tests. Worth doing, separately.
- **End-to-end** (deploy → live agent on X) stays manual / staging. Use
  `TREASURY_DRY_RUN=true`, `yappr status --check`, and `--demo` for that.

Test files are run by `tsx` (types are stripped, not checked) and live outside
`tsconfig`'s `include`, so they never compile into `dist/` or ship to npm.
