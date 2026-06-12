// Live status dashboard for the deployed yappr instance (the `yappr status` command).
//
//   yappr status                # uses COMPUTE_INSTANCE_ID / cached COMPUTE_HOST
//   yappr status <instanceId>   # override the instance id
//
// Connects over SSH (no manual login) and renders a multi-panel terminal
// dashboard: agent config, server specs + pm2 health, activity counters from the
// stats DB, and a live `pm2 logs` feed. Also auto-launched at the end of deploy.
// Ctrl+C to exit.

import "dotenv/config";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { NodeSSH } from "node-ssh";
import stringWidth from "string-width";
import cliTruncate from "cli-truncate";
import { createPublicClient, http, formatUnits } from "viem";
import { base } from "viem/chains";
import {
  resolveEvmAddress,
  fetchComputeInstance,
  fetchOneTimePassword,
  computeInstanceIp,
  computeInstancePassword,
  remainingComputeHours,
} from "../compute.js";
import {
  dim, bold, green, yellow, red, cyan, accent, border, YAPPR_LOGO,
  fit, kv, panel, sideBySide, padRows, centerRows, themeLine, toggleTheme, setTheme, detectTerminalTheme,
} from "./ui.js";
import { backupRemoteDb, backupLabel } from "./backup.js";
import { hostKeyConfig } from "./host-key.js";
import {
  type ChartSeries, SPENT_RGB, EARN_RGB, CAT_RGB, catColor, HOUR_MS,
  renderLineChart, renderHourlyBars, renderHourlySpentEarned,
} from "./charts.js";
import { envNumber } from "../util.js";

const TREASURY_INTERVAL_MS = envNumber("TREASURY_INTERVAL_MS", 3_600_000);
// How often the dashboard pulls a DB snapshot into instance/backups/ (default 20 min).
const BACKUP_INTERVAL_MS = envNumber("STATUS_BACKUP_INTERVAL_MS", 1_200_000);

// Runway model. Below this many hours of recorded activity the measured burn rate is
// too noisy to trust, so we fall back to a predicted floor from the poll cadence.
const RUNWAY_MIN_DATA_HOURS = 1;
// Predicted cold-start burn: the always-on cost is the mentions poll (~$0.005 per x402
// call) at the configured cadence. Event-driven costs (LLM, replies, compute) only join
// once the measured window takes over.
const X_API_POLL_COST_USD = 0.005;
const POLL_METHOD = (process.env.POLL_METHOD || "search").toLowerCase();
const POLL_SECONDS = Math.round(envNumber("POLL_INTERVAL_MS", 20_000) / 1000);
// Treasury balances + remaining compute refresh on this cadence (default 5 min).
const BALANCE_INTERVAL_MS = envNumber("STATUS_BALANCE_INTERVAL_MS", 300_000);

// Bankr LLM Gateway (inference credits). Read only to display the live balance (the
// remaining inference budget); the agent owns inference *spend* tracking, costed
// per-request from token usage × per-model pricing, in the ledger.
const LLM_URL = process.env.BANKR_LLM_URL || "https://llm.bankr.bot";
const LLM_KEY = process.env.BANKR_LLM_KEY || process.env.BANKR_API_KEY;

// How the dashboard reads the agent's stats. The agent (always-on) records every
// counted event into a SQLite DB; the dashboard only reads, via the compiled CLI
// (`stats-cli summary`), which prints rolled-up totals as JSON. No log scraping.
// `cd /yappr` so stats-cli's `dotenv/config` picks up /yappr/.env (DB_PATH →
// /var/lib/yappr/yappr.db), opening the same DB the agent writes to. The engine is
// installed under node_modules/yappr, so the compiled CLI lives there.
const STATS_QUERY_CMD = process.env.STATUS_STATS_CMD || "cd /yappr && node node_modules/yappr/dist/src/stats-cli.js summary";
// Same CLI, `cron` subcommand — the cron_jobs rows as JSON for the CRON JOBS page.
const CRON_QUERY_CMD = process.env.STATUS_CRON_CMD || "cd /yappr && node node_modules/yappr/dist/src/stats-cli.js cron";

// ─── on-chain balances (Base) ──────────────────────────────────────────────────

const WETH_ADDR = "0x4200000000000000000000000000000000000006" as `0x${string}`;
// Where the treasury cycle burns the agent's token (same constant as treasury/index.ts).
const BURN_ADDR = "0x000000000000000000000000000000000000dead" as `0x${string}`;
// Every Bankr token launch is a fixed-supply Clanker deploy: 100B tokens, always —
// so the burned % of supply is computed against this constant rather than fetched.
const TOKEN_TOTAL_SUPPLY = 100_000_000_000;
const USDC_ADDR = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as `0x${string}`;
const ERC20_VIEW_ABI = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "o", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "symbol", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;

const baseClient = createPublicClient({ chain: base, transport: http() });

type Balances = { token: bigint; weth: bigint; eth: bigint; usdc: bigint; burned: bigint; symbol: string; decimals: number; usdTotal: number | null; ethUsd: number | null; usd: { token: number; weth: number; eth: number; usdc: number } | null };

// Spot USD prices for the treasury assets, via DefiLlama's free coins API. Returns
// null prices on failure so the total degrades to "unavailable" rather than wrong.
async function fetchPrices(tokenAddress: `0x${string}`): Promise<{ eth: number; usdc: number; token: number } | null> {
  try {
    const keys = [`base:${WETH_ADDR}`, `base:${USDC_ADDR}`, `base:${tokenAddress}`];
    const res = await fetch(`https://coins.llama.fi/prices/current/${keys.join(",")}`);
    if (!res.ok) return null;
    const coins = ((await res.json()) as any)?.coins ?? {};
    const price = (k: string) => Number(coins[k.toLowerCase()]?.price ?? coins[k]?.price ?? 0);
    return { eth: price(`base:${WETH_ADDR}`), usdc: price(`base:${USDC_ADDR}`) || 1, token: price(`base:${tokenAddress}`) };
  } catch {
    return null;
  }
}

async function fetchBalances(address: `0x${string}`, tokenAddress: `0x${string}`): Promise<Balances | null> {
  try {
    // All contract reads ride ONE Multicall3 eth_call: the public Base RPC
    // rate-limits concurrent requests per IP (HTTP 429 at just a handful), so
    // firing them individually made the whole fetch fail more often than not
    // and left the TREASURY panel stuck on "...". RPC requests here: 2 total.
    const [mc, eth, prices] = await Promise.all([
      baseClient.multicall({
        contracts: [
          { address: tokenAddress, abi: ERC20_VIEW_ABI, functionName: "balanceOf", args: [address] },
          { address: WETH_ADDR, abi: ERC20_VIEW_ABI, functionName: "balanceOf", args: [address] },
          { address: USDC_ADDR, abi: ERC20_VIEW_ABI, functionName: "balanceOf", args: [address] },
          { address: tokenAddress, abi: ERC20_VIEW_ABI, functionName: "balanceOf", args: [BURN_ADDR] },
          { address: tokenAddress, abi: ERC20_VIEW_ABI, functionName: "symbol" },
          { address: tokenAddress, abi: ERC20_VIEW_ABI, functionName: "decimals" },
        ] as const,
        allowFailure: true,
      }),
      baseClient.getBalance({ address }),
      fetchPrices(tokenAddress),
    ]);
    const big = (i: number): bigint | null => (mc[i].status === "success" ? (mc[i].result as bigint) : null);
    const [token, weth, usdc, burned] = [big(0), big(1), big(2), big(3)];
    // Balances must be right or absent — a failed read keeps the "..." placeholder.
    if (token === null || weth === null || usdc === null || burned === null) return null;
    const symbol = mc[4].status === "success" ? (mc[4].result as string) : "TOKEN";
    const dec = mc[5].status === "success" ? Number(mc[5].result) : 18;
    let usdTotal: number | null = null;
    let usd: Balances["usd"] = null;
    if (prices) {
      usd = {
        token: Number(formatUnits(token, dec)) * prices.token,
        weth: Number(formatUnits(weth, 18)) * prices.eth,
        eth: Number(formatUnits(eth, 18)) * prices.eth,
        usdc: Number(formatUnits(usdc, 6)) * prices.usdc,
      };
      usdTotal = usd.token + usd.weth + usd.eth + usd.usdc;
    }
    return { token, weth, eth, usdc, burned, symbol, decimals: dec, usdTotal, ethUsd: prices?.eth ?? null, usd };
  } catch {
    return null;
  }
}

// ─── inference credits (Bankr LLM Gateway) ─────────────────────────────────────

// Current LLM credit balance in USD, or null if unavailable. 402 means "no credits"
// → 0. This is the inference budget the agent draws down on every LLM request.
async function fetchLlmCredits(): Promise<number | null> {
  if (!LLM_KEY) return null;
  try {
    const res = await fetch(`${LLM_URL}/v1/credits`, {
      headers: { "X-API-Key": LLM_KEY, "User-Agent": "yappr-status/0.1" },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 402) return 0;
    if (!res.ok) return null;
    const body = (await res.json()) as { balanceUsd?: number };
    return Number(body.balanceUsd ?? 0);
  } catch {
    return null;
  }
}

// All-time activity + spend, queried from the agent's SQLite stats DB via the CLI
// (the agent is the always-on writer, so this counts everything — including events
// that happened while the dashboard was closed). Spend already includes x-api,
// compute and inference; earnings come back as WETH — no client-side aggregation.
async function fetchAgentStats(ssh: NodeSSH): Promise<Stats | null> {
  const res = await ssh.execCommand(STATS_QUERY_CMD, { cwd: "/" }).catch(() => null);
  if (!res?.stdout) return null;
  try {
    const s = JSON.parse(res.stdout) as any;
    const numArr = (a: unknown): number[] => (Array.isArray(a) ? a.map(Number) : []);
    const cs = (c: any): ChartSeries => ({ spendUsd: numArr(c?.spendUsd), earnedWeth: numArr(c?.earnedWeth), startMs: Number(c?.startMs) || 0, endMs: Number(c?.endMs) || 0 });
    return {
      mentions: Number(s.mentions) || 0,
      replies: Number(s.replies) || 0,
      llmTurns: Number(s.llm) || 0,
      spentUsd: Number(s.spentUsd) || 0,
      warns: Number(s.warns) || 0,
      errors: Number(s.errors) || 0,
      earnedWeth: Number(s.earnedWeth) || 0,
      devWeth: Number(s.devWeth) || 0,
      spentUsdWindow: Number(s.spentUsdWindow) || 0,
      inferenceUsdWindow: Number(s.inferenceUsdWindow) || 0,
      earnedWethWindow: Number(s.earnedWethWindow) || 0,
      rateWindowHours: Number(s.rateWindowHours) || 0,
      spentByType: {
        "x-api": Number(s.spentByType?.["x-api"]) || 0,
        inference: Number(s.spentByType?.inference) || 0,
        compute: Number(s.spentByType?.compute) || 0,
      },
      chart: {
        day: cs(s.chart?.day),
        byType: {
          startMs: Number(s.chart?.byType?.startMs) || 0,
          xapi: numArr(s.chart?.byType?.xapi),
          inference: numArr(s.chart?.byType?.inference),
          compute: numArr(s.chart?.byType?.compute),
          earned: numArr(s.chart?.byType?.earned),
        },
      },
    };
  } catch {
    return null;
  }
}

// Cron jobs for the CRON JOBS page, read via `stats-cli cron` (same DB, same
// pattern as fetchAgentStats). Returns null when the query fails or the deployed
// engine predates the subcommand — the page shows a placeholder in that case.
async function fetchCronJobs(ssh: NodeSSH): Promise<CronJobInfo[] | null> {
  const res = await ssh.execCommand(CRON_QUERY_CMD, { cwd: "/" }).catch(() => null);
  if (!res?.stdout) return null;
  try {
    const arr = JSON.parse(res.stdout) as any[];
    if (!Array.isArray(arr)) return null;
    return arr.map((j) => ({
      id: Number(j.id) || 0,
      prompt: String(j.prompt ?? ""),
      schedule: String(j.schedule ?? ""),
      creator: String(j.creator ?? ""),
      enabled: !!j.enabled,
      nextRunAt: Number(j.nextRunAt) || 0,
      lastRunAt: j.lastRunAt != null ? Number(j.lastRunAt) : null,
      lastResult: j.lastResult != null ? String(j.lastResult) : null,
      lastError: j.lastError != null ? String(j.lastError) : null,
      runs: Number(j.runs) || 0,
      consecutiveFailures: Number(j.consecutiveFailures) || 0,
    }));
  } catch {
    return null;
  }
}

// ─── parsing ──────────────────────────────────────────────────────────────────

type Stats = { mentions: number; replies: number; llmTurns: number; spentUsd: number; warns: number; errors: number; earnedWeth: number; devWeth: number; spentUsdWindow: number; inferenceUsdWindow: number; earnedWethWindow: number; rateWindowHours: number; spentByType: { "x-api": number; inference: number; compute: number }; chart: { day: ChartSeries; byType: { startMs: number; xapi: number[]; inference: number[]; compute: number[]; earned: number[] } } };
type Pm2 = { status: string; bootMs: number; restarts: number; mem: number; cpu: number };
// One cron_jobs row as shipped by `stats-cli cron` (schedule pre-rendered to prose).
type CronJobInfo = {
  id: number; prompt: string; schedule: string; creator: string; enabled: boolean;
  nextRunAt: number; lastRunAt: number | null; lastResult: string | null;
  lastError: string | null; runs: number; consecutiveFailures: number;
};
type Specs = { cpu: string; ram: string; disk: string; os: string };

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

// Reject if a promise hasn't settled within `ms` — used to bound the on-quit backup
// so a hung SSH/snapshot can't block the dashboard from exiting.
const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timed out")), ms))]);

// Display a log line with pm2/pino-style coloring. pino-pretty (colorize:true)
// already writes ANSI colors into the pm2 log files; we strip those and recolor
// every `[time] LEVEL: msg {json}` line ourselves (dim timestamp, severity-colored
// level, plain message, dim JSON tail) so the feed follows the dashboard palette
// instead of pino's 16-color codes (which terminal themes remap arbitrarily).
function displayLog(raw: string): string {
  const line = stripAnsi(raw);
  const m = line.match(/^(\[[^\]]*\])\s+(\w+):\s*(.*)$/s);
  if (!m) return dim(line);
  const [, ts, level, rest] = m;
  const u = level.toUpperCase();
  const lvl = u === "ERROR" || u === "FATAL" ? red : u === "WARN" ? yellow : u === "INFO" ? green : u === "DEBUG" || u === "TRACE" ? cyan : dim;
  const om = rest.match(/^(.*?)\s(\{.*\}|\[.*\])\s*$/s);
  const msg = om ? om[1] : rest;
  const obj = om ? om[2] : "";
  return `${dim(ts)} ${bold(lvl(u))}${dim(":")} ${msg}${obj ? " " + dim(obj) : ""}`;
}

// ─── formatting ─────────────────────────────────────────────────────────────

function fmtDuration(ms: number): string {
  if (!ms || ms < 0) return "—";
  const sec = Math.floor(ms / 1000);
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec % 60}s`;
  return `${sec}s`;
}

const fmtMem = (bytes: number) => (bytes ? `${(bytes / 1024 / 1024).toFixed(0)}MB` : "-");

// Compact token amount (thousands/millions) from a wei bigint.
function fmtToken(v: bigint, decimals: number): string {
  const n = Number(formatUnits(v, decimals));
  if (n === 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  if (n >= 1) return n.toFixed(2);
  return n.toPrecision(2);
}

// ETH/WETH with 4 decimals; tiny non-zero balances clamp to "<0.0001".
function fmtEth(v: bigint): string {
  const n = Number(formatUnits(v, 18));
  if (n === 0) return "0";
  if (n < 0.0001) return "<0.0001";
  return n.toFixed(4);
}

// Percentage of the fixed 100B supply, with enough precision to show early burns
// (e.g. "0.0025%") without padding mature ones (e.g. "12.4%").
function fmtSupplyPct(tokens: number): string {
  const p = (tokens / TOKEN_TOTAL_SUPPLY) * 100;
  if (p === 0) return "0%";
  if (p >= 1) return `${p.toFixed(1)}%`;
  return `${p.toPrecision(2)}%`;
}

const fmtUsdc = (v: bigint) => `$${Number(formatUnits(v, 6)).toFixed(2)}`;
const fmtUsd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
// Spend is often sub-cent (calls cost ~$0.0025–$0.01), so show 4 dp until it tops $1.
const fmtSpent = (n: number) => `$${n.toFixed(n >= 1 ? 2 : 4)}`;

// Space-between justification of segments to exactly `width` columns.
function justify(segments: string[], width: number): string {
  if (segments.length === 1) return fit(segments[0], width);
  const content = segments.reduce((n, s) => n + stringWidth(s), 0);
  const gaps = segments.length - 1;
  const space = width - content;
  if (space <= gaps) return fit(segments.join(" "), width);
  const base = Math.floor(space / gaps);
  let rem = space - base * gaps;
  let line = segments[0];
  for (let i = 1; i < segments.length; i++) {
    line += " ".repeat(base + (rem-- > 0 ? 1 : 0)) + segments[i];
  }
  return line;
}

// ─── remote queries ───────────────────────────────────────────────────────────

async function fetchPm2(ssh: NodeSSH): Promise<Pm2 | null> {
  const res = await ssh.execCommand("pm2 jlist", { cwd: "/" });
  if (!res.stdout) return null;
  let list: any[];
  try { list = JSON.parse(res.stdout); } catch { return null; }
  const proc = Array.isArray(list) ? list.find((x) => x?.name === "yappr") : null;
  if (!proc) return null;
  const env = proc.pm2_env ?? {};
  return {
    status: env.status ?? "unknown",
    bootMs: env.status === "online" && env.pm_uptime ? env.pm_uptime : 0,
    restarts: env.restart_time ?? 0,
    mem: proc.monit?.memory ?? 0,
    cpu: proc.monit?.cpu ?? 0,
  };
}

async function fetchSpecs(ssh: NodeSSH): Promise<Specs> {
  const run = async (cmd: string) => (await ssh.execCommand(cmd, { cwd: "/" })).stdout.trim();
  const [cpu, ram, disk, os] = await Promise.all([
    run("nproc"),
    run("free -h | awk 'NR==2{print $2}'"),
    run("df -h / | awk 'NR==2{print $2}'"),
    run(". /etc/os-release 2>/dev/null; echo $PRETTY_NAME"),
  ]).catch(() => ["", "", "", ""]);
  return { cpu: cpu || "?", ram: ram || "?", disk: disk || "?", os: os || "Linux" };
}

// Whole-system usage (all processes), refreshed on the pm2 tick: RAM used in MB
// (`free -m`, the "used" column), CPU busy % over a 1s sample (`vmstat 1 2`,
// 100 − idle), and disk used on / (`df -h`, the "Used" column). Distinct from
// pm2's per-process figures.
async function fetchSysUsage(ssh: NodeSSH): Promise<{ cpu: number | null; memMb: number | null; diskUsed: string | null }> {
  const cmd = `echo "MEM:$(free -m | awk 'NR==2{print $3}')"; echo "CPU:$(vmstat 1 2 | tail -1 | awk '{print 100-$15}')"; echo "DISK:$(df -h / | awk 'NR==2{print $3}')"`;
  const res = await ssh.execCommand(cmd, { cwd: "/" }).catch(() => null);
  const out = res?.stdout ?? "";
  const mem = out.match(/MEM:(\d+)/);
  const cpu = out.match(/CPU:(\d+(?:\.\d+)?)/);
  const disk = out.match(/DISK:(\S+)/);
  return {
    memMb: mem ? Number(mem[1]) : null,
    cpu: cpu ? Math.round(Number(cpu[1])) : null,
    diskUsed: disk ? disk[1] : null,
  };
}

// ─── dashboard state + render ──────────────────────────────────────────────────

type State = {
  ip: string; handle: string; admins: string; wallet: string | null;
  stats: Stats; logs: string[]; pm2: Pm2 | null; specs: Specs | null;
  balances: Balances | null; computeHours: number | null;
  // Current LLM credit balance (USD) — the inference budget, shown in TREASURY.
  creditUsd: number | null;
  // Whole-system usage (all processes), shown beside the pm2 per-process figures.
  sysCpu: number | null; sysMemMb: number | null; sysDiskUsed: string | null;
  // LOGS scroll: lines scrolled up from the live tail (0 = following). logRows is
  // the visible log height from the last render, used to clamp/page the scroll.
  scroll: number; logRows: number;
  // Pending command awaiting a y/n confirmation in the footer (null = none).
  confirm: { prompt: string; action: () => void } | null;
  // Which chart panel is shown (←/→): 0 = spent/earned 24h, 1 = hourly spent vs
  // earned, 2 = hourly expenses by category.
  chartIndex: number;
  // Which page is shown (shift+←/→ cycles): 0 = status, 1 = cron jobs.
  view: number;
  // Cron jobs for the CRON JOBS page (null until the first successful fetch).
  cron: CronJobInfo[] | null;
  // Zero-based page within the cron list (←/→ while on the cron view).
  cronPage: number;
};

// Footer line: a pending y/n confirmation when armed, otherwise the key hints.
function footerLine(state: State, hints: string[], cols: number): string {
  const footer = state.confirm
    ? `${yellow(state.confirm.prompt)}  ${accent("y")}${dim("/")}${accent("Enter")} ${dim("to confirm, any other key cancels")}`
    : hints.join(dim("  ")) + `   ${dim("· safe to quit — reopen with")} ${accent("npx yappr status")}`;
  return fit(footer, cols);
}

const key = (k: string, label: string) => `${accent(k)} ${dim(label)}`;

// ─── cron jobs page ────────────────────────────────────────────────────────────

// Each job renders as its own panel: 3 content lines + 2 border lines, so
// pagination is simple: as many whole boxes as fit the terminal, ←/→ to page.
const CRON_LINES_PER_JOB = 5;

function buildCronFrame(state: State, cols: number, rows: number): string[] {
  const out: string[] = [""];
  const now = Date.now();
  const jobs = state.cron;
  const PAD = 8; // label column of the box body lines

  // Box rows available: total − top margin (1) − header (1) − footer (1).
  const bodyRows = Math.max(CRON_LINES_PER_JOB, rows - 3);
  const pageSize = Math.max(1, Math.floor(bodyRows / CRON_LINES_PER_JOB));
  const pages = Math.max(1, Math.ceil((jobs?.length ?? 0) / pageSize));
  state.cronPage = Math.min(Math.max(0, state.cronPage), pages - 1);

  // Header line: counts + pagination.
  const active = jobs?.filter((j) => j.enabled).length ?? 0;
  const paused = (jobs?.length ?? 0) - active;
  const counts = jobs ? `  ${dim("·")} ${green(String(active))} ${dim("active ·")} ${yellow(String(paused))} ${dim("paused ·")}` : "";
  out.push(fit(` ${bold("CRON JOBS")}${counts}  ${dim(`page ${state.cronPage + 1}/${pages} ←/→`)}`, cols));

  const lines: string[] = [];
  if (!jobs) {
    lines.push(...panel("CRON JOBS", [dim("loading cron jobs… (redeploy if the agent predates this feature)")], cols));
  } else if (jobs.length === 0) {
    lines.push(...panel("CRON JOBS", [dim("no cron jobs yet — ask the agent on X to schedule one")], cols));
  } else {
    const slice = jobs.slice(state.cronPage * pageSize, (state.cronPage + 1) * pageSize);
    const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
    for (const j of slice) {
      const status = j.enabled
        ? green("active")
        : j.consecutiveFailures > 0 ? red("auto-paused") : yellow("paused");
      const fails = j.consecutiveFailures > 0 ? `  ${red(`${j.consecutiveFailures} consecutive fails`)}` : "";
      const next = !j.enabled
        ? dim("—")
        : j.nextRunAt <= now ? cyan("due now") : cyan(`in ${fmtDuration(j.nextRunAt - now)}`);
      const last = j.lastRunAt != null ? `${fmtDuration(now - j.lastRunAt)} ${dim("ago")}` : dim("never");
      const outcome = j.lastError != null
        ? `${red("error")}   ${red(oneLine(j.lastError))}`
        : j.lastResult
          ? `${dim("result".padEnd(PAD))}${oneLine(j.lastResult)}`
          : `${dim("result".padEnd(PAD))}${dim("—")}`;
      const title = `${accent(`#${j.id}`)} ${accent("@" + j.creator)} ${dim("·")} ${cyan(j.schedule)} ${dim("·")} ${status} ${dim("·")} ${dim("runs")} ${j.runs}${fails}`;
      lines.push(...panel(title, [
        `${dim("prompt".padEnd(PAD))}${oneLine(j.prompt)}`,
        `${dim("next".padEnd(PAD))}${next}   ${dim("last run")} ${last}`,
        outcome,
      ], cols));
    }
  }

  out.push(...padRows(lines, bodyRows).map((l) => fit(l, cols)));

  out.push(footerLine(state, [
    key("←/→", "page"), key("shift+←/→", "status"), key("t", "theme"),
    key("r", "restart"), key("s", "stop"), key("S", "start"), key("d", "redeploy"),
    key("q", "quit"),
  ], cols));
  return out;
}

function buildFrame(state: State, cols: number, rows: number): string[] {
  // Page 2: the cron jobs dashboard (shift+←/→ cycles between the two pages).
  if (((state.view % 2) + 2) % 2 === 1) return buildCronFrame(state, cols, rows);

  // Four columns: LOGO (fixed) | AGENT | TREASURY | SERVER, with three 1-col gaps.
  const logoW = 21;                       // 17-wide logo art + borders/padding
  const usable = cols - 3 - logoW;
  const leftW = Math.floor(usable / 3);
  const midW = Math.floor(usable / 3);
  const rightW = usable - leftW - midW;
  const out: string[] = [];

  // One blank line of top margin (no header).
  out.push("");

  // AGENT panel
  const p = state.pm2;
  const elapsed = p?.bootMs ? Date.now() - p.bootMs : 0;
  // Approximate: phase-aligned to the pm2 process start, but the agent's recurring
  // treasury timer actually starts a few seconds into boot (and an extra startup
  // cycle fires ~10s in) — hence the "~" where this renders.
  const nextTreasury = p?.bootMs ? TREASURY_INTERVAL_MS - (elapsed % TREASURY_INTERVAL_MS) : 0;
  const wallet = state.wallet ? `${state.wallet.slice(0, 6)}..${state.wallet.slice(-4)}` : (process.env.BANKR_API_KEY ? dim("resolving") : dim("-"));

  // Two separate fuel tanks: USDC pays x-api + compute, LLM credits pay inference. (We
  // exclude the agent's own token; we don't assume it stays liquid.) Burn rates: once
  // there's ≥ RUNWAY_MIN_DATA_HOURS of recorded activity, measure each from the trailing
  // window (which grows up to 24h); before that, predict the USDC burn from the poll
  // cadence (the always-on x-api cost) and treat LLM as not-yet-binding — tagged "~".
  const st = state.stats;
  const bb = state.balances;
  const usdcUsd = bb ? (bb.usd?.usdc ?? Number(formatUnits(bb.usdc, 6))) : null;
  const hasRate = st.rateWindowHours >= RUNWAY_MIN_DATA_HOURS && st.spentUsdWindow > 0;
  const estimated = !hasRate;
  // Predicted always-on USDC burn from the poll cadence (the dominant cost). Doubles as
  // the cold-start estimate AND a floor on the measured rate: the window's spend is
  // divided by wall-clock hours, so if the agent was DOWN for part of the window its
  // spend is spread over fewer active hours than counted — understating the burn and
  // inflating the runway. Flooring at the poll cost keeps it realistic. When running
  // normally the measured rate already meets/exceeds this, so the floor is a no-op.
  const predictedUsdcBurn = POLL_SECONDS > 0 ? (3600 / POLL_SECONDS) * X_API_POLL_COST_USD : 0;
  const usdcBurn = hasRate                                                   // x-api + compute (USDC)
    ? Math.max((st.spentUsdWindow - st.inferenceUsdWindow) / st.rateWindowHours, predictedUsdcBurn)
    : predictedUsdcBurn;
  const llmBurn = hasRate ? st.inferenceUsdWindow / st.rateWindowHours : 0;  // inference (credits)

  // Runway: how long the treasury lasts at the current GROSS burn (ignores incoming
  // earnings) — the first of the two tanks to empty. Always a time, never "sustaining".
  let runway: string;
  if (usdcUsd == null) {
    runway = dim("…");
  } else {
    const usdcRunwayH = usdcBurn > 0 ? usdcUsd / usdcBurn : Infinity;
    const llmRunwayH = llmBurn > 0 ? (state.creditUsd != null ? state.creditUsd / llmBurn : Infinity) : Infinity;
    const hours = Math.min(usdcRunwayH, llmRunwayH);
    runway = Number.isFinite(hours)
      ? cyan((estimated ? "~" : "") + fmtDuration(hours * 3_600_000))
      : dim("∞");
  }

  // Sustainable (current-rate self-sustaining): do earnings keep up with the burn over the
  // trailing window (same window as Runway)? Both sides are window sums, so this is just
  // earnings_window(USD) ≥ spend_window. "…" only when we can't compare yet (no spend
  // recorded, or no live price to convert earnings).
  let sustainable: string;
  if (st.spentUsdWindow <= 0 || (st.earnedWethWindow > 0 && bb?.ethUsd == null)) {
    sustainable = dim("…"); // nothing spent yet, or earnings exist but no price to convert
  } else {
    sustainable = st.earnedWethWindow * (bb?.ethUsd ?? 0) >= st.spentUsdWindow ? green("yes") : yellow("no");
  }

  // Profitable (all-time net): cumulative earnings (WETH → USD at the live price) vs every
  // dollar ever spent — a lifetime break-even flag (distinct from Sustainable: the agent
  // can be profitable over its life yet currently burning, or vice-versa). "…" until
  // there's spend to compare and a price to convert with.
  let profitable: string;
  if (st.spentUsd <= 0 || (st.earnedWeth > 0 && bb?.ethUsd == null)) {
    profitable = dim("…"); // nothing spent yet, or earnings exist but no price to convert
  } else {
    const net = st.earnedWeth * (bb?.ethUsd ?? 0) - st.spentUsd; // all-time earnings − spend
    const amt = `(${net >= 0 ? "+" : "-"}${fmtSpent(Math.abs(net))})`;
    profitable = `${net >= 0 ? green("yes") : yellow("no")} ${net >= 0 ? green(amt) : red(amt)}`;
  }

  // Dev revenue (WETH paid to the dev address, all-time) — only shown once there's any.
  const devUsd = bb?.ethUsd != null ? st.devWeth * bb.ethUsd : null;
  const devRev = `${st.devWeth.toFixed(4)} WETH${devUsd != null ? " " + dim(`(${fmtSpent(devUsd)})`) : ""}`;

  const agentRows = [
    kv("Handle", accent("@" + state.handle), 7),
    kv("Admins", state.admins, 7),
    kv("Wallet", wallet, 7),
    kv("Poll", `${POLL_METHOD} ${dim("|")} ${POLL_SECONDS}s`, 7),
    kv("Claim", p?.bootMs ? `in ${cyan("~" + fmtDuration(nextTreasury))}` : dim("-"), 7),
    kv("Runway", runway, 7),
    kv("Sustainable", sustainable, 12),
    kv("Profitable", profitable, 12),
    ...(st.devWeth > 0 ? [kv("Dev rev", devRev, 12)] : []),
  ];

  // TREASURY panel — live on-chain balances, refreshed every BALANCE_INTERVAL_MS.
  // All balance values share one color; the USD total is the highlighted headline.
  const b = state.balances;
  const missing = process.env.BANKR_API_KEY ? dim("...") : dim("-");
  const creditMissing = LLM_KEY ? dim("...") : dim("-");
  const TPAD = 12; // label column width — fits "LLM credits" so values stay aligned

  // On-chain assets, sorted by USD value DESC, each shown as "<qty>  <USD value>"
  // (the qty is padded so the USD column lines up). When prices are unavailable the
  // USD column is dropped and the order is left as-is.
  const assets = b
    ? [
        { label: (b.symbol ?? "TOKEN").slice(0, 5), qty: fmtToken(b.token, b.decimals), usd: b.usd?.token ?? null },
        { label: "USDC", qty: fmtUsdc(b.usdc), usd: b.usd?.usdc ?? null },
        { label: "WETH", qty: fmtEth(b.weth), usd: b.usd?.weth ?? null },
        { label: "ETH", qty: fmtEth(b.eth), usd: b.usd?.eth ?? null },
      ].sort((x, y) => (y.usd ?? -1) - (x.usd ?? -1))
    : null;

  const treasuryRows = assets
    ? [
        ...assets.map((a) => kv(a.label, a.usd != null ? `${a.qty.padEnd(9)} ${dim(fmtUsd(a.usd))}` : a.qty, TPAD)),
        // LLM inference credits — an off-chain balance at the LLM gateway, so it sits
        // just under the on-chain assets, above the $ total.
        kv("LLM credits", state.creditUsd != null ? cyan(fmtUsd(state.creditUsd)) : creditMissing, TPAD),
        // Total treasury value = on-chain assets + the inference credit balance (it's
        // prepaid USDC, so it counts toward what the treasury is worth).
        kv("Total", b?.usdTotal != null ? bold(accent(fmtUsd(b.usdTotal + (state.creditUsd ?? 0)))) : missing, TPAD),
      ]
    : [
        // No balances resolved yet — show labels with a placeholder.
        kv((b?.symbol ?? "TOKEN").slice(0, 5), missing, TPAD),
        kv("USDC", missing, TPAD),
        kv("WETH", missing, TPAD),
        kv("ETH", missing, TPAD),
        kv("LLM credits", state.creditUsd != null ? cyan(fmtUsd(state.creditUsd)) : creditMissing, TPAD),
        kv("Total", missing, TPAD),
      ];

  // SERVER panel
  const sp = state.specs;
  const compute = state.computeHours != null ? `${cyan(fmtDuration(state.computeHours * 3_600_000))} ${dim("remaining")}` : dim("...");
  // CPU/RAM as: <yappr process> | <whole system> of <capacity>.
  const cpuUsage = `${p ? `${p.cpu}%` : dim("...")} ${dim("|")} ${state.sysCpu != null ? `${state.sysCpu}%` : dim("...")} ${dim("of")} ${sp ? sp.cpu + " vCPU" : "?"}`;
  const ramUsage = `${p ? fmtMem(p.mem) : dim("...")} ${dim("|")} ${state.sysMemMb != null ? `${state.sysMemMb}MB` : dim("...")} ${dim("of")} ${sp?.ram ?? "?"}`;
  const diskUsage = `${state.sysDiskUsed ?? dim("...")} ${dim("of")} ${sp?.disk ?? "?"}`;
  const status = p?.status === "online"
    ? `${cyan("online")} ${dim("for")} ${fmtDuration(elapsed)}`
    : p?.status === "stopped"
      ? red("stopped")
      : (p?.status && p.status !== "unknown" ? yellow : dim)(p?.status ?? "offline");
  const serverRows = [
    kv("IP", state.ip, 8),
    kv("OS", sp?.os ?? dim("..."), 8),
    kv("CPU", cpuUsage, 8),
    kv("RAM", ramUsage, 8),
    kv("Disk", diskUsage, 8),
    kv("Compute", compute, 8),
    kv("Status", status, 8),
  ];

  // Equalize heights so every box lines up (the logo is the tallest at 8 rows).
  const h = Math.max(YAPPR_LOGO.length, agentRows.length, treasuryRows.length, serverRows.length);
  const logo = panel("YAPPR", padRows(YAPPR_LOGO, h), logoW);
  const agent = panel("AGENT", centerRows(agentRows, h), leftW);
  const treasury = panel("TREASURY", centerRows(treasuryRows, h), midW);
  const server = panel("SERVER", centerRows(serverRows, h), rightW);

  let row = sideBySide(logo, logoW, agent, leftW, 1);
  row = sideBySide(row, logoW + 1 + leftW, treasury, midW, 1);
  row = sideBySide(row, logoW + 1 + leftW + 1 + midW, server, rightW, 1);
  out.push(...row);

  // ACTIVITY panel (full width, justified) — ascii only, no emoji.
  const s = state.stats;
  // Earned = all-time creator fees (WETH from the ledger), shown in USD via the ETH
  // price when we have it, else the raw WETH amount.
  // Earned shown in WETH (the raw creator fees) with the USD value at the current ETH
  // price in parens, e.g. "0.0512 WETH ($153.60)".
  const earnedUsd = b?.ethUsd != null ? s.earnedWeth * b.ethUsd : null;
  const earnedStr = `${green(`${s.earnedWeth.toFixed(4)} WETH`)}${earnedUsd != null ? " " + dim(`(${fmtSpent(earnedUsd)})`) : ""}`;
  // Burned = the agent's token held at the dead address, as a quantity and a % of
  // the fixed 100B supply every Bankr launch ships with.
  const burnedStr = b
    ? `${accent(fmtToken(b.burned, b.decimals))} ${dim(`(${fmtSupplyPct(Number(formatUnits(b.burned, b.decimals)))})`)}`
    : dim("...");
  out.push(...panel("ACTIVITY", [justify([
    `${String(s.mentions)} ${dim("mentions")}`,
    `${String(s.replies)} ${dim("replies")}`,
    `${String(s.llmTurns)} ${dim("llm requests")}`,
    `${earnedStr} ${dim("earned")}`,
    `${red(fmtSpent(s.spentUsd))} ${dim("spent")}`,
    `${burnedStr} ${dim("burned")}`,
    `${red(String(s.errors))} ${dim("errors")}`,
  ], cols - 4)], cols));

  // CHART panel — three views cycled with ←/→: (0) spent/earned last 24h, (1) hourly spent
  // vs earned, (2) hourly expenses by category. Sits between ACTIVITY and LOGS (shrinks
  // LOGS). Views show a placeholder until there's data.
  const ci = ((state.chartIndex % 3) + 3) % 3;
  const nav = dim(`[${ci + 1}/3 ←/→]`);
  const placeholder = [dim("collecting data… (redeploy if the agent predates this feature)")];
  const hasData = (c: ChartSeries) => c.spendUsd.length >= 2 && c.endMs > c.startMs;
  // The hourly views need a real signal, not just a fetched series: byType.startMs
  // is always set once the summary arrives, so gate on any nonzero bucket instead.
  const hasHourly = s.chart.byType.startMs > 0 &&
    [s.chart.byType.xapi, s.chart.byType.inference, s.chart.byType.compute, s.chart.byType.earned]
      .some((a) => a.some((v) => v > 0));
  let chartTitle: string;
  let chartLines: string[];
  if (ci === 1) {
    chartTitle = `HOURLY SPENT vs EARNED  ${dim("· 24h ·")} ${catColor(SPENT_RGB())("spent")} ${dim("/")} ${catColor(EARN_RGB())("earned")}  ${nav}`;
    chartLines = hasHourly ? renderHourlySpentEarned(cols, s.chart.byType, b?.ethUsd ?? null) : placeholder;
  } else if (ci === 2) {
    chartTitle = `HOURLY EXPENSES  ${dim("· 24h ·")} ${catColor(CAT_RGB().xapi)("x-api")} ${dim("/")} ${catColor(CAT_RGB().inference)("inference")} ${dim("/")} ${catColor(CAT_RGB().compute)("compute")}  ${nav}`;
    chartLines = hasHourly ? renderHourlyBars(cols, s.chart.byType) : placeholder;
  } else {
    chartTitle = `SPENT vs EARNED  ${dim("· 24h ·")} ${catColor(SPENT_RGB())("spent")} ${dim("/")} ${catColor(EARN_RGB())("earned")}  ${nav}`;
    chartLines = hasData(s.chart.day) ? renderLineChart(cols, s.chart.day, b?.ethUsd ?? null, s.chart.day.startMs, s.chart.day.startMs + 24 * HOUR_MS) : placeholder;
  }
  out.push(...panel(chartTitle, chartLines, cols));

  // LOGS panel fills the rest (less one row for the footer), with a scroll offset
  // (0 = following the live tail).
  const logRows = Math.max(3, rows - out.length - 3);
  state.logRows = logRows;
  const maxScroll = Math.max(0, state.logs.length - logRows);
  state.scroll = Math.min(Math.max(0, state.scroll), maxScroll); // keep in range as logs grow/expire
  const end = state.logs.length - state.scroll;                  // exclusive index of the bottom visible line
  const recent = state.logs.slice(Math.max(0, end - logRows), end).map((l) => displayLog(l));
  while (recent.length < logRows) recent.push("");
  const title = state.scroll > 0
    ? `LOGS  ${dim(`[paused] ${state.scroll} below ${dim("|")} G=live`)}`
    : "LOGS";
  out.push(...panel(title, recent, cols));

  // Footer: a confirmation prompt when a command is pending, otherwise key hints.
  out.push(footerLine(state, [
    key("up/dn", "scroll"), key("g/G", "top/live"), key("←/→", "chart"), key("shift+←/→", "cron"),
    key("t", "theme"), key("r", "restart"), key("s", "stop"), key("S", "start"), key("d", "redeploy"),
    key("q", "quit"),
  ], cols));

  return out;
}

function render(state: State) {
  // Reserve the last terminal column: writing into it triggers autowrap, which
  // (with the per-line erase below) drops the right border. Drawing one column
  // narrower keeps every box closed on the right.
  const cols = Math.max(48, (process.stdout.columns ?? 80) - 1);
  const rows = Math.max(16, process.stdout.rows ?? 24);
  const out = buildFrame(state, cols, rows);
  process.stdout.write("\x1b[H" + out.map((l) => themeLine(l) + "\x1b[K").join("\n") + "\x1b[0J");
}

// ─── main dashboard loop ──────────────────────────────────────────────────────

export async function runStatus(target: { ip: string; password?: string; handle?: string }): Promise<void> {
  const handle = target.handle || process.env.AGENT_HANDLE || "agent";

  // Match the terminal's background unless STATUS_THEME pins one explicitly.
  // Done before any rendering or key handling (the OSC query borrows stdin).
  if (!process.env.STATUS_THEME) {
    const detected = await detectTerminalTheme().catch(() => null);
    if (detected) setTheme(detected);
  }
  if (!target.password) {
    console.error(`  No SSH password available for root@${target.ip}. Set COMPUTE_SSH_PASSWORD in .env or use \`npm run ssh\`.`);
    return;
  }

  const ssh = new NodeSSH();
  try {
    await ssh.connect({ host: target.ip, username: "root", password: target.password, tryKeyboard: true, ...hostKeyConfig(target.ip) });
  } catch (err) {
    console.error(`  Could not connect to root@${target.ip}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const admins = (process.env.ADMIN_HANDLES || "").split(",").map((h) => h.trim()).filter(Boolean)
    .map((h) => (h.startsWith("@") ? h : "@" + h)).join(", ");
  const interactive = !!process.stdout.isTTY;
  const state: State = {
    ip: target.ip, handle, admins: admins || dim("none"), wallet: null,
    stats: { mentions: 0, replies: 0, llmTurns: 0, spentUsd: 0, warns: 0, errors: 0, earnedWeth: 0, devWeth: 0, spentUsdWindow: 0, inferenceUsdWindow: 0, earnedWethWindow: 0, rateWindowHours: 0, spentByType: { "x-api": 0, inference: 0, compute: 0 }, chart: { day: { spendUsd: [], earnedWeth: [], startMs: 0, endMs: 0 }, byType: { startMs: 0, xapi: [], inference: [], compute: [], earned: [] } } },
    logs: [], pm2: null, specs: null, balances: null, computeHours: null,
    creditUsd: null,
    sysCpu: null, sysMemMb: null, sysDiskUsed: null, scroll: 0, logRows: 0, confirm: null,
    chartIndex: 0,
    view: 0, cron: null, cronPage: 0,
  };

  let renderTimer: NodeJS.Timeout | undefined;
  let pm2Timer: NodeJS.Timeout | undefined;
  let balanceTimer: NodeJS.Timeout | undefined;
  let backupTimer: NodeJS.Timeout | undefined;
  let computeRetryTimer: NodeJS.Timeout | undefined;
  let onKey: ((buf: Buffer) => void) | undefined;
  let redeployPromise: Promise<void> | null = null;
  let done = false;
  const stopTimers = () => {
    if (renderTimer) clearInterval(renderTimer);
    if (pm2Timer) clearInterval(pm2Timer);
    if (balanceTimer) clearInterval(balanceTimer);
    if (backupTimer) clearInterval(backupTimer);
    if (computeRetryTimer) clearTimeout(computeRetryTimer);
  };
  const restoreTerminal = () => {
    if (onKey && process.stdin.isTTY) {
      try { process.stdin.setRawMode(false); } catch { /* ignore */ }
      process.stdin.pause();
      process.stdin.removeListener("data", onKey);
    }
  };
  const cleanup = () => {
    if (done) return;
    done = true;
    stopTimers();
    restoreTerminal();
    if (interactive) process.stdout.write("\x1b[?25h\n"); // restore cursor
    try { ssh.dispose(); } catch { /* ignore */ }
  };

  // Quit path: pull one final stats snapshot before tearing down, so the local backup
  // is current as of exit. We restore the terminal first (so the status line shows),
  // keep SSH alive for the backup, then dispose + exit. Bounded so a hung snapshot
  // can't trap the user. Idempotent via `exiting`.
  let exiting = false;
  const quit = async () => {
    if (exiting) return;
    exiting = true;
    stopTimers();
    restoreTerminal();
    if (interactive) process.stdout.write("\x1b[?25h\x1b[2J\x1b[3J\x1b[H"); // restore cursor + clear TUI
    process.stdout.write("  Backing up the database…\n");
    try {
      const f = await withTimeout(backupRemoteDb(ssh), 20_000);
      process.stdout.write(`  ${green("✓")} Backup saved: ${backupLabel(f)}\n`);
    } catch (err) {
      process.stdout.write(`  ${yellow("⚠")} Backup skipped: ${err instanceof Error ? err.message : String(err)}\n`);
    }
    done = true; // we've torn down; keep the stream's finally from re-running cleanup
    try { ssh.dispose(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on("SIGINT", quit);

  // Treasury balances + remaining compute: needs the Bankr-resolved wallet address.
  // Both are on-chain/API reads, so refresh them together on the balance interval.
  const apiKey = process.env.BANKR_API_KEY;
  const tokenAddress = process.env.TOKEN_ADDRESS as `0x${string}` | undefined;
  const instanceId = process.env.COMPUTE_INSTANCE_ID;
  const refreshBalances = (address: `0x${string}`) => {
    if (tokenAddress) fetchBalances(address, tokenAddress).then((bal) => { if (bal) state.balances = bal; }).catch(() => {});
  };
  // Remaining compute needs a Bankr-signed instance lookup, which is occasionally
  // slow or fails — unlike the plain RPC balance reads. Retry on a short cadence
  // until the first success so a transient miss doesn't leave "..." for minutes;
  // after that the 5-min balance timer keeps it fresh.
  const refreshCompute = async (address: `0x${string}`): Promise<boolean> => {
    if (!apiKey || !instanceId) return true; // nothing to fetch; stop retrying
    try {
      const h = remainingComputeHours(await fetchComputeInstance(apiKey, address, instanceId));
      if (h != null) { state.computeHours = h; return true; }
    } catch { /* retry */ }
    return false;
  };
  const ensureCompute = (address: `0x${string}`) => {
    refreshCompute(address).then((ok) => {
      // Tracked + re-checked at fire time so stopTimers()/cleanup() really ends the
      // chain (an untracked timeout would fire one more API call mid-redeploy/quit).
      if (!ok && !done) computeRetryTimer = setTimeout(() => { if (!done) ensureCompute(address); }, 30_000);
    });
  };
  const refreshTreasury = (address: `0x${string}`) => { refreshBalances(address); ensureCompute(address); };

  const refreshSysUsage = () => fetchSysUsage(ssh).then((u) => { state.sysCpu = u.cpu; state.sysMemMb = u.memMb; state.sysDiskUsed = u.diskUsed; }).catch(() => {});

  // Live LLM credit balance, for display only. Spend is tracked per-request by the
  // agent (token usage × pricing), not here; this just shows the remaining budget.
  const refreshCredits = () => fetchLlmCredits().then((cur) => { if (cur != null) state.creditUsd = cur; }).catch(() => {});

  // All-time activity + spend counters, read from the agent's stats summary.
  const refreshStats = () => fetchAgentStats(ssh).then((s) => { if (s) state.stats = s; }).catch(() => {});

  // Cron jobs for the CRON JOBS page. Fetched once at launch (so the first switch
  // is instant), on every switch to the page, and on the 5s tick while it's shown.
  const refreshCron = () => fetchCronJobs(ssh).then((c) => { if (c) state.cron = c; }).catch(() => {});

  // ── lifecycle commands (footer keys) ──
  // Push a dashboard-originated note into the log feed so command output is visible.
  const note = (msg: string) => { state.logs.push(`\x1b[36m[dashboard]\x1b[0m ${msg}`); if (state.logs.length > 400) state.logs.shift(); };

  // Periodic stats backup (the on-launch + every-N-minutes path; quit() does its own
  // final one). Best-effort: result/failure is surfaced in the log feed, never thrown.
  const runBackup = async () => {
    // The DB doesn't change while the bot is stopped — skip the snapshot.
    if (state.pm2 && state.pm2.status !== "online") return;
    try { note(`database backed up → ${backupLabel(await backupRemoteDb(ssh))}`); }
    catch (err) { note(`database backup failed: ${err instanceof Error ? err.message : String(err)}`); }
  };
  // pm2 restart/stop/start over the existing SSH connection (separate channel from
  // the log stream). Result is echoed into the feed and pm2 status refreshed.
  const runPm2 = async (action: "restart" | "stop" | "start") => {
    note(`pm2 ${action} yappr…`);
    const r = await ssh.execCommand(`pm2 ${action} yappr`, { cwd: "/" }).catch((e) => ({ stdout: "", stderr: String(e) }));
    const line = (r.stdout || r.stderr || "").trim().split("\n").pop() ?? "";
    note(line || `pm2 ${action} done`);
    fetchPm2(ssh).then((p) => { if (p) state.pm2 = p; }).catch(() => {});
  };
  // Re-deploy hands the terminal off to `npm run deploy` (which itself relaunches the
  // dashboard when it finishes). We tear down the TUI first so the two don't fight
  // over stdin/stdout, then await the child so the process doesn't exit early. cwd is
  // the project root the command was launched from (where deploy expects to run).
  const ROOT = process.cwd();
  const redeploy = () => {
    if (redeployPromise) return;
    redeployPromise = new Promise<void>((res) => {
      cleanup(); // ends log stream + timers, restores cursor/raw mode
      process.stdout.write("\x1b[?25h\x1b[2J\x1b[3J\x1b[H");
      console.log("Re-deploying — handing off to `npm run deploy`…\n");
      const child = spawn("npm", ["run", "deploy"], { stdio: "inherit", cwd: ROOT });
      child.on("exit", () => res());
      child.on("error", (e) => { console.error(e); res(); });
    });
  };

  // Best-effort enrichments (don't block the dashboard).
  state.pm2 = await fetchPm2(ssh).catch(() => null);
  fetchSpecs(ssh).then((sp) => { state.specs = sp; }).catch(() => {});
  refreshSysUsage();
  refreshCredits();
  refreshStats();
  refreshCron();
  if (apiKey) {
    resolveEvmAddress(apiKey).then((a) => { state.wallet = a; refreshTreasury(a); }).catch(() => {});
  }

  // First backup on launch, then one every BACKUP_INTERVAL_MS while the dashboard runs.
  void runBackup();
  backupTimer = setInterval(() => void runBackup(), BACKUP_INTERVAL_MS);

  if (interactive) {
    process.stdout.write("\x1b[?25l\x1b[2J\x1b[3J\x1b[H"); // hide cursor, clear screen
    renderTimer = setInterval(() => render(state), 250);
    pm2Timer = setInterval(() => { fetchPm2(ssh).then((p) => { if (p) state.pm2 = p; }).catch(() => {}); refreshSysUsage(); refreshStats(); if (state.view === 1) refreshCron(); }, 5000);
    balanceTimer = setInterval(() => { if (state.wallet) refreshTreasury(state.wallet as `0x${string}`); refreshCredits(); }, BALANCE_INTERVAL_MS);

    // Scrollable LOGS. Raw mode lets us read arrow/page keys; since it also swallows
    // the default Ctrl+C, we handle ^C (and q) here to quit. scroll counts lines up
    // from the live tail; buildFrame clamps it to the available history.
    if (process.stdin.isTTY) {
      const page = () => Math.max(1, state.logRows - 1);
      onKey = (buf: Buffer) => {
        const s = buf.toString();
        // A pending command intercepts the next key: "y" or Enter runs it; anything cancels.
        if (state.confirm) {
          const c = state.confirm;
          state.confirm = null;
          if (s === "y" || s === "Y" || s === "\r" || s === "\n") c.action();
          render(state);
          return;
        }
        if (s === "\x03" || s === "q") { void quit(); return; }
        // Lifecycle commands — armed here, executed only after y confirmation.
        if (s === "r") { state.confirm = { prompt: "Restart yappr?", action: () => void runPm2("restart") }; render(state); return; }
        if (s === "s") { state.confirm = { prompt: "Stop yappr?", action: () => void runPm2("stop") }; render(state); return; }
        if (s === "S") { state.confirm = { prompt: "Start yappr?", action: () => void runPm2("start") }; render(state); return; }
        if (s === "d") { state.confirm = { prompt: "Re-deploy yappr? (exits dashboard)", action: redeploy }; render(state); return; }
        if (s === "t") { toggleTheme(); render(state); return; } // dark ↔ light palette
        // shift+←/→ slides between the two pages (cyclical, so both keys work).
        if (s === "\x1b[1;2C" || s === "\x1b[1;2D") {
          state.view = (state.view + 1) % 2;
          if (state.view === 1) refreshCron();
          render(state);
          return;
        }
        if (s === "\x1b[C") { // → next chart / next cron page
          if (state.view === 1) state.cronPage++; // buildCronFrame clamps to the last page
          else state.chartIndex = (state.chartIndex + 1) % 3;
          render(state);
          return;
        }
        if (s === "\x1b[D") { // ← prev chart / prev cron page
          if (state.view === 1) state.cronPage = Math.max(0, state.cronPage - 1);
          else state.chartIndex = (state.chartIndex + 2) % 3;
          render(state);
          return;
        }
        let sc = state.scroll;
        if (s === "\x1b[A" || s === "k") sc += 1;            // up
        else if (s === "\x1b[B" || s === "j") sc -= 1;       // down
        else if (s === "\x1b[5~") sc += page();              // page up
        else if (s === "\x1b[6~") sc -= page();              // page down
        else if (s === "g" || s === "\x1b[H") sc = Number.MAX_SAFE_INTEGER; // top
        else if (s === "G" || s === "\x1b[F") sc = 0;        // live tail
        else return;
        state.scroll = Math.max(0, sc);
        render(state); // immediate feedback (buildFrame clamps to maxScroll)
      };
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on("data", onKey);
    }
    render(state);
  } else {
    console.log(`Streaming logs for @${handle} (root@${target.ip}) — Ctrl+C to stop.\n`);
  }

  // Stream pm2 logs until the connection ends or the user interrupts.
  let pending = "";
  const onData = (chunk: Buffer) => {
    pending += chunk.toString("utf8");
    const parts = pending.split("\n");
    pending = parts.pop() ?? "";
    for (const raw of parts) {
      const rawLine = raw.replace(/\s+$/, "");   // keep ANSI colors; trim line ending
      const plain = stripAnsi(rawLine);
      if (!plain) continue;
      state.logs.push(rawLine);                  // store colored for display (stats come from the ledger, not here)
      if (state.logs.length > 400) state.logs.shift();
      // When scrolled up (paused), advance the offset so the viewport stays on the
      // same lines as new ones arrive below; buildFrame clamps once history expires.
      if (state.scroll > 0) state.scroll++;
      if (!interactive) process.stdout.write(rawLine + "\n");
    }
  };

  try {
    // The LOGS panel just tails recent lines for display; counters come from the
    // agent's stats summary, so there's nothing to seed here.
    await ssh.execCommand("pm2 logs yappr --raw --lines 25", { cwd: "/", onStdout: onData, onStderr: onData });
  } catch {
    // Connection torn down (e.g. by a re-deploy handoff disposing the SSH session).
  } finally {
    process.off("SIGINT", quit);
    cleanup();
  }
  // If a re-deploy is in progress, keep the process alive until the deploy finishes.
  if (redeployPromise) await redeployPromise;
}

// ─── connection target resolution ─────────────────────────────────────────────

// Fast path: cached IP (COMPUTE_HOST) + password (COMPUTE_SSH_PASSWORD) — zero API
// calls. Otherwise resolve via the compute API (Bankr key + wallet signatures).
async function resolveTarget(instanceIdArg?: string): Promise<{ ip: string; password?: string; handle?: string }> {
  const handle = process.env.AGENT_HANDLE;
  const cachedIp = process.env.COMPUTE_HOST;
  const cachedPw = process.env.COMPUTE_SSH_PASSWORD;
  if (!instanceIdArg && cachedIp && cachedPw) return { ip: cachedIp, password: cachedPw, handle };

  const apiKey = process.env.BANKR_API_KEY;
  if (!apiKey) throw new Error("BANKR_API_KEY not set in .env");
  const instanceId = instanceIdArg || process.env.COMPUTE_INSTANCE_ID;
  if (!instanceId) throw new Error("No instance id — pass one as an argument or set COMPUTE_INSTANCE_ID in .env");

  const address = await resolveEvmAddress(apiKey);
  const instance = await fetchComputeInstance(apiKey, address, instanceId);
  const ip = computeInstanceIp(instance);
  if (!ip) throw new Error(`Instance has no IP yet (status: ${instance?.status ?? "unknown"})`);
  let password = computeInstancePassword(instance) || cachedPw || undefined;
  if (!password) password = await fetchOneTimePassword(apiKey, address, instanceId);
  return { ip, password, handle };
}

// Render one frame with mock data — for eyeballing the layout without a server:
//   npm run status -- --demo           # the status page
//   npm run status -- --demo --cron    # the cron jobs page
function demo() {
  const demoCron: CronJobInfo[] = [
    { id: 1, prompt: "Check the ETH price and store a one-line market note", schedule: "every 30 min", creator: "alice", enabled: true, nextRunAt: Date.now() + 720_000, lastRunAt: Date.now() - 1_080_000, lastResult: "ETH is at $3,012 (+1.2% on the day), gas 14 gwei.", lastError: null, runs: 41, consecutiveFailures: 0 },
    { id: 2, prompt: "Summarize replies to the pinned tweet and flag anything needing an answer", schedule: "daily at 09:00 Europe/Paris", creator: "bob", enabled: true, nextRunAt: Date.now() + 14_400_000, lastRunAt: Date.now() - 72_000_000, lastResult: "3 new replies, none need an answer.", lastError: null, runs: 6, consecutiveFailures: 0 },
    { id: 3, prompt: "Claim creator fees if above threshold", schedule: "every 360 min", creator: "alice", enabled: false, nextRunAt: 0, lastRunAt: Date.now() - 200_000_000, lastResult: null, lastError: 'Access denied: "wallet" requires admin privileges.', runs: 9, consecutiveFailures: 3 },
  ];
  const state: State = {
    ip: "203.0.113.7", handle: "evvrbot", admins: "@alice, @bob", wallet: "0xA1b2C3d4E5f6A7b8C9d0E1f2A3b4C5d6E7f80910",
    stats: { mentions: 37, replies: 29, llmTurns: 84, spentUsd: 0.7345, warns: 1, errors: 0, earnedWeth: 0.0512, devWeth: 0.0123, spentUsdWindow: 96, inferenceUsdWindow: 1.2, earnedWethWindow: 0.004, rateWindowHours: 24,
      spentByType: { "x-api": 0.55, inference: 0.06, compute: 0.12 },
      chart: (() => { const sp: number[] = [], ew: number[] = []; let a = 0, b2 = 0; for (let i = 0; i < 60; i++) { a += 0.012; b2 += i > 15 ? 0.0009 : 0; sp.push(a); ew.push(b2); } const day = { spendUsd: sp, earnedWeth: ew, startMs: Date.now() - 5 * 3_600_000, endMs: Date.now() }; const x: number[] = [], inf: number[] = [], c: number[] = [], ea: number[] = []; for (let i = 0; i < 24; i++) { x.push(i >= 12 ? 0.02 + (i % 3) * 0.005 : 0); inf.push(i >= 12 ? 0.003 : 0); c.push(i === 18 ? 0.06 : 0); ea.push(i >= 14 ? 0.000005 + (i % 4) * 0.000002 : 0); } const byType = { startMs: Date.now() - 23 * 3_600_000, xapi: x, inference: inf, compute: c, earned: ea }; return { day, byType }; })() },
    pm2: { status: "online", bootMs: Date.now() - 8_120_000, restarts: 2, mem: 149 * 1024 * 1024, cpu: 3 },
    specs: { cpu: "2", ram: "1.9Gi", disk: "25G", os: "Ubuntu 24.04.1 LTS" },
    balances: { token: 1_234_567n * 10n ** 18n, weth: 42_000_000_000_000_000n, eth: 3_500_000_000_000_000n, usdc: 1875_000_000n, burned: 2_450_000n * 10n ** 18n, symbol: "EVVR", decimals: 18, usdTotal: 2_104.37, ethUsd: 3000, usd: { token: 92.87, weth: 126, eth: 10.5, usdc: 1875 } },
    computeHours: 19.5,
    creditUsd: 4.21,
    sysCpu: 3, sysMemMb: 600, sysDiskUsed: "12G",
    scroll: 0, logRows: 0,
    confirm: null,
    chartIndex: 0,
    view: process.argv.includes("--cron") ? 1 : 0, cron: demoCron, cronPage: 0,
    logs: [
      "[2026-06-08 12:30:01] INFO: poll cycle start",
      '[2026-06-08 12:30:02] INFO: new mentions found {"count":2}',
      "[2026-06-08 12:30:02] INFO: processing mention {\"author\":\"alice\"}",
      "[2026-06-08 12:30:05] INFO: LLM request (3 messages)",
      "[2026-06-08 12:30:09] INFO: replied {\"id\":\"206...\"}",
      "[2026-06-08 12:30:21] WARN: previous poll still running, skipping tick",
    ],
  };
  render(state);
  process.stdout.write("\n");
}

// Build a frame at a fixed size and report any line whose display width != cols.
function check(cols = 143, rows = 40) {
  const long = String.raw`[2026-06-08 15:21:32] INFO: x-api GET /tweets/mentions {"path":"/tweets/mentions","params":{"auth_token":"[redacted]","ct0":"[redacted]"}}`;
  const state: State = {
    ip: "95.179.144.82", handle: "evvrbot", admins: "@alexben0006", wallet: "0xe6440ce076a5b491e7d6378223517d60a96b1326",
    stats: { mentions: 0, replies: 0, llmTurns: 0, spentUsd: 0, warns: 0, errors: 0, earnedWeth: 0, devWeth: 0, spentUsdWindow: 12, inferenceUsdWindow: 1, earnedWethWindow: 0.001, rateWindowHours: 24, spentByType: { "x-api": 8, inference: 1, compute: 3 }, chart: { day: { spendUsd: Array.from({ length: 60 }, (_, i) => i * 0.2), earnedWeth: Array.from({ length: 60 }, (_, i) => i * 0.00005), startMs: Date.now() - 24 * 3_600_000, endMs: Date.now() }, byType: { startMs: Date.now() - 23 * 3_600_000, xapi: Array.from({ length: 24 }, (_, i) => i >= 10 ? 0.02 : 0), inference: Array.from({ length: 24 }, (_, i) => i >= 10 ? 0.003 : 0), compute: Array.from({ length: 24 }, (_, i) => i === 16 ? 0.05 : 0), earned: Array.from({ length: 24 }, (_, i) => i >= 14 ? 0.000006 : 0) } } },
    pm2: { status: "online", bootMs: Date.now() - 945_000, restarts: 1, mem: 110 * 1024 * 1024, cpu: 0.4 },
    specs: { cpu: "1", ram: "951Mi", disk: "23G", os: "Ubuntu 22.04.5 LTS" }, scroll: 0, logRows: 0,
    balances: { token: 1_234_567n * 10n ** 18n, weth: 42_000_000_000_000_000n, eth: 3_500_000_000_000_000n, usdc: 1875_000_000n, burned: 2_450_000n * 10n ** 18n, symbol: "EVVR", decimals: 18, usdTotal: 2_104.37, ethUsd: 3000, usd: { token: 92.87, weth: 126, eth: 10.5, usdc: 1875 } },
    computeHours: 19.5, creditUsd: 4.21, sysCpu: 4, sysMemMb: 740, sysDiskUsed: "9.1G", confirm: null, chartIndex: 0,
    view: 0, cron: null, cronPage: 0,
    logs: Array.from({ length: 30 }, () => long),
  };
  // Both pages: the status frame, then the cron frame (with an overlong prompt
  // and result so truncation is exercised too).
  state.cron = [
    { id: 12, prompt: long.repeat(2), schedule: "every 30 min", creator: "alexben0006", enabled: true, nextRunAt: Date.now() + 60_000, lastRunAt: Date.now() - 60_000, lastResult: long.repeat(2), lastError: null, runs: 99, consecutiveFailures: 0 },
    { id: 13, prompt: "short", schedule: "daily at 09:00 Europe/Paris", creator: "alexben0006", enabled: false, nextRunAt: 0, lastRunAt: null, lastResult: null, lastError: long, runs: 0, consecutiveFailures: 4 },
  ];
  const frame = [...buildFrame(state, cols, rows), ...buildFrame({ ...state, view: 1 }, cols, rows)];
  let bad = 0;
  frame.forEach((l, i) => { const w = stringWidth(l); if (w !== cols) { bad++; console.log(`line ${i}: width ${w} != ${cols}  ${JSON.stringify(stripAnsi(l).slice(0, 30))}`); } });
  console.log(bad ? `\n${bad} mismatched line(s)` : `all ${frame.length} lines == ${cols} ✓`);
}

async function main() {
  if (process.argv.includes("--check")) { check(); return; }
  if (process.argv.includes("--demo")) { demo(); return; }
  const target = await resolveTarget(process.argv[2]);
  await runStatus(target);
  process.exit(0);
}

// The `yappr status` entry. (deploy imports runStatus directly for its hand-off.)
export async function run(): Promise<void> {
  await main();
}

// Auto-run only when invoked directly (not when imported by the bin/deploy).
const invokedDirectly = (() => {
  try { return fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? ""); }
  catch { return false; }
})();
if (invokedDirectly) {
  main().catch((err) => {
    process.stdout.write("\x1b[?25h");
    console.error(`\n  x  ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
