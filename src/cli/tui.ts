// Shared CLI chrome for the interactive commands (deploy, update): the logo banner,
// section rules, ok/info/warn/fail lines, the spinner wrapper, and inquirer prompts
// painted in the Base-blue palette. Keeping it here means deploy and update speak the
// same visual language without each re-deriving it.

import { input as inputPrompt, password as passwordPrompt, confirm as confirmPrompt, select as selectPrompt } from "@inquirer/prompts";
import ora, { type Ora } from "ora";
import {
  dim, bold, green, yellow, red, accent, border, YAPPR_LOGO,
  kv as kvRow, fit, panel, sideBySide, centerRows, themeLine,
} from "./ui.js";

// Inquirer renders its own prompt line (prefix + message + answer) through its theme,
// not our console.log — so without this it falls back to inquirer's default green "?"
// and the terminal's own foreground, clashing with the Base-blue palette. Paint the
// prefix/message/answer in the current palette so prompts match the rest of the chrome.
const promptTheme = {
  prefix: { idle: accent("?"), done: green("✔") },
  style: {
    message: (text: string) => themeLine(text),
    answer: (text: string) => accent(text),
    // dim() only adds the dim attribute (no color) → the "(Y/n)" hint would fall back
    // to the terminal's own foreground (green). Layer dim over the palette color.
    defaultAnswer: (text: string) => dim(accent(text)),
    highlight: (text: string) => accent(text),
  },
};
const withTheme = <C extends { theme?: unknown }>(cfg: C): C =>
  ({ ...cfg, theme: { ...promptTheme, ...(cfg.theme as object ?? {}) } });

export const input: typeof inputPrompt = (cfg, ctx) => inputPrompt(withTheme(cfg), ctx);
export const password: typeof passwordPrompt = (cfg, ctx) => passwordPrompt(withTheme(cfg), ctx);
const inquirerConfirm: typeof confirmPrompt = (cfg, ctx) => confirmPrompt(withTheme(cfg), ctx);
export function select<Value>(cfg: Parameters<typeof selectPrompt<Value>>[0], ctx?: Parameters<typeof selectPrompt<Value>>[1]) {
  return selectPrompt<Value>(withTheme(cfg), ctx);
}

// `confirm` from inquirer, wrapped so Ctrl-C exits cleanly instead of throwing.
export async function confirm(message: string, defaultValue = false): Promise<boolean> {
  return inquirerConfirm({ message, default: defaultValue });
}

// Panel width for the deploy/update chrome — match the terminal, capped so the boxes
// stay readable on very wide windows.
export function uiWidth(): number {
  return Math.max(48, Math.min((process.stdout.columns ?? 80) - 1, 78));
}

// Header: the bare logo art with the command title floating beside it, vertically
// centred. `title` is the command (e.g. "Deploy", "Update").
export function banner(title: string, subtitle: string) {
  const logoW = 17; // raw logo art width (no box)
  const h = YAPPR_LOGO.length;
  const info = centerRows([
    `${bold("YAPPR")} ${dim("—")} ${bold(title)}`,
    dim(subtitle),
  ], h).map((line: string) => `  ${line}`);
  console.log("");
  // fit() each logo row to a fixed width so the text column lines up exactly.
  for (const row of sideBySide(YAPPR_LOGO.map((l) => "  " + fit(l, logoW)), logoW + 2, info, 0)) {
    console.log(row);
  }
}

// Numbered step header (deploy), styled like a dashboard panel title: bold caps in a
// Base-blue rule with a "step n/total" counter.
export function step(n: number, total: number, label: string) {
  const name = label.toUpperCase();
  const counter = `step ${n}/${total}`;
  const fill = Math.max(2, uiWidth() - name.length - counter.length - 10);
  console.log("");
  console.log(`  ${border("──")} ${bold(name)} ${border("─".repeat(fill))} ${dim(counter)} ${border("──")}`);
}

// Section header (update): the same rule as step() but without a counter — for flows
// that have phases rather than numbered steps.
export function section(label: string) {
  const name = label.toUpperCase();
  const fill = Math.max(2, uiWidth() - name.length - 8);
  console.log("");
  console.log(`  ${border("──")} ${bold(name)} ${border("─".repeat(fill))} ${border("──")}`);
}

// Aligned dim-label key/value row (the shared kv style from the status dashboard).
export function kv(key: string, value: string) {
  console.log(`  ${kvRow(key, value)}`);
}

// Print a status-style bordered panel at the 2-space indent the flows use.
export function printPanel(title: string, content: string[]) {
  for (const line of panel(title, content, uiWidth() - 2)) console.log(`  ${line}`);
}

export function ok(msg: string) { console.log(`  ${green("✓")}  ${msg}`); }
export function info(msg: string) { console.log(`     ${dim(msg)}`); }
export function warn(msg: string) { console.log(`  ${yellow("⚠")}  ${yellow(msg)}`); }
export function fail(msg: string) { console.log(`  ${red("✗")}  ${red(msg)}`); }

// ora's clear() parks the cursor at the `indent` column, so a following console.log
// would inherit those spaces. Reset to column 0 first so spinner result lines line up
// exactly with ok()/fail() lines.
function stopSpinner(spinner: Ora): void {
  spinner.stop();
  if (process.stdout.isTTY) process.stdout.cursorTo(0);
}

// ora draws its frame straight to the stream (not via our themed console.log), so its
// label text would render in the terminal's own foreground (green). themeText paints
// it in the palette; stripAnsi recovers the raw label for the static done line.
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
// Paint a (possibly already-colored) string in the palette — exported so callers can
// re-theme a spinner's live `.text` mid-run (ora bypasses our themed console.log).
export const themeText = (s: string) => themeLine(stripAnsi(s));

// Run an async task behind a spinner, then resolve to a static line that uses the same
// ✓/✗ glyphs and spacing as ok()/fail() so everything stays aligned.
export async function spin<T>(label: string, fn: (spinner: Ora) => Promise<T>, doneLabel?: string): Promise<T> {
  const spinner = ora({ text: themeText(label), indent: 2 }).start();
  try {
    const result = await fn(spinner);
    const text = stripAnsi(spinner.text);
    stopSpinner(spinner);
    ok(doneLabel ?? text);
    return result;
  } catch (err) {
    stopSpinner(spinner);
    fail(label);
    throw err;
  }
}
