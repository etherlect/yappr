// Chart rendering for the status dashboard (`cli/status.ts`): the cumulative
// spent/earned line charts (asciichart) and the hand-rolled hourly stacked bar
// charts, plus their shared colors, scales and the adaptive time axis. Pure
// string-building — no I/O, no dashboard state — so it's testable in isolation
// (see scripts/chart-equivalence.ts for the bar-renderer fuzz check).

import * as asciichart from "asciichart";
import { dim, chartRgb } from "./ui.js";
import { envNumber } from "../util.js";

// Chart colors come from the current ui.ts theme (chartRgb()) as truecolor RGB
// triples — used by the stacked bar charts (the boundary cell needs an fg AND a
// bg color), the legends, and (escape-wrapped) the asciichart line charts.
// Resolved lazily per render, so the TUI's live theme toggle applies here too.
export const SPENT_RGB = () => chartRgb().spent;
export const EARN_RGB = () => chartRgb().earn;

// Plot rows for the spent/earned line charts. asciichart draws height+1 rows, so 8 → 9
// rows + 1 axis = 10 content lines, matching the hourly bar chart (H=9 bars + 1 axis).
// Override with STATUS_CHART_HEIGHT. (1-decimal y labels keep the rows distinct.)
const LINE_CHART_HEIGHT = Math.max(3, envNumber("STATUS_CHART_HEIGHT", 8));

// Expense-category colors as truecolor RGB triples, from the current theme.
// Shared by the bar chart and its legend.
export const CAT_RGB = () => ({ xapi: chartRgb().xapi, inference: chartRgb().inference, compute: chartRgb().compute, x402: chartRgb().x402 });
export const catColor = (rgb: string) => (s: string) => `\x1b[38;2;${rgb}m${s}\x1b[0m`;

export type ChartSeries = { spendUsd: number[]; earnedWeth: number[]; startMs: number; endMs: number };

export const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const LABEL_OFFSET = 9; // asciichart's y-axis label column width (7-char label + " " + axis)

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
export function renderLineChart(cols: number, series: ChartSeries, ethUsd: number | null, windowStart: number, windowEnd: number): string[] {
  const w = Math.max(8, cols - 13);
  const winSpan = windowEnd - windowStart;
  const dataCols = winSpan > 0 ? Math.max(2, Math.min(w, Math.round((w * (series.endMs - windowStart)) / winSpan))) : w;
  const spend = fitSeries(series.spendUsd, dataCols);
  const earn = ethUsd != null ? fitSeries(series.earnedWeth.map((v) => v * ethUsd), dataCols) : null;
  const seriesArr = earn && earn.length === spend.length ? [spend, earn] : [spend];
  const spendEsc = `\x1b[38;2;${SPENT_RGB()}m`, earnEsc = `\x1b[38;2;${EARN_RGB()}m`;
  const colors = seriesArr.length === 2 ? [spendEsc, earnEsc] : [spendEsc];
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

// Per-hour spend stacked by type: x-api / inference / compute / x402, bottom-up.
export function renderHourlyBars(cols: number, byType: { startMs: number; xapi: number[]; inference: number[]; compute: number[]; x402: number[] }): string[] {
  const cat = CAT_RGB();
  return renderStackedBars(cols, byType.startMs, [
    { values: byType.xapi, rgb: cat.xapi },
    { values: byType.inference, rgb: cat.inference },
    { values: byType.compute, rgb: cat.compute },
    { values: byType.x402, rgb: cat.x402 },
  ]);
}

// Per-hour spent (red, bottom) vs earned (cyan, stacked on top), both in USD —
// earned is the WETH series converted at the live ETH price.
export function renderHourlySpentEarned(cols: number, d: { startMs: number; xapi: number[]; inference: number[]; compute: number[]; x402: number[]; earned: number[] }, ethUsd: number | null): string[] {
  const N = 24;
  const spent = Array.from({ length: N }, (_, i) => (d.xapi[i] ?? 0) + (d.inference[i] ?? 0) + (d.compute[i] ?? 0) + (d.x402[i] ?? 0));
  const earned = Array.from({ length: N }, (_, i) => (d.earned[i] ?? 0) * (ethUsd ?? 0));
  return renderStackedBars(cols, d.startMs, [
    { values: spent, rgb: SPENT_RGB() },
    { values: earned, rgb: EARN_RGB() },
  ]);
}
