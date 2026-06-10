// Shared terminal styling + box/layout primitives for the CLI scripts (deploy,
// status), so both speak the same visual language: dim-label kv rows and
// rounded-border panels with the title in the top edge.

import stringWidth from "string-width";
import cliTruncate from "cli-truncate";

export const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
export const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
// Truecolor green (not the 16-color \x1b[32m, which some terminal themes remap to a
// salmon/olive shade) so it renders as a real green regardless of color scheme.
export const green = (s: string) => `\x1b[38;2;46;204;113m${s}\x1b[0m`;
export const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
export const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
export const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
export const accent = (s: string) => `\x1b[38;2;215;119;87m${s}\x1b[0m`; // coral
export const border = (s: string) => `\x1b[38;2;15;249;145m${s}\x1b[0m`; // box borders — logo green (#0ff991)

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
  "             \u001b[38;2;15;249;145m▟\u001b[0m\u001b[38;2;15;249;145m▘\u001b[0m\u001b[38;2;15;249;145m▗\u001b[0m\u001b[38;2;15;249;145m▄\u001b[0m",
  "   \u001b[38;2;15;249;145m▄\u001b[0m\u001b[38;2;15;249;145m▟\u001b[0m\u001b[38;2;15;249;145m█\u001b[0m\u001b[38;2;15;249;145m█\u001b[0m\u001b[38;2;15;249;145m█\u001b[0m\u001b[38;2;15;249;145m█\u001b[0m\u001b[38;2;15;249;145m█\u001b[0m\u001b[38;2;15;249;145m█\u001b[0m\u001b[38;2;15;249;145m█\u001b[0m\u001b[38;2;15;249;145m▄\u001b[0m\u001b[38;2;15;249;145m▖\u001b[0m\u001b[38;2;15;249;145m▝\u001b[0m\u001b[38;2;15;249;145m▜\u001b[0m\u001b[38;2;15;249;145m▖\u001b[0m",
  " \u001b[38;2;15;249;145m▄\u001b[0m\u001b[38;2;15;249;145m█\u001b[0m\u001b[38;2;15;249;145m█\u001b[0m\u001b[38;2;15;249;145m█\u001b[0m\u001b[38;2;15;249;145m█\u001b[0m\u001b[38;2;0;0;0;48;2;15;249;145m▗\u001b[0m\u001b[38;2;0;0;0;48;2;15;249;145m▖\u001b[0m\u001b[38;2;15;249;145m█\u001b[0m\u001b[38;2;15;249;145m█\u001b[0m\u001b[38;2;15;249;145m█\u001b[0m\u001b[38;2;0;0;0;48;2;15;249;145m▀\u001b[0m\u001b[38;2;15;249;145m█\u001b[0m\u001b[38;2;15;249;145m█\u001b[0m\u001b[38;2;15;249;145m▙\u001b[0m  ",
  "\u001b[38;2;15;249;145m▟\u001b[0m\u001b[38;2;15;249;145m█\u001b[0m\u001b[38;2;15;249;145m█\u001b[0m\u001b[38;2;15;249;145m█\u001b[0m\u001b[38;2;15;249;145m█\u001b[0m\u001b[38;2;15;249;145m█\u001b[0m\u001b[38;2;15;249;145m█\u001b[0m\u001b[38;2;0;0;0;48;2;15;249;145m▟\u001b[0m\u001b[38;2;0;0;0m█\u001b[0m\u001b[38;2;0;0;0m█\u001b[0m\u001b[38;2;0;0;0m█\u001b[0m\u001b[38;2;0;0;0m█\u001b[0m\u001b[38;2;0;0;0;48;2;15;249;145m▙\u001b[0m\u001b[38;2;15;249;145m█\u001b[0m\u001b[38;2;15;249;145m█\u001b[0m\u001b[38;2;15;249;145m▙\u001b[0m ",
  "\u001b[38;2;15;249;145m█\u001b[0m\u001b[38;2;15;249;145m█\u001b[0m\u001b[38;2;15;249;145m█\u001b[0m\u001b[38;2;15;249;145m█\u001b[0m\u001b[38;2;15;249;145m█\u001b[0m\u001b[38;2;15;249;145m█\u001b[0m\u001b[38;2;0;0;0;48;2;15;249;145m▟\u001b[0m\u001b[38;2;0;0;0m█\u001b[0m\u001b[38;2;0;0;0m█\u001b[0m\u001b[38;2;0;0;0m█\u001b[0m\u001b[38;2;0;0;0m█\u001b[0m\u001b[38;2;0;0;0m█\u001b[0m\u001b[38;2;0;0;0m█\u001b[0m\u001b[38;2;15;249;145m█\u001b[0m\u001b[38;2;15;249;145m█\u001b[0m\u001b[38;2;15;249;145m█\u001b[0m ",
  "\u001b[38;2;15;249;145m▜\u001b[0m\u001b[38;2;15;249;145m█\u001b[0m\u001b[38;2;15;249;145m█\u001b[0m\u001b[38;2;15;249;145m█\u001b[0m\u001b[38;2;15;249;145m█\u001b[0m\u001b[38;2;15;249;145m█\u001b[0m\u001b[38;2;0;0;0;48;2;15;249;145m▜\u001b[0m\u001b[38;2;0;0;0m█\u001b[0m\u001b[38;2;0;0;0m█\u001b[0m\u001b[38;2;0;0;0m█\u001b[0m\u001b[38;2;0;0;0m█\u001b[0m\u001b[38;2;0;0;0m█\u001b[0m\u001b[38;2;0;0;0;48;2;15;249;145m▛\u001b[0m\u001b[38;2;15;249;145m█\u001b[0m\u001b[38;2;15;249;145m█\u001b[0m\u001b[38;2;15;249;145m▛\u001b[0m ",
  " \u001b[38;2;15;249;145m▜\u001b[0m\u001b[38;2;15;249;145m█\u001b[0m\u001b[38;2;15;249;145m█\u001b[0m\u001b[38;2;15;249;145m█\u001b[0m\u001b[38;2;15;249;145m█\u001b[0m\u001b[38;2;15;249;145m█\u001b[0m\u001b[38;2;0;0;0;48;2;15;249;145m▀\u001b[0m\u001b[38;2;0;0;0m█\u001b[0m\u001b[38;2;0;0;0m█\u001b[0m\u001b[38;2;0;0;0m█\u001b[0m\u001b[38;2;0;0;0;48;2;15;249;145m▀\u001b[0m\u001b[38;2;15;249;145m█\u001b[0m\u001b[38;2;15;249;145m█\u001b[0m\u001b[38;2;15;249;145m▛\u001b[0m  ",
  "  \u001b[38;2;15;249;145m▝\u001b[0m\u001b[38;2;15;249;145m▜\u001b[0m\u001b[38;2;15;249;145m█\u001b[0m\u001b[38;2;15;249;145m█\u001b[0m\u001b[38;2;15;249;145m█\u001b[0m\u001b[38;2;15;249;145m█\u001b[0m\u001b[38;2;15;249;145m█\u001b[0m\u001b[38;2;15;249;145m█\u001b[0m\u001b[38;2;15;249;145m█\u001b[0m\u001b[38;2;15;249;145m█\u001b[0m\u001b[38;2;15;249;145m▛\u001b[0m\u001b[38;2;15;249;145m▘\u001b[0m   ",
  "     \u001b[38;2;15;249;145m▐\u001b[0m\u001b[38;2;15;249;145m█\u001b[0m\u001b[38;2;15;249;145m▀\u001b[0m\u001b[38;2;15;249;145m▀\u001b[0m\u001b[38;2;15;249;145m▀\u001b[0m       ",
];
