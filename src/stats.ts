import { withSchema } from "./db.js";

// Stats ledger, owned by the always-on agent and backed by the shared SQLite DB
// (see db.ts) so it's cleanly queryable (by time, type, cumulative …) and sits
// alongside whatever other tables get added later.
//
//   events(id, ts, kind, type, usdc, weth, n)   one row per counted thing. `ts` is
//     ISO-8601, so date/hour bucketing and running-sum (cumulative) charts are plain
//     SQL. kinds: spend | earned | mention | reply | llm | warn | error.
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
  earnedWeth: number;
  // Trailing-window figures for the runway estimate (see status dashboard). The window
  // is the last RATE_WINDOW_MS, clamped to the agent's age. `spentUsdWindow` is total USD
  // spend; `inferenceUsdWindow` is the LLM (credit-funded) slice of it, so the USDC-funded
  // burn (x-api + compute) is the difference. `earnedWethWindow` is WETH (converted with
  // the live ETH price on the dashboard).
  spentUsdWindow: number;
  inferenceUsdWindow: number;
  earnedWethWindow: number;
  rateWindowHours: number;
  // Cumulative spend (USD) and earnings (WETH) over the last 24h, in CHART_BUCKETS evenly
  // spaced points (oldest→newest) for the dashboard's line chart. Earnings stay in WETH —
  // the dashboard converts with the live ETH price.
  chart: { spendUsd: number[]; earnedWeth: number[] };
};

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
  const prev = getMeta("last_earned_weth") ?? 0;
  if (weth > prev + 1e-12) insert({ kind: "earned", weth: weth - prev });
  setMeta("last_earned_weth", weth);
}

// All-time rolled-up totals, computed straight from the events table. Cheap with the
// kind/ts indexes; the dashboard polls this via the CLI.
export function summary(): Summary {
  const empty: Summary = {
    mentions: 0, replies: 0, llm: 0, warns: 0, errors: 0,
    spentUsd: 0, spentByType: { "x-api": 0, compute: 0, inference: 0 }, earnedWeth: 0,
    spentUsdWindow: 0, inferenceUsdWindow: 0, earnedWethWindow: 0, rateWindowHours: 0,
    chart: { spendUsd: [], earnedWeth: [] },
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
        COALESCE(SUM(usdc) FILTER (WHERE kind = 'spend'), 0)   AS spentUsd
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

    // Cumulative chart series over the window: bucket spend/earn events by time, then
    // running-sum so the lines grow left→right.
    const winStartMs = Date.now() - RATE_WINDOW_MS;
    const bucketMs = RATE_WINDOW_MS / CHART_BUCKETS;
    const spendUsd = new Array<number>(CHART_BUCKETS).fill(0);
    const earnedWeth = new Array<number>(CHART_BUCKETS).fill(0);
    const seriesRows = d.prepare(
      "SELECT ts, kind, usdc, weth FROM events WHERE ts >= ? AND kind IN ('spend','earned')",
    ).all(since) as Array<{ ts: string; kind: string; usdc: number | null; weth: number | null }>;
    for (const r of seriesRows) {
      let i = Math.floor((Date.parse(r.ts) - winStartMs) / bucketMs);
      if (i < 0) i = 0; else if (i >= CHART_BUCKETS) i = CHART_BUCKETS - 1;
      if (r.kind === "spend") spendUsd[i] += r.usdc ?? 0;
      else earnedWeth[i] += r.weth ?? 0;
    }
    for (let i = 1; i < CHART_BUCKETS; i++) { spendUsd[i] += spendUsd[i - 1]; earnedWeth[i] += earnedWeth[i - 1]; }

    return {
      mentions: agg.mentions, replies: agg.replies, llm: agg.llm, warns: agg.warns, errors: agg.errors,
      spentUsd: agg.spentUsd, spentByType,
      earnedWeth: getMeta("last_earned_weth") ?? 0,
      spentUsdWindow: win.spentUsdWindow, inferenceUsdWindow: win.inferenceUsdWindow,
      earnedWethWindow: win.earnedWethWindow, rateWindowHours,
      chart: { spendUsd, earnedWeth },
    };
  } catch {
    return empty;
  }
}
