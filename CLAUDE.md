# CLAUDE.md

Architecture map for contributors working in this repo. For *using/forking* yappr
(env vars, customising personality/skills/hooks), read `README.md` first — this
file is about the code itself.

## What it is

A self-funding X/Twitter reply agent. It pays for every external call (X data, LLM
inference, compute) from a Bankr wallet that is topped up by its own token's trading
fees. **No private key is ever stored** — all signing and payments go through the
Bankr REST API.

## Commands

This is the engine package. A consuming **instance** (its own `config/` + `.env`)
depends on it via `file:../package` and runs it as `yappr <command>` — see the
workspace `README.md` one level up. The CLI lives in `src/cli/` and ships as the
`yappr` bin.

```bash
npm run dev        # run the agent from source (tsx watch; needs a .env here)
npm run dev:old    # same, but backfill & reply to existing mentions (--process-old)
npm run typecheck  # tsc --noEmit — run this after any change
npm run build      # compile to dist/  (the instance consumes dist/)
```

`deploy` / `status` / `ssh` are normally run from an **instance** (`yappr deploy`,
etc.) because they need the instance's `.env` + `config/`. `yappr deploy` bundles
this engine with `npm pack` and installs the tarball on the server (TODO at release:
`npm i yappr` instead). The `npm run deploy|status|ssh` scripts here are just the
source runners for engine dev.

`tsconfig.json` type-checks (and builds) `src/` and `config/`; only `scripts/`
(throwaway test scripts) is excluded. Imports use `.js` extensions (NodeNext ESM);
`tsx` resolves them to `.ts` in dev, and user `.ts` config loads via jiti at runtime.

## Two loops

Everything runs from one process (`src/yappr.ts`), which starts two timers:

1. **Reply loop** — `reply/poller.ts` polls for new @mentions, then `reply/pipeline.ts`
   handles each one: gather thread context → gating (`reply/gating.ts`) → the agent
   reasoning loop (`reply/agent.ts`) → post the reply. The agent loop emits one JSON
   step per turn (call a skill, or reply) until it replies or hits `AGENT_MAX_STEPS`.
2. **Treasury loop** — `treasury/cycle.ts` runs hourly: check claimable fees and
   claim only if there are any → optional dev cut → burn → keep a small ETH gas
   reserve → swap WETH→USDC → extend compute. This is what makes the agent
   self-funding. `treasury/index.ts` holds the on-chain calls.

Boot also prefetches LLM pricing (`loadModelPricing`, for inference costing) and starts
a minute timer polling all-time earnings (`treasury.lifetimeEarned` → `recordEarned`).

## Status dashboard & backups

`yappr status` (`cli/status.ts`) renders a live terminal dashboard by SSHing into the
deployed box. It reads counters by running `stats-cli summary` remotely (never scrapes
logs) and derives three health metrics from the ledger + live on-chain balances:
**Runway** (treasury USD ÷ gross burn across two tanks — USDC for x-api+compute, credits
for inference — whichever empties first; cold-start and a downtime floor use the
poll-cadence cost), **Sustainable** (window earnings ≥ window spend) and **Profitable**
(all-time earnings − spend). The trailing-window figures come from `summary()`, which
also returns `chart` series — cumulative spend/earn over the last 24h (`day`) and
all-time (`all`), plus per-hour spend by category (`byType`, 24 clock-aligned buckets) —
feeding an always-on CHART panel between ACTIVITY and LOGS with four views cycled by
←/→: hourly spent-vs-earned bars, hourly expenses by category (stacked bars), and
all-time / 24h spent-vs-earned line charts (`asciichart`).

While open, the dashboard snapshots the server DB into `instance/backups/yappr-<date>.db`
(one file per day, rolling 7) via `cli/backup.ts` — SQLite `VACUUM INTO` over SSH
(consistent, no `-wal`/`-shm`), on launch, every 20 min, and on quit. `yappr deploy`
restores the latest local backup onto a **fresh** instance (never clobbers an existing
DB); the DB otherwise survives same-instance redeploys because it lives at
`/var/lib/yappr` (`DB_PATH`), outside the wiped `/yappr`.

## src/ map

| Path | Role |
|------|------|
| `yappr.ts` | Entry point — boot order and the two loops |
| `index.ts` | Public API surface (`"yappr"`) that skills/hooks import — engine services + the X SDK + types |
| `cli/` | The `yappr` bin + commands: `init` (scaffold `config/` + `.env`), `start`, `deploy`, `status` (live dashboard), `ssh`, `help`. Plus the shared pieces: `cli/backup.ts` (DB snapshot/restore), `cli/charts.ts` (dashboard chart rendering — pure string-building), `cli/env.ts` (.env read/write for deploy), `cli/host-key.ts` (TOFU SSH host-key pinning → `.yappr-known-hosts`), `cli/ui.ts` (terminal styling) |
| `config-loader.ts` | Loads `config/` from the project CWD (purely the user's add-ons — none essential); imports skill/hook modules natively, or user `.ts` via jiti (no build step) |
| `config.ts` | Validated view of all env vars (the only place that reads `process.env`) |
| `bankr.ts` | Single client for the Bankr REST API (sign, x402-pay, wallet) |
| `wallet.ts` | Wallet init + `payFetch` (x402-billed fetch) + `submitTx` |
| `x402.ts` | x402 scheme wiring: a client-side x402 fetch whose EIP-3009 payment authorizations are signed via Bankr `/wallet/sign` — backs the agent's `payFetch` (`wallet.ts`) and the CLI |
| `compute.ts` | x402 Compute API client — used by the CLI (`deploy`/`status`/`ssh`) |
| `agent-prompt.ts` | Bankr natural-language agent jobs — used by the `wallet` skill |
| `llm/` | LLM gateway client + prompt assembly from `config/context/`. Costs each completion from its token usage × per-model `/v1/models` pricing → records inference spend. The system-prompt date is hour-granular so the prompt stays prompt-cacheable across calls |
| `reply/` | The reply loop: poller, pipeline, gating, agent reasoning loop |
| `treasury/` | The treasury loop, on-chain calls, and ABIs |
| `skills/` | Loader/registry/types for `config/skills/` |
| `hooks/` | Loader/registry/types for `config/hooks/` |
| `x/` | Full X/Twitter SDK over the x402 data endpoint (`client.ts`) + types |
| `db.ts` | The one shared SQLite connection (`better-sqlite3`) → app DB `yappr.db` at `DB_PATH` (persisted outside `/yappr` on the server). Each feature creates its own tables against it |
| `state.ts` | Durable agent state in the shared DB's `state` table: last mention processed |
| `stats.ts` | Stats ledger on the shared DB: spend/earn/activity `events` + `meta` gauges + `summary()` (also returns trailing-window spend/earn for the dashboard's runway estimate, and the `chart` series — `day`/`all` cumulative + `byType` hourly — for the CHART panel). Inference spend is costed per-request in `llm/index.ts`. `stats-cli.ts` is its CLI (`summary` \| `backup`), used by the status dashboard over SSH |
| `util.ts`, `log.ts` | `sleep`/`requireEnv`/`envNumber` (lenient numeric env, vs. `config.ts`'s strict `numeric`), and the pino logger |

## Conventions

- **`config/` is the extension surface; `src/` is the engine.** Skills, hooks, and
  prompts live in `config/` and are loaded at startup. Adding a capability normally
  means adding a `config/skills/<name>/` folder — not editing `src/`.
- **Skills/hooks import the engine as `"yappr"`** (the public API in `src/index.ts`),
  never via relative `../../../src/...` paths — so a skill is portable to a user's
  project (no `src/` there) and resolves to the single running engine instance. Node
  `exports` self-references it: the `development` condition → `src` (dev, hence
  `tsx --conditions=development`), `default` → `dist` (prod); `tsconfig` `paths`
  resolves it for typechecking.
- **All money/identity goes through Bankr** (`src/bankr.ts`). No keys on disk.
- **`src/x/client.ts` is a deliberately complete SDK.** Not every method is wired to
  a skill; they're building blocks for skill authors. Keep it that way.
- **`TREASURY_DRY_RUN=true`** makes every treasury/wallet write a logged no-op — use
  it to verify cycle logic without spending. `submitTx`/`treasury.*` honor it.
- **Skill access is enforced in code** (`reply/agent.ts`), never trusted to the LLM:
  `access: admin` skills only run for handles in `ADMIN_HANDLES`.
- Run `npm run typecheck` after changes.
