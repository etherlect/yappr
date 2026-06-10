import { withSchema } from "./db.js";

// Stats ledger, owned by the always-on agent and backed by the shared SQLite DB
// (see db.ts) so it's cleanly queryable (by time, type, cumulative …) and sits
// alongside whatever other tables get added later.
//
//   events(id, ts, kind, type, usdc, weth, n)   one row per counted thing. `ts` is
//     ISO-8601, so date/hour bucketing and running-sum (cumulative) charts are plain
//     SQL. kinds: spend | earned | dev | mention | reply | llm | warn | error.
//   meta(key, value)                            gauges/bookkeeping that aren't events:
//     last_earned_weth (earnings baseline) — used to turn an absolute cumulative
//     reading into the increment appended as an `earned` event.
//
// All writes are best-effort: stats must never throw into the agent's hot paths.

export type SpendType = "x-api" | "compute" | "inference";

export type Summary = {
  mentions: number;
  replies: number;
  llm: number;
  warns: number;
  errors: number;
  spentUsd: number;
  spentByType: Record<SpendType, number>;
  // All-time gross creator fees (WETH from Bankr). The dev cut is part of this
  // revenue, not subtracted; `devWeth` below breaks out how much went to the dev.
  earnedWeth: number;
  // All-time WETH paid out to the dev address (dev fee), cumulative — a breakdown of
  // `earnedWeth` (already included in it), surfaced on its own as "Dev rev".
  devWeth: number;
  // Trailing-window figures for the runway estimate (see status dashboard). The window
  // is the last RATE_WINDOW_MS, clamped to the agent's age. `spentUsdWindow` is total USD
  // spend; `inferenceUsdWindow` is the LLM (credit-funded) slice of it, so the USDC-funded
  // burn (x-api + compute) is the difference. `earnedWethWindow` is gross WETH (converted
  // with the live ETH price on the dashboard).
  spentUsdWindow: number;
  inferenceUsdWindow: number;
  earnedWethWindow: number;
  rateWindowHours: number;
  // Cumulative spend (USD) + earnings (WETH) series for the dashboard's line charts, each
  // CHART_BUCKETS evenly spaced points (oldest→newest) over [startMs, endMs]. `day` is the
  // last 24h (from max(now-24h, firstEvent)); `all` is the whole history (from the first
  // event). Earnings stay in WETH; the dashboard converts with the live ETH price and uses
  // startMs/endMs to label the x-axis.
  chart: {
    day: { spendUsd: number[]; earnedWeth: number[]; startMs: number; endMs: number };
    all: { spendUsd: number[]; earnedWeth: number[]; startMs: number; endMs: number };
    // Per-hour spend by type over the last 24h (24 buckets, clock-aligned, NOT cumulative)
    // for the stacked bar chart. startMs is the first bucket's (clock-hour) start.
    byType: { startMs: number; xapi: number[]; inference: number[]; compute: number[]; earned: number[] };
  };
};

type ChartSeries = { spendUsd: number[]; earnedWeth: number[]; startMs: number; endMs: number };

// Trailing window used to estimate the current burn/earn rate for runway (24h).
const RATE_WINDOW_MS = 24 * 60 * 60 * 1000;
// Resolution of the dashboard chart series (points across the 24h window).
const CHART_BUCKETS = 120;

// This feature's tables (created on first use via the shared connection).
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS events (
    id    INTEGER PRIMARY KEY,
    ts    TEXT    NOT NULL,
    kind  TEXT    NOT NULL,
    type  TEXT,
    usdc  REAL,
    weth  REAL,
    n     INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_events_ts   ON events(ts);
  CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind);
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value REAL);
`;
const conn = () => withSchema(SCHEMA);

const now = () => new Date().toISOString();

type EventRow = { kind: string; type?: SpendType | null; usdc?: number | null; weth?: number | null; n?: number | null };

function insert(ev: EventRow): void {
  const d = conn();
  if (!d) return;
  try {
    d.prepare("INSERT INTO events (ts, kind, type, usdc, weth, n) VALUES (?, ?, ?, ?, ?, ?)")
      .run(now(), ev.kind, ev.type ?? null, ev.usdc ?? null, ev.weth ?? null, ev.n ?? null);
  } catch { /* best-effort */ }
}

function getMeta(key: string): number | undefined {
  const d = conn();
  if (!d) return undefined;
  try {
    const row = d.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: number } | undefined;
    return row?.value;
  } catch {
    return undefined;
  }
}

function setMeta(key: string, value: number): void {
  const d = conn();
  if (!d) return;
  try {
    d.prepare("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  } catch { /* best-effort */ }
}

export function recordSpend(type: SpendType, usdc: number): void {
  if (!Number.isFinite(usdc) || usdc <= 0) return;
  insert({ kind: "spend", type, usdc });
}

export function recordMention(n: number): void {
  if (!(n > 0)) return;
  insert({ kind: "mention", n });
}

export function recordReply(): void { insert({ kind: "reply" }); }
export function recordLlm(): void { insert({ kind: "llm" }); }
export function recordWarn(): void { insert({ kind: "warn" }); }
export function recordError(): void { insert({ kind: "error" }); }

// Inference spend is recorded per-request from token usage × per-model pricing (see
// llm/index.ts: recordSpend("inference", …)), so there's no credit-balance polling
// here. The live credit balance is still shown on the dashboard as the remaining
// budget, but it's read directly from the gateway, not tracked as spend.

// All-time creator fees earned (WETH), reported by Bankr as a cumulative total.
// Polled on a short timer, so treat it as a gauge: always refresh the stored total,
// but only append an `earned` event (the increment) when it actually grows — keeping
// the events table a clean, sliceable record of real earnings, not poll noise.
export function recordEarned(weth: number): void {
  if (!Number.isFinite(weth) || weth < 0) return;
  const prev = getMeta("last_earned_weth");
  // First observation ever (fresh DB, no restored backup): just set the baseline.
  // Booking an event here would drop the token's entire pre-agent fee history into
  // the trailing window as one giant "earned" spike, faking the windowed metrics
  // ("Sustainable: yes") and charts for a day. All-time earned still shows in full
  // — summary() reads it from this gauge, not from summing events.
  if (prev === undefined) { setMeta("last_earned_weth", weth); return; }
  if (weth > prev + 1e-12) insert({ kind: "earned", weth: weth - prev });
  setMeta("last_earned_weth", weth);
}

// WETH paid out to the dev address this treasury cycle (the dev fee). Each payment is its
// own `dev` event (an increment), so summing them gives all-time dev revenue.
export function recordDevWeth(weth: number): void {
  if (!Number.isFinite(weth) || weth <= 0) return;
  insert({ kind: "dev", weth });
}

type Conn = NonNullable<ReturnType<typeof conn>>;

// Build a cumulative spend/earn chart series over [startMs, endMs] in CHART_BUCKETS evenly
// spaced points. Bucketing is done in SQL (one grouped row per bucket via unixepoch), so it
// stays cheap no matter how many events the range covers — then we running-sum in JS.
function buildSeries(d: Conn, startMs: number, endMs: number): ChartSeries {
  const spendUsd = new Array<number>(CHART_BUCKETS).fill(0);
  const earnedWeth = new Array<number>(CHART_BUCKETS).fill(0);
  const span = endMs - startMs;
  if (span > 0) {
    const startSec = Math.floor(startMs / 1000);
    const bucketSec = span / 1000 / CHART_BUCKETS;
    const rows = d.prepare(`
      SELECT CAST((unixepoch(ts) - ?) / ? AS INTEGER) AS b,
             COALESCE(SUM(usdc) FILTER (WHERE kind = 'spend'),  0) AS spend,
             COALESCE(SUM(weth) FILTER (WHERE kind = 'earned'), 0) AS earned
      FROM events
      WHERE ts >= ? AND kind IN ('spend','earned')
      GROUP BY b
    `).all(startSec, bucketSec, new Date(startMs).toISOString()) as Array<{ b: number; spend: number; earned: number }>;
    for (const r of rows) {
      const i = Math.min(CHART_BUCKETS - 1, Math.max(0, r.b));
      spendUsd[i] += r.spend || 0;
      earnedWeth[i] += r.earned || 0;
    }
    for (let i = 1; i < CHART_BUCKETS; i++) { spendUsd[i] += spendUsd[i - 1]; earnedWeth[i] += earnedWeth[i - 1]; }
  }
  return { spendUsd, earnedWeth, startMs, endMs };
}

// Per-hour spend by type AND per-hour earnings over the 24 clock-hours ending with the
// current hour. Returns 24 buckets each (spend USD by type; earned WETH), not cumulative,
// plus the first bucket's (clock-aligned) start. For the hourly bar charts. Bucketed in SQL.
function buildHourlyByType(d: Conn): { startMs: number; xapi: number[]; inference: number[]; compute: number[]; earned: number[] } {
  const N = 24, HOUR = 3_600_000;
  const startMs = Math.floor(Date.now() / HOUR) * HOUR - (N - 1) * HOUR; // 24 hours ending this hour
  const xapi = new Array<number>(N).fill(0), inference = new Array<number>(N).fill(0), compute = new Array<number>(N).fill(0);
  const earned = new Array<number>(N).fill(0);
  const startSec = startMs / 1000;
  const startIso = new Date(startMs).toISOString(), endIso = new Date(startMs + N * HOUR).toISOString();
  const rows = d.prepare(`
    SELECT CAST((unixepoch(ts) - ?) / 3600 AS INTEGER) AS b, type, COALESCE(SUM(usdc), 0) AS u
    FROM events
    WHERE kind = 'spend' AND ts >= ? AND ts < ?
    GROUP BY b, type
  `).all(startSec, startIso, endIso) as Array<{ b: number; type: string; u: number }>;
  for (const r of rows) {
    if (r.b < 0 || r.b >= N) continue;
    if (r.type === "x-api") xapi[r.b] += r.u || 0;
    else if (r.type === "inference") inference[r.b] += r.u || 0;
    else if (r.type === "compute") compute[r.b] += r.u || 0;
  }
  const erows = d.prepare(`
    SELECT CAST((unixepoch(ts) - ?) / 3600 AS INTEGER) AS b, COALESCE(SUM(weth), 0) AS w
    FROM events
    WHERE kind = 'earned' AND ts >= ? AND ts < ?
    GROUP BY b
  `).all(startSec, startIso, endIso) as Array<{ b: number; w: number }>;
  for (const r of erows) if (r.b >= 0 && r.b < N) earned[r.b] += r.w || 0;
  return { startMs, xapi, inference, compute, earned };
}

// All-time rolled-up totals, computed straight from the events table. Cheap with the
// kind/ts indexes; the dashboard polls this via the CLI.
export function summary(): Summary {
  const empty: Summary = {
    mentions: 0, replies: 0, llm: 0, warns: 0, errors: 0,
    spentUsd: 0, spentByType: { "x-api": 0, compute: 0, inference: 0 }, earnedWeth: 0, devWeth: 0,
    spentUsdWindow: 0, inferenceUsdWindow: 0, earnedWethWindow: 0, rateWindowHours: 0,
    chart: {
      day: { spendUsd: [], earnedWeth: [], startMs: 0, endMs: 0 },
      all: { spendUsd: [], earnedWeth: [], startMs: 0, endMs: 0 },
      byType: { startMs: 0, xapi: [], inference: [], compute: [], earned: [] },
    },
  };
  const d = conn();
  if (!d) return empty;
  try {
    const agg = d.prepare(`
      SELECT
        COALESCE(SUM(n)    FILTER (WHERE kind = 'mention'), 0) AS mentions,
        COUNT(*)           FILTER (WHERE kind = 'reply')       AS replies,
        COUNT(*)           FILTER (WHERE kind = 'llm')         AS llm,
        COUNT(*)           FILTER (WHERE kind = 'warn')        AS warns,
        COUNT(*)           FILTER (WHERE kind = 'error')       AS errors,
        COALESCE(SUM(usdc) FILTER (WHERE kind = 'spend'), 0)   AS spentUsd,
        COALESCE(SUM(weth) FILTER (WHERE kind = 'dev'),   0)   AS devWeth
      FROM events
    `).get() as Record<string, number>;
    const spentByType: Record<SpendType, number> = { "x-api": 0, compute: 0, inference: 0 };
    const rows = d.prepare("SELECT type, COALESCE(SUM(usdc), 0) AS u FROM events WHERE kind = 'spend' GROUP BY type").all() as Array<{ type: SpendType | null; u: number }>;
    for (const r of rows) if (r.type && r.type in spentByType) spentByType[r.type] = r.u;

    // Burn/earn over the trailing window for the runway estimate. The divisor is the
    // window length, but never longer than the agent's age (first event → now), so a
    // young agent's rate isn't diluted by counting hours it wasn't running.
    const since = new Date(Date.now() - RATE_WINDOW_MS).toISOString();
    const win = d.prepare(`
      SELECT
        COALESCE(SUM(usdc) FILTER (WHERE kind = 'spend'),                       0) AS spentUsdWindow,
        COALESCE(SUM(usdc) FILTER (WHERE kind = 'spend' AND type = 'inference'), 0) AS inferenceUsdWindow,
        COALESCE(SUM(weth) FILTER (WHERE kind = 'earned'),                      0) AS earnedWethWindow
      FROM events WHERE ts >= ?
    `).get(since) as { spentUsdWindow: number; inferenceUsdWindow: number; earnedWethWindow: number };
    const firstTs = (d.prepare("SELECT MIN(ts) AS t FROM events").get() as { t: string | null }).t;
    const startMs = firstTs ? Math.max(Date.now() - RATE_WINDOW_MS, Date.parse(firstTs)) : Date.now();
    const rateWindowHours = Math.max(0, (Date.now() - startMs) / 3_600_000);

    // Chart series for the dashboard: a 24h view (`day`, from startMs = max(now-24h,
    // firstEvent)) and a whole-history view (`all`, from the first event) — both through now.
    const chartNow = Date.now();
    const firstDataMs = firstTs ? Date.parse(firstTs) : chartNow;
    const day = buildSeries(d, startMs, chartNow);
    const all = buildSeries(d, firstDataMs, chartNow);
    const byType = buildHourlyByType(d);

    // `earnedWeth`/`earnedWethWindow` are GROSS creator fees (the dev cut is part of
    // this revenue, not subtracted). `devWeth` is surfaced separately as a breakdown
    // ("Dev rev") of how much of that gross was routed to the dev address.
    return {
      mentions: agg.mentions, replies: agg.replies, llm: agg.llm, warns: agg.warns, errors: agg.errors,
      spentUsd: agg.spentUsd, spentByType,
      earnedWeth: getMeta("last_earned_weth") ?? 0, devWeth: agg.devWeth,
      spentUsdWindow: win.spentUsdWindow, inferenceUsdWindow: win.inferenceUsdWindow,
      earnedWethWindow: win.earnedWethWindow, rateWindowHours,
      chart: { day, all, byType },
    };
  } catch {
    return empty;
  }
}
