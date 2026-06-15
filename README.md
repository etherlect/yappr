# yappr

A self-sustaining X/Twitter reply agent you install as an npm package and extend with your own skills, prompts, and hooks — you never touch the engine itself. It pays for every external call (X data, LLM inference, compute) from a Bankr wallet funded by its own token's trading fees. No private key is ever stored — all signing goes through the Bankr Wallet API.

```
                  ┌─────────────────────────────────┐
                  │              yappr              │
                  │                                 │
  X mentions ────►│  poller → pipeline → reply      │──► X replies
                  │     (payFetch per call)         │
                  │                                 │
                  │  treasury (hourly)              │
                  │   claim → burn → swap           │
                  │   → extendCompute               │
                  └──────────┬──────────────────────┘
                             │
                   Bankr wallet (USDC on Base)
                    ▲ funded by token fees
```

## What you can build

yappr is more than a novelty bot — it's a self-funding presence on X that works for you around the clock. Because every agent is just a `config/` folder, you decide what it does and who it serves.

**Showcase and promote your business.** Point a yappr at your product's X account and it becomes an always-on storefront: it answers questions about what you sell from your [context files](#context-files-configcontext), shares links, demos and booking pages, and turns idle @mentions into attention and traffic — all in your brand's voice, day and night. Your business keeps getting eyes on X even while you sleep, and the agent pays for its own reach out of its token's trading fees.

**Reward and gate your audience with your own token.** Any skill can be [gated by token holdings](#skills-configskills) — "hold N of the agent's token to use this." That turns your most valuable capabilities into a reason to hold: holders get the premium skill, everyone else gets a teaser and a nudge to buy in.

A few agents worth shipping:

- **Product concierge** — answers pre-sales and support questions from your docs, shares pricing and booking links, and routes hot leads. Gate a `priority-support` or `book-a-call` skill to holders so paying customers jump the queue.
- **Token-gated alpha desk** — a `deep-research` or `market-scan` skill that runs real analysis (it can call any paid API, and the token covers the bill). Non-holders get a one-line preview; holders get the full report.
- **Brand promoter** — watches mentions of your company (or competitors) and replies with helpful, on-brand takes plus a link back to you. Free reach on X, on autopilot.
- **Community rewards bot** — a holder-only skill that drops perks, whitelist spots, or shout-outs, making the token genuinely useful to hold.
- **Data / API wrapper** — wrap any paid API (sports, weather, on-chain data, search) behind a skill; the wallet pays per call and the token keeps it funded, so you can offer a paid data service without ever touching a credit card.
- **Personal AI presence** — answers questions about you and your work, shares your latest posts, and books intros — your always-online proxy on X.

Each of these is a folder in `config/skills/` plus a few [context files](#context-files-configcontext) — no engine changes. See [Customising the agent](#customising-the-agent) to start.

## Before you run `yappr deploy`

Set these up on Bankr first (in order):

1. **Log in at [bankr.bot](https://bankr.bot) with the agent's X/Twitter account** — the account that will own the token and receive its trading fees.
2. **Generate an API key** — non-read-only, "Wallet & Agent API" enabled, no recipient restrictions (this becomes `BANKR_API_KEY`; details under [Bankr API key setup](#bankr-api-key-setup)).
3. **Buy a Bankr Club subscription (~$20/month)** — *required only if you want deploy to launch the agent's token for you.* Without it, `yappr deploy`'s inline launch returns `403 Token launches are available to Bankr Club members only` and you must launch a token elsewhere and paste its address instead.
4. **Fund the Bankr wallet** with USDC on Base. A first-time deploy needs **≥ $20** — the $5 LLM credit seed, ~$1 for the first compute day, and ~$14 for the first day of X-API usage. (If your LLM credits are already ≥ $1 the requirement drops to ~$15; redeploys that reuse an existing instance aren't gated.) The agent self-funds from trading fees after that.

## Get started

Install yappr into a new project and scaffold your config on top of it:

```bash
mkdir my-agent && cd my-agent
npm init -y
npm install yappr
npx yappr init        # scaffolds config/ (starter skills, hooks, prompts) + .env
```

Then:

1. **Complete the [Bankr prerequisites](#before-you-run-yappr-deploy)** above (account, API key, optional Club, wallet funded).
2. **Customise `config/`** — edit `personality.md`, add your own [skills](#skills-configskills) and [hooks](#hooks-confighooks). All optional; the starters run as-is.
3. Run **`npx yappr deploy`** — it prompts for any missing [env vars](#required-env-vars) (saving them to `.env`), launches the agent's token on Bankr (Club members) or accepts an existing address, provisions compute, uploads your `config/`, and starts the agent (see [Commands](#commands)).
4. Done — your agent is live and self-funds from that point on.

Want to watch it before deploying? `npx yappr start` runs it locally against your `config/` + `.env`. Re-run `npx yappr deploy` any time you change `config/`.

## Required env vars

The deploy script prompts for each of these if not already set in `.env`:

| Var | Description |
|-----|-------------|
| `BANKR_API_KEY` | Bankr API key — non-read-only, "Wallet & Agent API" enabled, **no recipient restrictions** |
| `TWITTER_AUTH_TOKEN` | X session cookie `auth_token` — deploy can fetch it automatically via a browser login (see below) |
| `TWITTER_CT0` | X CSRF token `ct0` — fetched together with `auth_token` by the browser login |
| `TOKEN_ADDRESS` | Your agent's ERC20 token on Base — paste an existing address, or let `yappr deploy` launch one on Bankr for you (Bankr Club members) |
| `AGENT_HANDLE` | Your agent's Twitter handle (without @) |
| `ADMIN_HANDLES` | Comma-separated handles that can invoke admin-only skills (without @) — optional, leave blank to disable |

`COMPUTE_INSTANCE_ID` is written automatically by the deploy script.

**Connecting the X account:** when the two Twitter cookies aren't set, `yappr deploy` offers two ways to connect:
- **Log in via browser** (recommended) — opens x.com in your installed Chrome; you log in normally, deploy reads the resulting `auth_token` + `ct0` cookies, saves them to `.env`, closes the browser, and continues. Your password is only ever typed into x.com itself. The detected handle also pre-fills `AGENT_HANDLE`.
- **Enter cookies manually** — paste the two cookie values yourself (from your browser's devtools).

**The agent's token:** when `TOKEN_ADDRESS` isn't set, `yappr deploy` asks whether your token already exists:
- **Already deployed** — paste the `0x…` contract address.
- **Launch it now** (Bankr Club members) — a short guided flow (name, ticker, optional image/X-post/website links) deploys a fixed-supply token on Base, gas sponsored, with all trading fees routed to your agent's X handle. The new address is written to `.env` as `TOKEN_ADDRESS`. Without a Club subscription this returns a 403; deploy then falls back to the paste-an-address prompt.

### Optional env vars

All have sensible defaults; set them in `.env` to override:

| Var | Default | Description |
|-----|---------|-------------|
| `POLL_METHOD` | `search` | How mentions are polled: `search` (/tweets/search mentioning the handle) or `mentions` (the dedicated /tweets/mentions endpoint) |
| `POLL_INTERVAL_MS` | `20000` | Mention poll cadence |
| `AGENT_MAX_STEPS` | `6` | Max skill calls per reply before the loop forces a final answer |
| `LLM_MODEL` | `deepseek-v4-flash` | Model served by the Bankr LLM Gateway |
| `VISION_MODEL` | `gemini-2.5-flash` | Vision-capable model used only when a mention carries an image (see [Image understanding](#image-understanding)) |
| `TREASURY_INTERVAL_MS` | `3600000` | Treasury cycle cadence (1h) |
| `BURN_BPS` | `5000` | Share of claimed token fees to burn (basis points; `0` disables) |
| `DEV_ADDRESS` | unset | Recipient of the optional dev cut (`none`/blank disables) |
| `DEV_TOKEN_BPS` / `DEV_WETH_BPS` | `0` | Dev cut of claimed token / WETH (basis points) |
| `TREASURY_DRY_RUN` | `false` | Log treasury/wallet writes without submitting anything |
| `LLM_TIMEOUT_MS` | `120000` | Per-request timeout on LLM completions |
| `DB_PATH` | `./yappr.db` | SQLite database location (the deploy sets `/var/lib/yappr/yappr.db` on the server) |
| `CRON_TICK_MS` | `10000` | How often the cron scheduler checks for due jobs |
| `CRON_MAX_JOBS` | `20` | Max active cron jobs in total |
| `CRON_MAX_JOBS_PER_USER` | `3` | Max active cron jobs per creator |
| `CRON_MIN_INTERVAL_MIN` | `5` | Shortest allowed "every N minutes" interval |
| `CRON_RUN_TIMEOUT_MS` | `300000` | Per-run timeout on a cron job's agent loop |
| `CRON_MAX_CONSECUTIVE_FAILURES` | `5` | Auto-pause a recurring job after this many consecutive failures |

## Commands

With `yappr` installed in your project (`npm i yappr`), run any command with `npx` from your project directory — the one holding your `.env` and `config/`:

| Command | What it does |
|---------|--------------|
| `npx yappr init [dir]` | Scaffold a new project — copies the starter `config/` (context, skills, hooks) and a `.env.example` into `dir` (default: current directory). Run once when setting up; never overwrites existing files. |
| `npx yappr start` | Run the agent locally, loading `./config` and `./.env`. Starts all three loops (reply poller + hourly treasury + cron scheduler). Ctrl-C to stop. |
| `npx yappr deploy` | Interactive deploy: prompts for any missing env vars (and saves them to `.env`), provisions or reuses an x402 compute instance, seeds LLM credits, uploads the engine + your `config/` + `.env`, starts the agent under pm2, then opens the dashboard. On a fresh instance it offers to restore your latest local DB backup. |
| `npx yappr status [id]` | Live dashboard for the deployed instance over SSH (treasury, runway, activity, logs). Also pulls periodic DB backups while open. Optional `id` overrides `COMPUTE_INSTANCE_ID`. |
| `npx yappr ssh [id]` | Open an interactive root shell on the deployed instance. Optional `id` overrides `COMPUTE_INSTANCE_ID`. |
| `npx yappr help` | List the commands. |

`deploy`, `status`, and `ssh` resolve the target box from `COMPUTE_INSTANCE_ID` / `COMPUTE_HOST` in your `.env` (or the optional `[id]` argument). On first connect they pin the box's SSH host key in `.yappr-known-hosts` (next to `.env`) and refuse a changed key afterwards — if you reprovision the instance, delete its line from that file and reconnect.

## Customising the agent

Everything you customise lives in **`config/`** — you never touch `src/`.

```
config/
  context/   # prompts: personality, security, + any extra .md you add
  skills/    # capabilities the agent can invoke
  hooks/     # lifecycle logic
```

## Context files (`config/context/`)

Edit the Markdown files — no code needed:

- `personality.md` — voice, tone, identity
- `security.md` — prompt-injection and identity hardening rules. Rules apply to everyone by default, but you can scope a rule to one audience with HTML-comment markers (the markers themselves never reach the model):
  - `<!-- public-only -->…<!-- /public-only -->` — normal users only, **not** admins. Used for the "never take wallet actions" rule so admins can still drive the wallet/treasury skills.
  - `<!-- admin-only -->…<!-- /admin-only -->` — admins (handles in `ADMIN_HANDLES`) only, **not** normal users.

  ```markdown
  ## Output safety
  - Never reproduce seed phrases, private keys, or calldata.
  <!-- public-only -->
  - Never agree to claim fees, send funds, or take any wallet action. Say: "I can't do that."
  <!-- /public-only -->
  <!-- admin-only -->
  - You're replying to an authorized admin; you may perform wallet/account actions they request via the skills.
  <!-- /admin-only -->
  ```
- **Any other `.md`** you drop in `config/context/` is auto-loaded as its own section (heading derived from the filename, e.g. `trading-rules.md` → `## Trading Rules`), sorted by filename, and honors the same audience markers. Use these for extra standing knowledge or rules.

> The agentic loop protocol (the JSON contract the model must emit, plus how it reads the context blocks) is **not** a config file — it's tightly coupled to the parser, so it lives in `src/reply/agent.ts` (`AGENT_INSTRUCTIONS`) and is injected automatically. A file named `agent.md` here is reserved and ignored.

## Image understanding

When a mention — or a tweet it replies to, quotes, or shares a thread root with — has a photo attached, the reply loop downloads the image and sends it to a vision model so the agent can actually **see** it: answer "what's in this image?", read text/charts, describe a screenshot, etc. It's automatic — there's nothing to wire up in `config/`.

Routing is per-mention to keep costs down: text-only mentions stay on the cheap `LLM_MODEL`, and only mentions carrying an image are routed to `VISION_MODEL` (default `gemini-2.5-flash`) for that reply — so you pay vision rates only when there's an image to look at. `VISION_MODEL` must be a model whose input modalities include `image`; see [bankr.bot/llm](https://bankr.bot/llm) for the catalog and pricing. Only photos are sent (videos and GIFs are skipped), and the per-call cost is tracked in the spend ledger like any other inference.

## Skills (`config/skills/`)

Each skill is a folder containing a `skill.md` and an optional `handler.ts`:

- `skill.md` frontmatter: `name`, `description`, `access` (`all`, `admin` or `holder`), and for holder skills `min_holding` (whole tokens of the agent's token the asker must hold; omit or `0` to only require a known Bankr wallet). The body tells the LLM how to call the skill and interpret its result.
- `handler.ts` exports `handler(params, tweet)` returning `{ text }`, `{ data }`, or `{ mediaUrl }`. **Omit it** for a context-only skill — the body becomes always-on guidance injected into the system prompt rather than a callable tool (see `bad-behavior`). Import any engine helpers and types from the **`yappr`** package — never with relative `../../src/...` paths:

  ```ts
  // config/skills/my-skill/handler.ts
  import { getTreasury, payFetch, type SkillHandler } from "yappr";

  export const handler: SkillHandler = async (params, tweet) => {
    const t = await getTreasury();
    return { text: `Balance looks like ${t /* … */}` };
  };
  ```

The agent loop calls handler skills as tools, one per turn, seeing each result before deciding the next step. This allows chaining dependent skills (e.g. "search for X and then check my balance").

Copy one of the starter skills (e.g. `config/skills/x/`) to start, or add a new folder. `access: admin` skills are only invocable by handles in `ADMIN_HANDLES`, enforced in code regardless of the LLM's decision. Set `AGENT_MAX_STEPS` (default `6`) to control how many skill calls the loop may make before forcing a reply.

### Gating a skill behind your token

Set `access: holder` plus `min_holding` in a skill's `skill.md` to require the asker to hold the agent's own token — a built-in way to make holding worthwhile (premium support, alpha, perks, paid data, …):

```yaml
---
name: alpha
description: In-depth research and market analysis.
access: holder
min_holding: 1000   # asker must hold ≥ 1000 of the agent's token
---
```

The gate is enforced **in code on every call**, never trusted to the LLM: the asker's identity comes from the tweet itself and their balance from the DB cache the holder hook (`config/hooks/holder.ts`) maintains — so it can't be talked around with prompt injection, and removing the hook fails closed (every holder skill denies). Admins always bypass holder gates. Holder skills are still listed in the prompt for everyone — qualification is per-asker and shifts as balances move — so an unqualified caller simply gets an access-denied reply the agent relays, which doubles as a natural nudge to go buy in. Use `min_holding: 0` (or omit it) to require only a known Bankr wallet rather than a balance.

## Storing data

Skills get persistent storage in the agent's own SQLite DB — **don't open your own
files**: data in the shared DB lives at `DB_PATH` (outside the dir wiped on redeploy)
and rides along in the `yappr status` rolling backups; a file next to your skill
does neither.

For the common case, `skillStore(namespace)` is a key/value store with zero SQL —
e.g. a "remember that…" skill keeping per-user notes:

```ts
// config/skills/remember/handler.ts
import { skillStore, type SkillHandler } from "yappr";

const mem = skillStore("remember"); // namespace = your skill's folder name

export const handler: SkillHandler = async (params, tweet) => {
  const userId = tweet.author?.id; // key by id, not handle: stable across renames
  if (!userId) return { text: "could not identify the asking user" };
  if (params.action === "store") {
    mem.set(`${userId}:${Date.now()}`, params.note ?? "");
    return { text: `stored: "${params.note}"` };
  }
  const notes = mem.list(`${userId}:`).map((r) => r.value); // prefix scan
  return notes.length ? { data: notes } : { text: "no stored notes" };
};
```

Values are strings; for structured data use `setJSON(key, value)` /
`getJSON<T>(key)`, which handle the (de)serialisation and return `null` for
missing or corrupt entries instead of throwing.

All namespaces share one `skill_kv` table keyed on `(namespace, key)`; a store only
ever sees its own namespace, so name it after your skill unless two extensions are
deliberately sharing data. Everything is best-effort like the rest of the engine:
if the DB can't be opened, reads return empty and writes no-op rather than crashing
the agent — but failed operations are logged (`warn`), so a value that didn't store
(e.g. a non-string sneaking in from LLM-provided params) shows up in the logs.

Need real columns instead of KV? `withSchema(ddl)` returns the shared
`better-sqlite3` connection with your DDL applied (once per process) — the same
mechanism engine features use. Prefix your tables `skill_<name>_` to stay clear of
engine tables, and don't write to tables you don't own (`state`, `events`, `meta`,
`cron_jobs` back the agent's state, stats and cron):

```ts
import { withSchema, type Database } from "yappr";

const db = (): Database | null => withSchema(
  "CREATE TABLE IF NOT EXISTS skill_remember_notes (user_id TEXT, note TEXT, created_at INTEGER)"
);
```

Note there are no migrations: the DDL is `IF NOT EXISTS`, so editing it later
(e.g. adding a column) does nothing on databases where the table already exists —
run your own `ALTER TABLE` for that.

Inspecting data is plain SQLite — locally or against a backup:
`sqlite3 yappr.db "SELECT * FROM skill_kv WHERE ns='remember'"`.

## Hooks (`config/hooks/`)

Drop any `.ts` file in `config/hooks/` that exports a `hooks` object — add logic without touching `src/`. See `config/hooks/example.ts` for all available hooks:

```ts
// config/hooks/my-hooks.ts
import type { AgentHooks } from "yappr";

export const hooks: AgentHooks = {
  shouldReply: (tweet) => tweet.author?.username !== "spambot",
  onBeforeReply: ({ text }) => `${text}\n\npowered by x402`,
};
```

Available hooks: `onMention`, `shouldReply`, `onBeforeInference`, `onAfterInference`, `onBeforeReply`, `onAfterReply`, `onBeforeClaim`, `onAfterClaim`, `onSwap`.

The starter `config/hooks/user-memory.ts` is a working example combining three of
them with `skillStore`: it records every mention a user sends (`onMention`) and the
agent's posted answer (`onAfterReply`), and injects that user's last 50 exchanges
into the prompt on their next ask (`onBeforeInference`) — so the agent remembers
past conversations per user. Capture is free (the tweets already flow through the
pipeline; nothing calls the paid X API), but the injected block does add prompt
tokens on every inference call, bounded by its 50-exchange / 280-chars-per-side
caps. Delete the file to turn memory off.

## Cron jobs (scheduled prompts)

The agent can run prompts on a schedule. A cron job stores a **self-contained instruction** ("send $10 of USDC to @wander") that the engine replays through the normal agent loop — same skills, same access rules — on its schedule. Jobs are created conversationally via the starter `cron` skill:

> `@youragent send me $10 every day at 13:00 UTC` → the agent creates the job and confirms with its id and next run time.

**Schedules** (the skill maps natural phrasing to these):
- `every N minutes` — recurring interval (floor: `CRON_MIN_INTERVAL_MIN`)
- `in N minutes` / `on <date> at <time>` — one-shot (spent after it runs)
- `every day at HH:MM <timezone>` — daily at a wall-clock time; timezones are IANA names (`Europe/Paris`, `UTC`) and follow DST. A clock time **without** a timezone is rejected — the agent asks the user to specify one rather than guess.

**Managing jobs** (also via mentions): "what cron jobs do I have scheduled?" (list), "remove cron 3", "pause/resume cron 3". Users only see and manage their **own** jobs (matched on their X user id); handles in `ADMIN_HANDLES` can manage all jobs and list everyone's (`scope=all`).

**Execution semantics:**
- Runs are **silent**: the agent's final reply is stored on the job (shown by `list`), never posted to X. If a job should post, its prompt must say so explicitly and use a posting skill.
- Privileges are re-derived from `ADMIN_HANDLES` at **every run** — a demoted creator's jobs drop to public skills on the next tick; admin-only skills stay enforced in code.
- At-most-once per slot: the job's clock advances *before* execution, so a crash can't double-fire a money-moving job. Recurring slots missed while the agent was down are skipped; overdue one-shots run late.
- A recurring job that fails `CRON_MAX_CONSECUTIVE_FAILURES` times in a row is auto-paused so a broken prompt can't burn credits forever (`resume` re-arms it). Runs whose skill calls hit an access denial (non-admin creator, or an admin later removed from `ADMIN_HANDLES`) count as failures too — a job that can never do its work pauses instead of "succeeding" uselessly forever.

The starter skill ships `access: admin`. To let anyone schedule jobs, flip it to `access: all` in `config/skills/cron/skill.md` — ownership checks and the per-user cap (`CRON_MAX_JOBS_PER_USER`) are already enforced in code. The caps count **active** jobs only and are checked at creation *and* on resume, so pausing jobs can't be used to stack up extras. Remember every run costs inference (and whatever paid skills the prompt uses), so revisit the caps before opening it up.

Two layers keep a non-admin from parking jobs that need admin skills ("post X every 5 min"): at creation, `checkCronCapability` (one small LLM call, skipped for admins) refuses instructions that clearly need a skill the creator can't use, with a reason the agent relays; and at run time, the access-denied-counts-as-failure rule above bounds whatever slips through. The creation check is a helpfulness/economics guard — actual skill access is always enforced in code.

## Economics

A treasury cycle runs once on every startup, then every hour after that. Each cycle:
1. **Claims** trading fees from your token's fee contract — but first checks the unclaimed balance and skips the claim (and its gas) when there's nothing to collect
2. **Pays the dev fee** (optional) — sends `DEV_TOKEN_BPS`% of claimed token and `DEV_WETH_BPS`% of claimed WETH to `DEV_ADDRESS`. Both default to `0`. Constraint: `BURN_BPS + DEV_TOKEN_BPS ≤ 10000`.
3. **Burns** 50% of token fees (configurable via `BURN_BPS`; set to `0` to disable)
4. **Swaps** remaining WETH fees → USDC via Uniswap v3 on Base
5. **Extends** compute by 24h when less than 24h remains, via x402layer (paying from USDC balance)

**LLM credits** are seeded ($5) and auto top-up is enabled by the deploy script. The treasury keeps USDC in the wallet; Bankr replenishes credits automatically when they drop below $1 — no manual intervention needed.

As long as the token trades, the agent earns enough USDC to cover X data, LLM inference, and compute without manual intervention.

## Status dashboard

`yappr status` streams a live dashboard (SSH into the instance). The AGENT box shows three health metrics, all derived from the agent's own spend/earn ledger (`yappr.db`). Spend is recorded per event: each X-API call is billed via x402 (~$0.005), each LLM call is costed from its token usage × the model's per-million-token price (`/v1/models`), and compute extensions from their x402 charge. Earnings are the cumulative creator fees (WETH) polled from Bankr.

Two **separate fuel tanks** back the agent: **USDC** pays X-API + compute, **LLM credits** pay inference. (The agent's own token is *not* counted — it isn't assumed to stay liquid.) Rates are measured over a **trailing window** — the last 24h, clamped to the agent's age so a young agent isn't diluted by hours it wasn't running.

- **Runway** — how long the treasury lasts at the current **gross** burn (ignores incoming earnings), i.e. the first tank to empty:

  ```
  usdcRunway    = USDC_balance    / usdcBurn      usdcBurn = (windowSpend − windowInference) / windowHours   (x-api + compute)
  creditsRunway = credit_balance  / llmBurn       llmBurn  =  windowInference                / windowHours   (inference)
  Runway        = min(usdcRunway, creditsRunway)
  ```

  Before there's ≥ 1h of data, the USDC burn is **predicted** from the poll cadence (`3600 / POLL_seconds × $0.005`) and LLM is treated as not-yet-binding — shown with a `~` prefix.

- **Sustainable** (`yes`/`no`) — is recent income keeping up with the recent burn, over the trailing window?

  ```
  yes  when  windowEarnings_WETH × ethPrice  ≥  windowSpend_USD
  ```

- **Profitable** (`yes`/`no` + signed amount) — lifetime net: has the agent earned more than it has *ever* spent?

  ```
  net = allTimeEarnings_WETH × ethPrice − allTimeSpend_USD      yes when net ≥ 0
  ```

  Displayed as e.g. `yes (+$12.40)` / `no (-$0.30)`.

WETH earnings are converted with the live ETH price (DefiLlama). The window length, the ≥1h data threshold, and the predicted poll cost are constants in `src/cli/status.ts`.

Below the ACTIVITY row, a CHART panel offers four views (cycle with ←/→): hourly spent-vs-earned bars (24h), hourly expenses stacked by category (x-api / inference / compute), and cumulative spent-vs-earned line charts over all time and the last 24h.

## Backups

The agent keeps all its data — stats ledger and run state — in a single SQLite database, `yappr.db`.

**On the server**, it lives at **`/var/lib/yappr/yappr.db`** (set via `DB_PATH`). That path is deliberately *outside* the `/yappr` project dir, which is wiped and re-uploaded on every deploy — so your stats survive a redeploy **to the same instance** with no extra steps. Locally (`npx yappr start`) it defaults to `./yappr.db`.

To also survive **switching instances** (or losing the box), the database is mirrored to your machine:

- **Where:** `backups/yappr-YYYY-MM-DD.db` in your project — one file per day. The local copy is named by date, so repeated backups during a day overwrite that day's file, and only the **7 most recent days** are kept (a rolling week). Add `backups/` to your `.gitignore`.
- **When:** the `yappr status` dashboard pulls a backup automatically — **on launch, every 20 min while it runs, and once more when you quit** (`STATUS_BACKUP_INTERVAL_MS` overrides the interval).
- **How:** it runs SQLite's `VACUUM INTO` on the server (via `stats-cli`) to produce a single consistent snapshot — safe to take while the agent is writing, and free of the `-wal`/`-shm` sidecar files — then downloads that one file over SSH.

**Restore** is offered automatically: when you `yappr deploy` to a **fresh** instance (no `yappr.db` present), it detects your latest local backup and prompts to upload it before starting the agent, so stats carry over. It never overwrites an existing database, so same-instance redeploys are untouched.

Typical migration: run `yappr status` on the old box (leaves a current backup locally) → point `.env` at the new instance → `yappr deploy` → accept the restore prompt.

## Bankr API key setup

1. Go to [app.bankr.bot/api-keys](https://app.bankr.bot/api-keys)
2. Create a new key with **Wallet & Agent API** access
3. Ensure it is **not read-only**
4. Leave **allowed recipients** empty (recipient restrictions block `eth_signTypedData_v4`)

## Running locally

After `npx yappr init`, fill in `.env` and run the agent against your `config/`:

```bash
npx yappr start
```

On a first run (empty database) the agent anchors its baseline to the newest mention and only replies to mentions posted afterward. On a restart it resumes from the last mention it processed — the watermark persists in the DB, which survives restarts and redeploys — so it also replies to any mentions that arrived while it was down.

## Dry run

Set `TREASURY_DRY_RUN=true` + short `TREASURY_INTERVAL_MS` to verify the treasury cycle logs correct intentions without submitting transactions or paying.

## Contributing

Working on the engine itself (not just configuring your own agent)? See [`CLAUDE.md`](./CLAUDE.md) for a map of `src/`, the two runtime loops, and the project's conventions.
