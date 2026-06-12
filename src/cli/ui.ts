// Shared terminal styling + box/layout primitives for the CLI scripts (deploy,
// status), so both speak the same visual language: dim-label kv rows and
// rounded-border panels with the title in the top edge.

import stringWidth from "string-width";
import cliTruncate from "cli-truncate";

// ─── theme ──────────────────────────────────────────────────────────────────
// Two Base-blue palettes: "dark" (pale blues for dark backgrounds) and "light"
// (deep blues readable on white). All color helpers read the CURRENT palette
// lazily, so the status TUI can switch live (the `t` key) — initial theme from
// STATUS_THEME=dark|light. Truecolor RGB everywhere (never 16-color codes, which
// terminal themes remap arbitrarily).

export type ThemeName = "dark" | "light";
type Palette = {
  text: string; green: string; yellow: string; red: string; cyan: string;
  accent: string; border: string;
  chart: { spent: string; earn: string; xapi: string; inference: string; compute: string };
};

const THEMES: Record<ThemeName, Palette> = {
  dark: {
    text: "143;191;255", green: "77;139;255", yellow: "102;163;255", red: "0;82;255",
    cyan: "143;191;255", accent: "51;116;255", border: "0;82;255",
    chart: { spent: "0;82;255", earn: "143;191;255", xapi: "143;191;255", inference: "77;139;255", compute: "38;99;255" },
  },
  light: {
    text: "30;58;138", green: "0;82;255", yellow: "59;130;246", red: "30;64;175",
    cyan: "37;99;235", accent: "29;78;216", border: "0;82;255",
    chart: { spent: "30;58;138", earn: "59;130;246", xapi: "59;130;246", inference: "0;82;255", compute: "147;180;255" },
  },
};

let _name: ThemeName = process.env.STATUS_THEME === "light" ? "light" : "dark";
let _p: Palette = THEMES[_name];
export const themeName = (): ThemeName => _name;
export function setTheme(name: ThemeName): void { _name = name; _p = THEMES[name]; }
export function toggleTheme(): ThemeName { setTheme(_name === "dark" ? "light" : "dark"); return _name; }
// Chart RGB triples for the current theme (charts need raw triples, not helpers,
// for the half-block fg+bg cells).
export const chartRgb = () => _p.chart;

// COLORFGBG fallback ("15;0" = light fg on dark bg): last field is the bg's
// 16-color index — 7/15 are light backgrounds. Set by rxvt/konsole/some iTerm.
function themeFromColorFgBg(): ThemeName | null {
  const parts = (process.env.COLORFGBG ?? "").split(";");
  const bg = Number(parts[parts.length - 1]);
  if (!Number.isFinite(bg) || parts.length < 2) return null;
  return bg === 7 || bg === 15 ? "light" : "dark";
}

// Ask the terminal for its background color (OSC 11 query; answered by iTerm2,
// Terminal.app, kitty, alacritty, wezterm, …) and classify by luminance. Falls
// back to COLORFGBG, then null (caller keeps the default) when the terminal
// stays silent past the timeout. Briefly takes stdin raw to read the reply —
// run BEFORE the dashboard's own key handling is attached.
export function detectTerminalTheme(timeoutMs = 250): Promise<ThemeName | null> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) return Promise.resolve(themeFromColorFgBg());
  return new Promise((resolve) => {
    const stdin = process.stdin;
    let buf = "";
    const done = (v: ThemeName | null) => {
      clearTimeout(timer);
      stdin.removeListener("data", onData);
      try { stdin.setRawMode(false); } catch { /* ignore */ }
      stdin.pause();
      resolve(v);
    };
    const onData = (d: Buffer) => {
      buf += d.toString("utf8");
      // Reply: ESC ] 11 ; rgb:RRRR/GGGG/BBBB (components are 1-4 hex digits per
      // channel; the leading 2 digits carry the top 8 bits we care about).
      const m = buf.match(/\]11;rgb:([0-9a-f]+)\/([0-9a-f]+)\/([0-9a-f]+)/i);
      if (!m) return;
      const [r, g, b] = [m[1], m[2], m[3]].map((s) => parseInt(s.padEnd(2, s).slice(0, 2), 16) / 255);
      const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      done(luminance > 0.5 ? "light" : "dark");
    };
    const timer = setTimeout(() => done(themeFromColorFgBg()), timeoutMs);
    try { stdin.setRawMode(true); } catch { done(themeFromColorFgBg()); return; }
    stdin.resume();
    stdin.on("data", onData);
    process.stdout.write("\x1b]11;?\x1b\\");
  });
}

export const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
export const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
export const green = (s: string) => `\x1b[38;2;${_p.green}m${s}\x1b[0m`;
export const yellow = (s: string) => `\x1b[38;2;${_p.yellow}m${s}\x1b[0m`;
export const red = (s: string) => `\x1b[38;2;${_p.red}m${s}\x1b[0m`;
export const cyan = (s: string) => `\x1b[38;2;${_p.cyan}m${s}\x1b[0m`;
export const accent = (s: string) => `\x1b[38;2;${_p.accent}m${s}\x1b[0m`;
export const border = (s: string) => `\x1b[38;2;${_p.border}m${s}\x1b[0m`; // box borders — Base blue (#0052FF)

// Default color for otherwise-uncolored text. Without this, plain text renders
// in the terminal theme's default foreground (green, white, whatever the user
// has) — applying it at render time keeps the whole frame on-palette. Re-armed
// after every reset so it acts as the baseline without overriding explicit colors.
export const themeLine = (l: string) => {
  const t = `\x1b[38;2;${_p.text}m`;
  return t + l.replaceAll("\x1b[0m", "\x1b[0m" + t) + "\x1b[0m";
};

// ─── layout primitives (ANSI- and wide-char-aware via string-width) ────────────

// Fit a (possibly colored) string to an exact display width: pad with spaces or
// truncate with an ellipsis, preserving ANSI codes.
export function fit(s: string, width: number): string {
  const w = stringWidth(s);
  if (w === width) return s;
  if (w < width) return s + " ".repeat(width - w);
  return cliTruncate(s, width, { position: "end", truncationCharacter: "~" });
}

// A labelled value row, with the label dimmed and padded for column alignment.
export const kv = (label: string, value: string, pad = 9) => dim(label.padEnd(pad)) + value;

// Render a rounded-border panel of a fixed total width. Title sits in the top edge.
export function panel(title: string, content: string[], width: number): string[] {
  const inner = width - 4; // "│ " + content + " │"
  const fillLen = Math.max(0, width - 5 - stringWidth(title)); // ╭ ─ " title " ─*fill ╮ (ANSI-aware)
  const top = border("┌─") + bold(` ${title} `) + border("─".repeat(fillLen) + "┐");
  const bottom = border("└" + "─".repeat(width - 2) + "┘");
  const body = content.map((line) => border("│") + " " + fit(line, inner) + "\x1b[0m " + border("│"));
  return [top, ...body, bottom];
}

// Lay two equal-or-fixed-width panels next to each other.
export function sideBySide(a: string[], aw: number, b: string[], bw: number, gap = 1): string[] {
  const h = Math.max(a.length, b.length);
  const rows: string[] = [];
  for (let i = 0; i < h; i++) {
    rows.push((a[i] ?? " ".repeat(aw)) + " ".repeat(gap) + (b[i] ?? " ".repeat(bw)));
  }
  return rows;
}

// Pad a content array with blank rows so stacked panels share one height.
export const padRows = (lines: string[], n: number) => (lines.length >= n ? lines : [...lines, ...Array(n - lines.length).fill("")]);

// Like padRows, but split the padding above/below so shorter info panels sit
// vertically centred next to the taller logo panel.
export const centerRows = (lines: string[], n: number) => {
  if (lines.length >= n) return lines;
  const top = Math.floor((n - lines.length) / 2);
  return [...Array(top).fill(""), ...lines, ...Array(n - lines.length - top).fill("")];
};

export const YAPPR_ART = [
  "██╗   ██╗ █████╗ ██████╗ ██████╗ ██████╗ ",
  "╚██╗ ██╔╝██╔══██╗██╔══██╗██╔══██╗██╔══██╗",
  " ╚████╔╝ ███████║██████╔╝██████╔╝██████╔╝",
  "  ╚██╔╝  ██╔══██║██╔═══╝ ██╔═══╝ ██╔══██╗",
  "   ██║   ██║  ██║██║     ██║     ██║  ██║ ",
  "   ╚═╝   ╚═╝  ╚═╝╚═╝     ╚═╝     ╚═╝  ╚═╝ ",
];

// Brand logo (quadrant art, 17x9 cells) from yappr-8.png — flat #0ff991 green face with
// solid black eyes + mouth (cleaned at 2x then downsampled so the mouth is a solid
// blob, no tongue). Transparent bg renders as spaces.
export const YAPPR_LOGO = [
  "             \u001b[38;2;0;82;255m▟\u001b[0m\u001b[38;2;0;82;255m▘\u001b[0m\u001b[38;2;0;82;255m▗\u001b[0m\u001b[38;2;0;82;255m▄\u001b[0m",
  "   \u001b[38;2;0;82;255m▄\u001b[0m\u001b[38;2;0;82;255m▟\u001b[0m\u001b[38;2;0;82;255m█\u001b[0m\u001b[38;2;0;82;255m█\u001b[0m\u001b[38;2;0;82;255m█\u001b[0m\u001b[38;2;0;82;255m█\u001b[0m\u001b[38;2;0;82;255m█\u001b[0m\u001b[38;2;0;82;255m█\u001b[0m\u001b[38;2;0;82;255m█\u001b[0m\u001b[38;2;0;82;255m▄\u001b[0m\u001b[38;2;0;82;255m▖\u001b[0m\u001b[38;2;0;82;255m▝\u001b[0m\u001b[38;2;0;82;255m▜\u001b[0m\u001b[38;2;0;82;255m▖\u001b[0m",
  " \u001b[38;2;0;82;255m▄\u001b[0m\u001b[38;2;0;82;255m█\u001b[0m\u001b[38;2;0;82;255m█\u001b[0m\u001b[38;2;0;82;255m█\u001b[0m\u001b[38;2;0;82;255m█\u001b[0m\u001b[38;2;0;0;0;48;2;0;82;255m▗\u001b[0m\u001b[38;2;0;0;0;48;2;0;82;255m▖\u001b[0m\u001b[38;2;0;82;255m█\u001b[0m\u001b[38;2;0;82;255m█\u001b[0m\u001b[38;2;0;82;255m█\u001b[0m\u001b[38;2;0;0;0;48;2;0;82;255m▀\u001b[0m\u001b[38;2;0;82;255m█\u001b[0m\u001b[38;2;0;82;255m█\u001b[0m\u001b[38;2;0;82;255m▙\u001b[0m  ",
  "\u001b[38;2;0;82;255m▟\u001b[0m\u001b[38;2;0;82;255m█\u001b[0m\u001b[38;2;0;82;255m█\u001b[0m\u001b[38;2;0;82;255m█\u001b[0m\u001b[38;2;0;82;255m█\u001b[0m\u001b[38;2;0;82;255m█\u001b[0m\u001b[38;2;0;82;255m█\u001b[0m\u001b[38;2;0;0;0;48;2;0;82;255m▟\u001b[0m\u001b[38;2;0;0;0m█\u001b[0m\u001b[38;2;0;0;0m█\u001b[0m\u001b[38;2;0;0;0m█\u001b[0m\u001b[38;2;0;0;0m█\u001b[0m\u001b[38;2;0;0;0;48;2;0;82;255m▙\u001b[0m\u001b[38;2;0;82;255m█\u001b[0m\u001b[38;2;0;82;255m█\u001b[0m\u001b[38;2;0;82;255m▙\u001b[0m ",
  "\u001b[38;2;0;82;255m█\u001b[0m\u001b[38;2;0;82;255m█\u001b[0m\u001b[38;2;0;82;255m█\u001b[0m\u001b[38;2;0;82;255m█\u001b[0m\u001b[38;2;0;82;255m█\u001b[0m\u001b[38;2;0;82;255m█\u001b[0m\u001b[38;2;0;0;0;48;2;0;82;255m▟\u001b[0m\u001b[38;2;0;0;0m█\u001b[0m\u001b[38;2;0;0;0m█\u001b[0m\u001b[38;2;0;0;0m█\u001b[0m\u001b[38;2;0;0;0m█\u001b[0m\u001b[38;2;0;0;0m█\u001b[0m\u001b[38;2;0;0;0m█\u001b[0m\u001b[38;2;0;82;255m█\u001b[0m\u001b[38;2;0;82;255m█\u001b[0m\u001b[38;2;0;82;255m█\u001b[0m ",
  "\u001b[38;2;0;82;255m▜\u001b[0m\u001b[38;2;0;82;255m█\u001b[0m\u001b[38;2;0;82;255m█\u001b[0m\u001b[38;2;0;82;255m█\u001b[0m\u001b[38;2;0;82;255m█\u001b[0m\u001b[38;2;0;82;255m█\u001b[0m\u001b[38;2;0;0;0;48;2;0;82;255m▜\u001b[0m\u001b[38;2;0;0;0m█\u001b[0m\u001b[38;2;0;0;0m█\u001b[0m\u001b[38;2;0;0;0m█\u001b[0m\u001b[38;2;0;0;0m█\u001b[0m\u001b[38;2;0;0;0m█\u001b[0m\u001b[38;2;0;0;0;48;2;0;82;255m▛\u001b[0m\u001b[38;2;0;82;255m█\u001b[0m\u001b[38;2;0;82;255m█\u001b[0m\u001b[38;2;0;82;255m▛\u001b[0m ",
  " \u001b[38;2;0;82;255m▜\u001b[0m\u001b[38;2;0;82;255m█\u001b[0m\u001b[38;2;0;82;255m█\u001b[0m\u001b[38;2;0;82;255m█\u001b[0m\u001b[38;2;0;82;255m█\u001b[0m\u001b[38;2;0;82;255m█\u001b[0m\u001b[38;2;0;0;0;48;2;0;82;255m▀\u001b[0m\u001b[38;2;0;0;0m█\u001b[0m\u001b[38;2;0;0;0m█\u001b[0m\u001b[38;2;0;0;0m█\u001b[0m\u001b[38;2;0;0;0;48;2;0;82;255m▀\u001b[0m\u001b[38;2;0;82;255m█\u001b[0m\u001b[38;2;0;82;255m█\u001b[0m\u001b[38;2;0;82;255m▛\u001b[0m  ",
  "  \u001b[38;2;0;82;255m▝\u001b[0m\u001b[38;2;0;82;255m▜\u001b[0m\u001b[38;2;0;82;255m█\u001b[0m\u001b[38;2;0;82;255m█\u001b[0m\u001b[38;2;0;82;255m█\u001b[0m\u001b[38;2;0;82;255m█\u001b[0m\u001b[38;2;0;82;255m█\u001b[0m\u001b[38;2;0;82;255m█\u001b[0m\u001b[38;2;0;82;255m█\u001b[0m\u001b[38;2;0;82;255m█\u001b[0m\u001b[38;2;0;82;255m▛\u001b[0m\u001b[38;2;0;82;255m▘\u001b[0m   ",
  "     \u001b[38;2;0;82;255m▐\u001b[0m\u001b[38;2;0;82;255m█\u001b[0m\u001b[38;2;0;82;255m▀\u001b[0m\u001b[38;2;0;82;255m▀\u001b[0m\u001b[38;2;0;82;255m▀\u001b[0m       ",
];
