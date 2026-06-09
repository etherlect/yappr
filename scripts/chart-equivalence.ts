// Throwaway check: the deduplicated renderStackedBars must produce byte-identical
// output to the two old hand-rolled renderers, across randomized inputs.
// Run: npx tsx scripts/chart-equivalence.ts

const CAT_RGB = { xapi: "0;188;212", inference: "215;119;87", compute: "234;179;8" } as const;
const SPENT_RGB = "224;71;71", EARN_RGB = "0;188;212";

// Stand-ins for the real helpers (identical on both sides, so equivalence holds).
const fmtMoney = (x: number) => `$${x.toFixed(1)}`;
const dim = (s: string) => s;
const adaptiveTimeAxis = (labelW: number, plotW: number, a: number, b: number) => `axis ${labelW} ${plotW} ${a} ${b}`;

// ── OLD implementations (verbatim from git HEAD, helpers substituted) ──
function oldHourlyBars(cols: number, byType: { startMs: number; xapi: number[]; inference: number[]; compute: number[] }): string[] {
  const N = 24, H = 9, EIGHTH = 8, SUB = H * EIGHTH, labelW = 8, HOUR = 3_600_000;
  const LOWER = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
  const plotW = Math.max(N, cols - 4 - labelW);
  const slot = plotW / N;
  const totals = Array.from({ length: N }, (_, i) => (byType.xapi[i] ?? 0) + (byType.inference[i] ?? 0) + (byType.compute[i] ?? 0));
  const max = Math.max(...totals, 1e-9);
  const seg = totals.map((tot, i) => {
    const tr = Math.round((tot / max) * SUB);
    let xr = tot > 0 ? Math.round(((byType.xapi[i] ?? 0) / tot) * tr) : 0;
    let ir = tot > 0 ? Math.round(((byType.inference[i] ?? 0) / tot) * tr) : 0;
    let cr = tr - xr - ir;
    if (cr < 0) { ir += cr; cr = 0; if (ir < 0) { xr += ir; ir = 0; } }
    return { xr, ir, tr };
  });
  const subColor = (sg: { xr: number; ir: number; tr: number }, sub: number): string | null =>
    sub < sg.xr ? CAT_RGB.xapi : sub < sg.xr + sg.ir ? CAT_RGB.inference : sub < sg.tr ? CAT_RGB.compute : null;
  const cellAt = (sg: { xr: number; ir: number; tr: number }, base: number): string => {
    const c1 = subColor(sg, base);
    if (!c1) return " ";
    let h1 = 1;
    while (h1 < EIGHTH && subColor(sg, base + h1) === c1) h1++;
    const c2 = h1 < EIGHTH ? subColor(sg, base + h1) : null;
    return c2 ? `\x1b[38;2;${c1};48;2;${c2}m${LOWER[h1]}\x1b[0m` : `\x1b[38;2;${c1}m${LOWER[h1]}\x1b[0m`;
  };
  const barW = Math.max(1, Math.round(slot * 0.5));
  const lines: string[] = [];
  for (let r = 0; r < H; r++) {
    const base = (H - 1 - r) * EIGHTH;
    const row = new Array<string>(plotW).fill(" ");
    for (let hour = 0; hour < N; hour++) {
      const ch = cellAt(seg[hour], base);
      if (ch === " ") continue;
      const colStart = Math.round(hour * slot + (slot - barW) / 2);
      for (let w = 0; w < barW && colStart + w < plotW; w++) row[colStart + w] = ch;
    }
    const ylab = r === H - 1 ? "$0" : fmtMoney((max * (H - r)) / H);
    lines.push(ylab.padEnd(labelW - 1) + "│" + row.join(""));
  }
  lines.push(dim(adaptiveTimeAxis(labelW, plotW, byType.startMs, byType.startMs + N * HOUR)));
  return lines;
}

function oldHourlySpentEarned(cols: number, d: { startMs: number; xapi: number[]; inference: number[]; compute: number[]; earned: number[] }, ethUsd: number | null): string[] {
  const N = 24, H = 9, EIGHTH = 8, SUB = H * EIGHTH, labelW = 8, HOUR = 3_600_000;
  const LOWER = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
  const plotW = Math.max(N, cols - 4 - labelW);
  const slot = plotW / N;
  const spent = Array.from({ length: N }, (_, i) => (d.xapi[i] ?? 0) + (d.inference[i] ?? 0) + (d.compute[i] ?? 0));
  const earned = Array.from({ length: N }, (_, i) => (d.earned[i] ?? 0) * (ethUsd ?? 0));
  const totals = spent.map((s, i) => s + earned[i]);
  const max = Math.max(...totals, 1e-9);
  const seg = totals.map((tot, i) => {
    const tr = Math.round((tot / max) * SUB);
    let sr = tot > 0 ? Math.round((spent[i] / tot) * tr) : 0;
    if (sr > tr) sr = tr;
    return { sr, tr };
  });
  const subColor = (sg: { sr: number; tr: number }, sub: number): string | null =>
    sub < sg.sr ? SPENT_RGB : sub < sg.tr ? EARN_RGB : null;
  const cellAt = (sg: { sr: number; tr: number }, base: number): string => {
    const c1 = subColor(sg, base);
    if (!c1) return " ";
    let h1 = 1;
    while (h1 < EIGHTH && subColor(sg, base + h1) === c1) h1++;
    const c2 = h1 < EIGHTH ? subColor(sg, base + h1) : null;
    return c2 ? `\x1b[38;2;${c1};48;2;${c2}m${LOWER[h1]}\x1b[0m` : `\x1b[38;2;${c1}m${LOWER[h1]}\x1b[0m`;
  };
  const barW = Math.max(1, Math.round(slot * 0.5));
  const lines: string[] = [];
  for (let r = 0; r < H; r++) {
    const base = (H - 1 - r) * EIGHTH;
    const row = new Array<string>(plotW).fill(" ");
    for (let h = 0; h < N; h++) {
      const ch = cellAt(seg[h], base);
      if (ch === " ") continue;
      const colStart = Math.round(h * slot + (slot - barW) / 2);
      for (let w = 0; w < barW && colStart + w < plotW; w++) row[colStart + w] = ch;
    }
    const ylab = r === H - 1 ? "$0" : fmtMoney((max * (H - r)) / H);
    lines.push(ylab.padEnd(labelW - 1) + "│" + row.join(""));
  }
  lines.push(dim(adaptiveTimeAxis(labelW, plotW, d.startMs, d.startMs + N * HOUR)));
  return lines;
}

// ── NEW implementation (verbatim from src/cli/status.ts, helpers substituted) ──
function renderStackedBars(cols: number, startMs: number, layers: Array<{ values: number[]; rgb: string }>): string[] {
  const N = 24, H = 9, EIGHTH = 8, SUB = H * EIGHTH, labelW = 8, HOUR = 3_600_000;
  const LOWER = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
  const plotW = Math.max(N, cols - 4 - labelW);
  const slot = plotW / N;
  const totals = Array.from({ length: N }, (_, i) => layers.reduce((sum, l) => sum + (l.values[i] ?? 0), 0));
  const max = Math.max(...totals, 1e-9);
  const seg = totals.map((tot, i) => {
    const tr = Math.round((tot / max) * SUB);
    const parts = layers.map((l, k) =>
      k === layers.length - 1 ? 0 : tot > 0 ? Math.round(((l.values[i] ?? 0) / tot) * tr) : 0);
    parts[parts.length - 1] = tr - parts.reduce((a, b) => a + b, 0);
    for (let k = parts.length - 1; k > 0; k--) {
      if (parts[k] < 0) { parts[k - 1] += parts[k]; parts[k] = 0; }
    }
    const bounds: number[] = [];
    parts.reduce((acc, p) => { bounds.push(acc + p); return acc + p; }, 0);
    return { bounds, tr };
  });
  const subColor = (sg: { bounds: number[]; tr: number }, sub: number): string | null => {
    if (sub >= sg.tr) return null;
    for (let k = 0; k < sg.bounds.length; k++) if (sub < sg.bounds[k]) return layers[k].rgb;
    return null;
  };
  const cellAt = (sg: { bounds: number[]; tr: number }, base: number): string => {
    const c1 = subColor(sg, base);
    if (!c1) return " ";
    let h1 = 1;
    while (h1 < EIGHTH && subColor(sg, base + h1) === c1) h1++;
    const c2 = h1 < EIGHTH ? subColor(sg, base + h1) : null;
    return c2 ? `\x1b[38;2;${c1};48;2;${c2}m${LOWER[h1]}\x1b[0m` : `\x1b[38;2;${c1}m${LOWER[h1]}\x1b[0m`;
  };
  const barW = Math.max(1, Math.round(slot * 0.5));
  const lines: string[] = [];
  for (let r = 0; r < H; r++) {
    const base = (H - 1 - r) * EIGHTH;
    const row = new Array<string>(plotW).fill(" ");
    for (let hour = 0; hour < N; hour++) {
      const ch = cellAt(seg[hour], base);
      if (ch === " ") continue;
      const colStart = Math.round(hour * slot + (slot - barW) / 2);
      for (let w = 0; w < barW && colStart + w < plotW; w++) row[colStart + w] = ch;
    }
    const ylab = r === H - 1 ? "$0" : fmtMoney((max * (H - r)) / H);
    lines.push(ylab.padEnd(labelW - 1) + "│" + row.join(""));
  }
  lines.push(dim(adaptiveTimeAxis(labelW, plotW, startMs, startMs + N * HOUR)));
  return lines;
}

const newHourlyBars = (cols: number, byType: { startMs: number; xapi: number[]; inference: number[]; compute: number[] }) =>
  renderStackedBars(cols, byType.startMs, [
    { values: byType.xapi, rgb: CAT_RGB.xapi },
    { values: byType.inference, rgb: CAT_RGB.inference },
    { values: byType.compute, rgb: CAT_RGB.compute },
  ]);

const newHourlySpentEarned = (cols: number, d: { startMs: number; xapi: number[]; inference: number[]; compute: number[]; earned: number[] }, ethUsd: number | null) => {
  const N = 24;
  const spent = Array.from({ length: N }, (_, i) => (d.xapi[i] ?? 0) + (d.inference[i] ?? 0) + (d.compute[i] ?? 0));
  const earned = Array.from({ length: N }, (_, i) => (d.earned[i] ?? 0) * (ethUsd ?? 0));
  return renderStackedBars(cols, d.startMs, [
    { values: spent, rgb: SPENT_RGB },
    { values: earned, rgb: EARN_RGB },
  ]);
};

// ── fuzz ──
let failures = 0;
const rand = (max: number) => Math.random() * max;
for (let trial = 0; trial < 5000; trial++) {
  const cols = 48 + Math.floor(rand(150));
  const startMs = Date.now() - Math.floor(rand(1e9));
  const mk = (sparsity: number, scale: number) =>
    Array.from({ length: 24 }, () => (Math.random() < sparsity ? 0 : rand(scale)));
  const byType = {
    startMs,
    xapi: mk(0.4, 0.1),
    inference: mk(0.5, 0.02),
    compute: mk(0.9, 0.5),
    earned: mk(0.6, 0.0001),
  };
  const ethUsd = Math.random() < 0.2 ? null : 1000 + rand(4000);

  const a1 = oldHourlyBars(cols, byType).join("\n");
  const b1 = newHourlyBars(cols, byType).join("\n");
  if (a1 !== b1) { failures++; if (failures < 3) console.log(`EXPENSES mismatch (trial ${trial}, cols ${cols})`); }

  const a2 = oldHourlySpentEarned(cols, byType, ethUsd).join("\n");
  const b2 = newHourlySpentEarned(cols, byType, ethUsd).join("\n");
  if (a2 !== b2) { failures++; if (failures < 3) console.log(`SPENT/EARNED mismatch (trial ${trial}, cols ${cols})`); }
}
// All-zero edge case
const zeros = { startMs: Date.now(), xapi: new Array(24).fill(0), inference: new Array(24).fill(0), compute: new Array(24).fill(0), earned: new Array(24).fill(0) };
if (oldHourlyBars(100, zeros).join("\n") !== newHourlyBars(100, zeros).join("\n")) { failures++; console.log("zero-case EXPENSES mismatch"); }
if (oldHourlySpentEarned(100, zeros, 3000).join("\n") !== newHourlySpentEarned(100, zeros, 3000).join("\n")) { failures++; console.log("zero-case SPENT/EARNED mismatch"); }

console.log(failures === 0 ? "✓ 5000 fuzz trials + edge cases: outputs byte-identical" : `✗ ${failures} mismatches`);
