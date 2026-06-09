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
import * as asciichart from "asciichart";
import { dim, bold, green, yellow, red, cyan, accent, border, YAPPR_LOGO } from "./ui.js";
import { backupRemoteDb, backupLabel } from "./backup.js";
import { hostKeyConfig } from "./host-key.js";

// Chart line colors (raw ANSI, fed to asciichart). Spend = 16-color red; earned = the
// same truecolor green the rest of the TUI uses (the 16-color green renders salmon on
// some terminal themes).
// Spent (red) / earned (cyan) as truecolor RGB triples — used by the stacked spent-vs-earned
// bar chart (the boundary cell needs an fg AND bg color) and its legend. CHART_SPEND/EARN are
// the escape-sequence forms the line charts feed to asciichart.
const SPENT_RGB = "224;71;71", EARN_RGB = "0;188;212";
const CHART_SPEND = `\x1b[38;2;${SPENT_RGB}m`;
const CHART_EARN = `\x1b[38;2;${EARN_RGB}m`; // cyan, matching the "earned" legend
// Numeric env var with a fallback that also covers malformed values — a NaN here
// would otherwise break the charts or turn an interval into a ~1ms hot loop.
function numEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && process.env[name] !== "" ? n : fallback;
}

// Plot rows for the spent/earned line charts. asciichart draws height+1 rows, so 8 → 9
// rows + 1 axis = 10 content lines, matching the hourly bar chart (H=9 bars + 1 axis).
// Override with STATUS_CHART_HEIGHT. (1-decimal y labels keep the rows distinct.)
const LINE_CHART_HEIGHT = Math.max(3, numEnv("STATUS_CHART_HEIGHT", 8));

// Expense-category colors as truecolor RGB triples (so they're stable across themes and
// usable as a half-block cell background). Shared by the bar chart and its legend.
const CAT_RGB = { xapi: "0;188;212", inference: "215;119;87", compute: "234;179;8" } as const;
const catColor = (rgb: string) => (s: string) => `\x1b[38;2;${rgb}m${s}\x1b[0m`;

const TREASURY_INTERVAL_MS = numEnv("TREASURY_INTERVAL_MS", 3_600_000);
// How often the dashboard pulls a DB snapshot into instance/backups/ (default 20 min).
const BACKUP_INTERVAL_MS = numEnv("STATUS_BACKUP_INTERVAL_MS", 1_200_000);

// Runway model. Below this many hours of recorded activity the measured burn rate is
// too noisy to trust, so we fall back to a predicted floor from the poll cadence.
const RUNWAY_MIN_DATA_HOURS = 1;
// Predicted cold-start burn: the always-on cost is the mentions poll (~$0.005 per x402
// call) at the configured cadence. Event-driven costs (LLM, replies, compute) only join
// once the measured window takes over.
const X_API_POLL_COST_USD = 0.005;
const POLL_METHOD = (process.env.POLL_METHOD || "search").toLowerCase();
const POLL_SECONDS = Math.round(numEnv("POLL_INTERVAL_MS", 20_000) / 1000);
// Treasury balances + remaining compute refresh on this cadence (default 5 min).
const BALANCE_INTERVAL_MS = numEnv("STATUS_BALANCE_INTERVAL_MS", 300_000);

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

// ─── on-chain balances (Base) ──────────────────────────────────────────────────

const WETH_ADDR = "0x4200000000000000000000000000000000000006" as `0x${string}`;
const USDC_ADDR = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as `0x${string}`;
const ERC20_VIEW_ABI = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "o", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "symbol", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;

const baseClient = createPublicClient({ chain: base, transport: http() });

type Balances = { token: bigint; weth: bigint; eth: bigint; usdc: bigint; symbol: string; decimals: number; usdTotal: number | null; ethUsd: number | null; usd: { token: number; weth: number; eth: number; usdc: number } | null };

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
    const erc20 = (addr: `0x${string}`) =>
      baseClient.readContract({ address: addr, abi: ERC20_VIEW_ABI, functionName: "balanceOf", args: [address] }) as Promise<bigint>;
    const [token, weth, usdc, eth, symbol, decimals, prices] = await Promise.all([
      erc20(tokenAddress),
      erc20(WETH_ADDR),
      erc20(USDC_ADDR),
      baseClient.getBalance({ address }),
      (baseClient.readContract({ address: tokenAddress, abi: ERC20_VIEW_ABI, functionName: "symbol" }) as Promise<string>).catch(() => "TOKEN"),
      (baseClient.readContract({ address: tokenAddress, abi: ERC20_VIEW_ABI, functionName: "decimals" }) as Promise<number>).catch(() => 18),
      fetchPrices(tokenAddress),
    ]);
    const dec = Number(decimals);
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
    return { token, weth, eth, usdc, symbol, decimals: dec, usdTotal, ethUsd: prices?.eth ?? null, usd };
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
        all: cs(s.chart?.all),
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

// ─── parsing ──────────────────────────────────────────────────────────────────

type Stats = { mentions: number; replies: number; llmTurns: number; spentUsd: number; warns: number; errors: number; earnedWeth: number; devWeth: number; spentUsdWindow: number; inferenceUsdWindow: number; earnedWethWindow: number; rateWindowHours: number; spentByType: { "x-api": number; inference: number; compute: number }; chart: { day: ChartSeries; all: ChartSeries; byType: { startMs: number; xapi: number[]; inference: number[]; compute: number[]; earned: number[] } } };
type Pm2 = { status: string; bootMs: number; restarts: number; mem: number; cpu: number };
type Specs = { cpu: string; ram: string; disk: string; os: string };

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

// Resample a series to exactly `width` points (down- or up-sampling) with linear
// interpolation, keeping the endpoints — so the chart fills the panel width regardless
// of how many points the server sent.
function fitSeries(arr: number[], width: number): number[] {
  if (arr.length === 0 || width < 1) return [];
  if (arr.length === width) return arr;
  if (width === 1) return [arr[arr.length - 1]];
  const out: number[] = [];
  for (let i = 0; i < width; i++) {
    const pos = (i * (arr.length - 1)) / (width - 1);
    const lo = Math.floor(pos);
    const hi = Math.min(arr.length - 1, lo + 1);
    out.push(arr[lo] + (arr[hi] - arr[lo]) * (pos - lo));
  }
  return out;
}

type ChartSeries = { spendUsd: number[]; earnedWeth: number[]; startMs: number; endMs: number };

const HOUR_MS = 3_600_000, DAY_MS = 86_400_000;
const LABEL_OFFSET = 9; // asciichart's y-axis label column width (7-char label + " " + axis)

// Compact money label, e.g. $0.3 / $4.7 / $45 / $1.2k / $3.4m (negative-zero stripped).
// Keeps 1 decimal under $100 so closely-spaced axis rows don't collapse to the same label.
function fmtMoney(x: number): string {
  const a = Math.abs(x);
  let t = a >= 1e6 ? (x / 1e6).toFixed(1) + "m" : a >= 1000 ? (x / 1000).toFixed(1) + "k" : a >= 100 ? x.toFixed(0) : x.toFixed(1);
  if (parseFloat(t) === 0) t = t.replace(/^-/, "");
  return "$" + t;
}

// Adaptive x-axis row aligned to the plot columns over [startMs, endMs]: hourly ticks for
// spans ≤2 days, daily up to ~75 days, else monthly. Labels are placed left→right and any
// that would touch the previous one is skipped, so they thin to fit and never merge.
function adaptiveTimeAxis(labelOffset: number, plotWidth: number, startMs: number, endMs: number): string {
  const total = labelOffset + plotWidth;
  const cells = new Array(total).fill(" ");
  const span = endMs - startMs;
  if (span <= 0) return cells.join("");
  const ticks: Array<{ t: number; label: string }> = [];
  if (span <= 2 * DAY_MS) {
    const d = new Date(startMs); d.setMinutes(0, 0, 0);
    for (let t = d.getTime(); t <= endMs; t += HOUR_MS) ticks.push({ t, label: `${String(new Date(t).getHours()).padStart(2, "0")}:00` });
  } else if (span <= 75 * DAY_MS) {
    const d = new Date(startMs); d.setHours(0, 0, 0, 0);
    for (let t = d.getTime(); t <= endMs; t += DAY_MS) ticks.push({ t, label: new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" }) });
  } else {
    const multiYear = span > 330 * DAY_MS;
    const m = new Date(startMs); m.setDate(1); m.setHours(0, 0, 0, 0);
    while (m.getTime() <= endMs) {
      ticks.push({ t: m.getTime(), label: m.toLocaleDateString(undefined, multiYear ? { month: "short", year: "2-digit" } : { month: "short" }) });
      m.setMonth(m.getMonth() + 1);
    }
  }
  if (!ticks.length) return cells.join("");
  // Thin uniformly: show every `step`-th tick so labels are evenly spaced and don't collide
  // (greedy per-tick skipping looked irregular with many same-width hour labels).
  const maxLen = Math.max(...ticks.map((t) => t.label.length));
  const colsPerTick = plotWidth / ticks.length;
  const step = Math.max(1, Math.ceil((maxLen + 2) / Math.max(colsPerTick, 0.001)));
  let lastEnd = labelOffset - 1;
  for (let i = 0; i < ticks.length; i += step) {
    const { t, label } = ticks[i];
    const plotCol = Math.round(((t - startMs) / span) * (plotWidth - 1));
    let pos = labelOffset + plotCol - Math.floor(label.length / 2); // center under the tick
    if (pos < labelOffset) pos = labelOffset;
    if (pos + label.length > total) pos = total - label.length;
    if (pos <= lastEnd) continue; // safety: never overlap the previous label
    for (let j = 0; j < label.length; j++) cells[pos + j] = label[j];
    lastEnd = pos + label.length;
  }
  return cells.join("");
}

// Cumulative spend/earn line chart → panel lines. The series covers [windowStart, endMs];
// it's drawn across the fraction of the plot that the data occupies within [windowStart,
// windowEnd], leaving the rest blank on the right (so a partial 24h shows empty space).
function renderLineChart(cols: number, series: ChartSeries, ethUsd: number | null, windowStart: number, windowEnd: number): string[] {
  const w = Math.max(8, cols - 13);
  const winSpan = windowEnd - windowStart;
  const dataCols = winSpan > 0 ? Math.max(2, Math.min(w, Math.round((w * (series.endMs - windowStart)) / winSpan))) : w;
  const spend = fitSeries(series.spendUsd, dataCols);
  const earn = ethUsd != null ? fitSeries(series.earnedWeth.map((v) => v * ethUsd), dataCols) : null;
  const seriesArr = earn && earn.length === spend.length ? [spend, earn] : [spend];
  const colors = seriesArr.length === 2 ? [CHART_SPEND, CHART_EARN] : [CHART_SPEND];
  const lines = asciichart.plot(seriesArr, { height: LINE_CHART_HEIGHT, colors, format: (x: number) => fmtMoney(x).padEnd(7) }).split("\n");
  lines.push(dim(adaptiveTimeAxis(LABEL_OFFSET, w, windowStart, windowEnd))); // x-axis spans the full window
  return lines;
}

// Generic stacked vertical bar chart over the 24 hourly buckets → panel lines.
// One discrete bar per hour, its segments stacked bottom-up in layer order
// (`layers`, each a values series + RGB). Half-block characters double the
// vertical resolution (each text row = 8 sub-levels via ▁..█ + fg/bg), so even
// thin segments show. A y-axis shows the max; an x-axis shows the hours below.
// Backs both the per-category expenses chart and the spent-vs-earned chart.
function renderStackedBars(cols: number, startMs: number, layers: Array<{ values: number[]; rgb: string }>): string[] {
  const N = 24, H = 9, EIGHTH = 8, SUB = H * EIGHTH, labelW = 8, HOUR = 3_600_000;
  const LOWER = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"]; // lower-block fills, 0..8 eighths
  const plotW = Math.max(N, cols - 4 - labelW);
  const slot = plotW / N;
  const totals = Array.from({ length: N }, (_, i) => layers.reduce((sum, l) => sum + (l.values[i] ?? 0), 0));
  const max = Math.max(...totals, 1e-9);

  // Per-hour segment heights in SUB-levels (8 per row), bottom→top in layer order.
  // Rounding is reconciled so the parts sum to the bar's total height: the last
  // layer takes the remainder, and any negative remainder eats into lower layers.
  const seg = totals.map((tot, i) => {
    const tr = Math.round((tot / max) * SUB);
    const parts = layers.map((l, k) =>
      k === layers.length - 1 ? 0 : tot > 0 ? Math.round(((l.values[i] ?? 0) / tot) * tr) : 0);
    parts[parts.length - 1] = tr - parts.reduce((a, b) => a + b, 0);
    for (let k = parts.length - 1; k > 0; k--) {
      if (parts[k] < 0) { parts[k - 1] += parts[k]; parts[k] = 0; }
    }
    // Cumulative top boundary of each layer, so subColor is a simple scan.
    const bounds: number[] = [];
    parts.reduce((acc, p) => { bounds.push(acc + p); return acc + p; }, 0);
    return { bounds, tr };
  });
  // RGB of a bar's segment at a given sub-level, or null above the bar.
  const subColor = (sg: { bounds: number[]; tr: number }, sub: number): string | null => {
    if (sub >= sg.tr) return null;
    for (let k = 0; k < sg.bounds.length; k++) if (sub < sg.bounds[k]) return layers[k].rgb;
    return null;
  };
  // One text cell covering 8 sub-levels [base, base+8). Filled bottom-up: the bottom color
  // fills `h1` eighths (foreground of a lower-block glyph); whatever's above (next segment
  // color, or empty) is the cell background. Resolves single-color, a color boundary, and
  // the bar's partial top at 1/8 precision.
  const cellAt = (sg: { bounds: number[]; tr: number }, base: number): string => {
    const c1 = subColor(sg, base);
    if (!c1) return " ";
    let h1 = 1;
    while (h1 < EIGHTH && subColor(sg, base + h1) === c1) h1++;
    const c2 = h1 < EIGHTH ? subColor(sg, base + h1) : null;
    return c2 ? `\x1b[38;2;${c1};48;2;${c2}m${LOWER[h1]}\x1b[0m` : `\x1b[38;2;${c1}m${LOWER[h1]}\x1b[0m`;
  };

  // Each hour is a discrete bar `barW` columns wide, centered in its slot, with a clear gap.
  const barW = Math.max(1, Math.round(slot * 0.5));
  const lines: string[] = [];
  for (let r = 0; r < H; r++) {
    const base = (H - 1 - r) * EIGHTH; // sub-level at the bottom of this row (0 = chart floor)
    const row = new Array<string>(plotW).fill(" ");
    for (let hour = 0; hour < N; hour++) {
      const ch = cellAt(seg[hour], base);
      if (ch === " ") continue;
      const colStart = Math.round(hour * slot + (slot - barW) / 2);
      for (let w = 0; w < barW && colStart + w < plotW; w++) row[colStart + w] = ch;
    }
    // Label every row at its top-edge value (bottom row = $0), flush-left like the line
    // charts. The scale tracks `max`, so it adapts as spend grows ($1.2k / $3.4m).
    const ylab = r === H - 1 ? "$0" : fmtMoney((max * (H - r)) / H);
    lines.push(ylab.padEnd(labelW - 1) + "│" + row.join(""));
  }
  lines.push(dim(adaptiveTimeAxis(labelW, plotW, startMs, startMs + N * HOUR)));
  return lines;
}

// Per-hour spend stacked by type: x-api / inference / compute, bottom-up.
function renderHourlyBars(cols: number, byType: { startMs: number; xapi: number[]; inference: number[]; compute: number[] }): string[] {
  return renderStackedBars(cols, byType.startMs, [
    { values: byType.xapi, rgb: CAT_RGB.xapi },
    { values: byType.inference, rgb: CAT_RGB.inference },
    { values: byType.compute, rgb: CAT_RGB.compute },
  ]);
}

// Per-hour spent (red, bottom) vs earned (cyan, stacked on top), both in USD —
// earned is the WETH series converted at the live ETH price.
function renderHourlySpentEarned(cols: number, d: { startMs: number; xapi: number[]; inference: number[]; compute: number[]; earned: number[] }, ethUsd: number | null): string[] {
  const N = 24;
  const spent = Array.from({ length: N }, (_, i) => (d.xapi[i] ?? 0) + (d.inference[i] ?? 0) + (d.compute[i] ?? 0));
  const earned = Array.from({ length: N }, (_, i) => (d.earned[i] ?? 0) * (ethUsd ?? 0));
  return renderStackedBars(cols, d.startMs, [
    { values: spent, rgb: SPENT_RGB },
    { values: earned, rgb: EARN_RGB },
  ]);
}

// Reject if a promise hasn't settled within `ms` — used to bound the on-quit backup
// so a hung SSH/snapshot can't block the dashboard from exiting.
const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timed out")), ms))]);

// Display a log line with pm2/pino-style coloring. pino-pretty (colorize:true)
// already writes ANSI colors into the pm2 log files, so when a line is already
// colored we keep it verbatim; otherwise we colorize a plain `[time] LEVEL: msg
// {json}` line ourselves (dim timestamp, severity-colored level, plain message,
// dim JSON tail).
function displayLog(line: string): string {
  if (line.includes("\x1b[")) return line; // already colored upstream
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

const fmtUsdc = (v: bigint) => `$${Number(formatUnits(v, 6)).toFixed(2)}`;
const fmtUsd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
// Spend is often sub-cent (calls cost ~$0.0025–$0.01), so show 4 dp until it tops $1.
const fmtSpent = (n: number) => `$${n.toFixed(n >= 1 ? 2 : 4)}`;

// ─── box / layout primitives (ANSI- and wide-char-aware via string-width) ──────

// Fit a (possibly colored) string to an exact display width: pad with spaces or
// truncate with an ellipsis, preserving ANSI codes.
function fit(s: string, width: number): string {
  const w = stringWidth(s);
  if (w === width) return s;
  if (w < width) return s + " ".repeat(width - w);
  return cliTruncate(s, width, { position: "end", truncationCharacter: "~" });
}

// A labelled value row, with the label dimmed and padded for column alignment.
const kv = (label: string, value: string, pad = 9) => dim(label.padEnd(pad)) + value;

// Render a rounded-border panel of a fixed total width. Title sits in the top edge.
function panel(title: string, content: string[], width: number): string[] {
  const inner = width - 4; // "│ " + content + " │"
  const fillLen = Math.max(0, width - 5 - stringWidth(title)); // ╭ ─ " title " ─*fill ╮ (ANSI-aware)
  const top = border("┌─") + bold(` ${title} `) + border("─".repeat(fillLen) + "┐");
  const bottom = border("└" + "─".repeat(width - 2) + "┘");
  const body = content.map((line) => border("│") + " " + fit(line, inner) + "\x1b[0m " + border("│"));
  return [top, ...body, bottom];
}

// Lay two equal-or-fixed-width panels next to each other.
function sideBySide(a: string[], aw: number, b: string[], bw: number, gap = 1): string[] {
  const h = Math.max(a.length, b.length);
  const rows: string[] = [];
  for (let i = 0; i < h; i++) {
    rows.push((a[i] ?? " ".repeat(aw)) + " ".repeat(gap) + (b[i] ?? " ".repeat(bw)));
  }
  return rows;
}

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
  // earned, 2 = hourly expenses by category, 3 = spent/earned all-time.
  chartIndex: number;
};

// Pad a content array with blank rows so stacked panels share one height.
const padRows = (lines: string[], n: number) => (lines.length >= n ? lines : [...lines, ...Array(n - lines.length).fill("")]);

// Like padRows, but split the padding above/below so shorter info panels sit
// vertically centred next to the taller logo panel.
const centerRows = (lines: string[], n: number) => {
  if (lines.length >= n) return lines;
  const top = Math.floor((n - lines.length) / 2);
  return [...Array(top).fill(""), ...lines, ...Array(n - lines.length - top).fill("")];
};

function buildFrame(state: State, cols: number, rows: number): string[] {
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
  out.push(...panel("ACTIVITY", [justify([
    `${String(s.mentions)} ${dim("mentions")}`,
    `${String(s.replies)} ${dim("replies")}`,
    `${String(s.llmTurns)} ${dim("llm requests")}`,
    `${earnedStr} ${dim("earned")}`,
    `${red(fmtSpent(s.spentUsd))} ${dim("spent")}`,
    `${yellow(String(s.warns))} ${dim("warnings")}`,
    `${red(String(s.errors))} ${dim("errors")}`,
  ], cols - 4)], cols));

  // CHART panel — four views cycled with ←/→: (0) spent/earned last 24h, (1) hourly spent
  // vs earned, (2) hourly expenses by category, (3) spent/earned all-time. Sits between
  // ACTIVITY and LOGS (shrinks LOGS). Views show a placeholder until there's data.
  const ci = ((state.chartIndex % 4) + 4) % 4;
  const nav = dim(`[${ci + 1}/4 ←/→]`);
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
    chartTitle = `HOURLY SPENT vs EARNED  ${dim("· 24h ·")} ${catColor(SPENT_RGB)("spent")} ${dim("/")} ${catColor(EARN_RGB)("earned")}  ${nav}`;
    chartLines = hasHourly ? renderHourlySpentEarned(cols, s.chart.byType, b?.ethUsd ?? null) : placeholder;
  } else if (ci === 2) {
    chartTitle = `HOURLY EXPENSES  ${dim("· 24h ·")} ${catColor(CAT_RGB.xapi)("x-api")} ${dim("/")} ${catColor(CAT_RGB.inference)("inference")} ${dim("/")} ${catColor(CAT_RGB.compute)("compute")}  ${nav}`;
    chartLines = hasHourly ? renderHourlyBars(cols, s.chart.byType) : placeholder;
  } else if (ci === 3) {
    chartTitle = `SPENT vs EARNED  ${dim("· all time ·")} ${catColor(SPENT_RGB)("spent")} ${dim("/")} ${catColor(EARN_RGB)("earned")}  ${nav}`;
    chartLines = hasData(s.chart.all) ? renderLineChart(cols, s.chart.all, b?.ethUsd ?? null, s.chart.all.startMs, s.chart.all.endMs) : placeholder;
  } else {
    chartTitle = `SPENT vs EARNED  ${dim("· 24h ·")} ${catColor(SPENT_RGB)("spent")} ${dim("/")} ${catColor(EARN_RGB)("earned")}  ${nav}`;
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
  const key = (k: string, label: string) => `${accent(k)} ${dim(label)}`;
  const footer = state.confirm
    ? `${yellow(state.confirm.prompt)}  ${accent("y")}${dim("/")}${accent("Enter")} ${dim("to confirm, any other key cancels")}`
    : [
        key("up/dn", "scroll"), key("g/G", "top/live"), key("←/→", "chart"),
        key("r", "restart"), key("s", "stop"), key("S", "start"), key("d", "redeploy"),
        key("q", "quit"),
      ].join(dim("  ")) + `   ${dim("· safe to quit — reopen with")} ${accent("npx yappr status")}`;
  out.push(fit(footer, cols));

  return out;
}

function render(state: State) {
  // Reserve the last terminal column: writing into it triggers autowrap, which
  // (with the per-line erase below) drops the right border. Drawing one column
  // narrower keeps every box closed on the right.
  const cols = Math.max(48, (process.stdout.columns ?? 80) - 1);
  const rows = Math.max(16, process.stdout.rows ?? 24);
  const out = buildFrame(state, cols, rows);
  process.stdout.write("\x1b[H" + out.map((l) => l + "\x1b[K").join("\n") + "\x1b[0J");
}

// ─── main dashboard loop ──────────────────────────────────────────────────────

export async function runStatus(target: { ip: string; password?: string; handle?: string }): Promise<void> {
  const handle = target.handle || process.env.AGENT_HANDLE || "agent";
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
    stats: { mentions: 0, replies: 0, llmTurns: 0, spentUsd: 0, warns: 0, errors: 0, earnedWeth: 0, devWeth: 0, spentUsdWindow: 0, inferenceUsdWindow: 0, earnedWethWindow: 0, rateWindowHours: 0, spentByType: { "x-api": 0, inference: 0, compute: 0 }, chart: { day: { spendUsd: [], earnedWeth: [], startMs: 0, endMs: 0 }, all: { spendUsd: [], earnedWeth: [], startMs: 0, endMs: 0 }, byType: { startMs: 0, xapi: [], inference: [], compute: [], earned: [] } } },
    logs: [], pm2: null, specs: null, balances: null, computeHours: null,
    creditUsd: null,
    sysCpu: null, sysMemMb: null, sysDiskUsed: null, scroll: 0, logRows: 0, confirm: null,
    chartIndex: 0,
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

  // ── lifecycle commands (footer keys) ──
  // Push a dashboard-originated note into the log feed so command output is visible.
  const note = (msg: string) => { state.logs.push(`\x1b[36m[dashboard]\x1b[0m ${msg}`); if (state.logs.length > 400) state.logs.shift(); };

  // Periodic stats backup (the on-launch + every-N-minutes path; quit() does its own
  // final one). Best-effort: result/failure is surfaced in the log feed, never thrown.
  const runBackup = async () => {
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
  if (apiKey) {
    resolveEvmAddress(apiKey).then((a) => { state.wallet = a; refreshTreasury(a); }).catch(() => {});
  }

  // First backup on launch, then one every BACKUP_INTERVAL_MS while the dashboard runs.
  void runBackup();
  backupTimer = setInterval(() => void runBackup(), BACKUP_INTERVAL_MS);

  if (interactive) {
    process.stdout.write("\x1b[?25l\x1b[2J\x1b[3J\x1b[H"); // hide cursor, clear screen
    renderTimer = setInterval(() => render(state), 250);
    pm2Timer = setInterval(() => { fetchPm2(ssh).then((p) => { if (p) state.pm2 = p; }).catch(() => {}); refreshSysUsage(); refreshStats(); }, 5000);
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
        if (s === "\x1b[C") { state.chartIndex = (state.chartIndex + 1) % 4; render(state); return; } // → next chart
        if (s === "\x1b[D") { state.chartIndex = (state.chartIndex + 3) % 4; render(state); return; } // ← prev chart
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
//   npm run status -- --demo
function demo() {
  const state: State = {
    ip: "203.0.113.7", handle: "evvrbot", admins: "@alice, @bob", wallet: "0xA1b2C3d4E5f6A7b8C9d0E1f2A3b4C5d6E7f80910",
    stats: { mentions: 37, replies: 29, llmTurns: 84, spentUsd: 0.7345, warns: 1, errors: 0, earnedWeth: 0.0512, devWeth: 0.0123, spentUsdWindow: 96, inferenceUsdWindow: 1.2, earnedWethWindow: 0.004, rateWindowHours: 24,
      spentByType: { "x-api": 0.55, inference: 0.06, compute: 0.12 },
      chart: (() => { const sp: number[] = [], ew: number[] = []; let a = 0, b2 = 0; for (let i = 0; i < 60; i++) { a += 0.012; b2 += i > 15 ? 0.0009 : 0; sp.push(a); ew.push(b2); } const day = { spendUsd: sp, earnedWeth: ew, startMs: Date.now() - 5 * 3_600_000, endMs: Date.now() }; const all = { spendUsd: sp, earnedWeth: ew, startMs: Date.now() - 40 * 86_400_000, endMs: Date.now() }; const x: number[] = [], inf: number[] = [], c: number[] = [], ea: number[] = []; for (let i = 0; i < 24; i++) { x.push(i >= 12 ? 0.02 + (i % 3) * 0.005 : 0); inf.push(i >= 12 ? 0.003 : 0); c.push(i === 18 ? 0.06 : 0); ea.push(i >= 14 ? 0.000005 + (i % 4) * 0.000002 : 0); } const byType = { startMs: Date.now() - 23 * 3_600_000, xapi: x, inference: inf, compute: c, earned: ea }; return { day, all, byType }; })() },
    pm2: { status: "online", bootMs: Date.now() - 8_120_000, restarts: 2, mem: 149 * 1024 * 1024, cpu: 3 },
    specs: { cpu: "2", ram: "1.9Gi", disk: "25G", os: "Ubuntu 24.04.1 LTS" },
    balances: { token: 1_234_567n * 10n ** 18n, weth: 42_000_000_000_000_000n, eth: 3_500_000_000_000_000n, usdc: 1875_000_000n, symbol: "EVVR", decimals: 18, usdTotal: 2_104.37, ethUsd: 3000, usd: { token: 92.87, weth: 126, eth: 10.5, usdc: 1875 } },
    computeHours: 19.5,
    creditUsd: 4.21,
    sysCpu: 3, sysMemMb: 600, sysDiskUsed: "12G",
    scroll: 0, logRows: 0,
    confirm: null,
    chartIndex: 0,
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
    stats: { mentions: 0, replies: 0, llmTurns: 0, spentUsd: 0, warns: 0, errors: 0, earnedWeth: 0, devWeth: 0, spentUsdWindow: 12, inferenceUsdWindow: 1, earnedWethWindow: 0.001, rateWindowHours: 24, spentByType: { "x-api": 8, inference: 1, compute: 3 }, chart: { day: { spendUsd: Array.from({ length: 60 }, (_, i) => i * 0.2), earnedWeth: Array.from({ length: 60 }, (_, i) => i * 0.00005), startMs: Date.now() - 24 * 3_600_000, endMs: Date.now() }, all: { spendUsd: Array.from({ length: 60 }, (_, i) => i * 0.5), earnedWeth: Array.from({ length: 60 }, (_, i) => i * 0.0001), startMs: Date.now() - 40 * 86_400_000, endMs: Date.now() }, byType: { startMs: Date.now() - 23 * 3_600_000, xapi: Array.from({ length: 24 }, (_, i) => i >= 10 ? 0.02 : 0), inference: Array.from({ length: 24 }, (_, i) => i >= 10 ? 0.003 : 0), compute: Array.from({ length: 24 }, (_, i) => i === 16 ? 0.05 : 0), earned: Array.from({ length: 24 }, (_, i) => i >= 14 ? 0.000006 : 0) } } },
    pm2: { status: "online", bootMs: Date.now() - 945_000, restarts: 1, mem: 110 * 1024 * 1024, cpu: 0.4 },
    specs: { cpu: "1", ram: "951Mi", disk: "23G", os: "Ubuntu 22.04.5 LTS" }, scroll: 0, logRows: 0,
    balances: { token: 1_234_567n * 10n ** 18n, weth: 42_000_000_000_000_000n, eth: 3_500_000_000_000_000n, usdc: 1875_000_000n, symbol: "EVVR", decimals: 18, usdTotal: 2_104.37, ethUsd: 3000, usd: { token: 92.87, weth: 126, eth: 10.5, usdc: 1875 } },
    computeHours: 19.5, creditUsd: 4.21, sysCpu: 4, sysMemMb: 740, sysDiskUsed: "9.1G", confirm: null, chartIndex: 0,
    logs: Array.from({ length: 30 }, () => long),
  };
  const frame = buildFrame(state, cols, rows);
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
