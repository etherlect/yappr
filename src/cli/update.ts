// `yappr update` — pull the latest engine + scaffolded skills/hooks/context into an
// instance, then offer to redeploy. Two phases (a TUI like deploy, but no numbered
// steps): (1) bump the package to yappr@latest, (2) reconcile the new config/ into the
// user's ./config with the rules below. Run it from the instance dir.
//
// Reconcile rules, per shipped file (skill/hook/context):
//   • the user hasn't touched it  → overwrite silently with the new version
//   • the user edited it          → ask: keep mine / replace with new / show diff
//   • brand-new file              → create it; if a same-name file already exists
//                                    (the user made their own), ask before overwriting
// "Untouched vs edited" is decided against config/.yappr-sync.json, the manifest init
// writes (and this command rewrites). Instances with no manifest fall back to treating
// every existing file as edited → ask, so we never silently clobber.

import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  banner, section, spin, ok, info, warn, fail, kv, printPanel, select, confirm,
} from "./tui.js";
import { dim, bold, green, yellow, red, accent, setTheme, detectTerminalTheme, themeLine } from "./ui.js";
import {
  relFiles, hashFile, loadManifest, saveManifest, type Manifest,
} from "./config-sync.js";

const execFileAsync = promisify(execFile);

// This file is <pkg>/dist/src/cli/update.js (prod) or <pkg>/src/cli/update.ts (dev),
// so the package root — and its shipped config/ template — is three levels up. After
// the install phase replaces the package on disk, this same path holds the new config.
const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

type Flags = { configOnly: boolean; yes: boolean; theirs: boolean; ours: boolean };

function parseFlags(argv: string[]): Flags {
  const has = (...names: string[]) => names.some((n) => argv.includes(n));
  return {
    configOnly: has("--config-only", "--no-install"),
    yes: has("--yes", "-y"),
    theirs: has("--theirs", "--force"),
    ours: has("--ours", "--keep"),
  };
}

// Which package manager runs the instance — pick by lockfile, default npm. Each is the
// "install this exact dist-tag" form so `yappr@latest` lands.
function installCmd(cwd: string): { cmd: string; args: string[] } {
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) return { cmd: "pnpm", args: ["add", "yappr@latest"] };
  if (existsSync(join(cwd, "yarn.lock"))) return { cmd: "yarn", args: ["add", "yappr@latest"] };
  if (existsSync(join(cwd, "bun.lockb"))) return { cmd: "bun", args: ["add", "yappr@latest"] };
  return { cmd: "npm", args: ["install", "yappr@latest"] };
}

type Action = "create" | "update" | "overwrite" | "keep" | "current";

// Print a coloured unified diff of the user's file vs the new one (best-effort: relies
// on the system `diff`, which exits 1 when files differ — we read that as the diff).
async function showDiff(userPath: string, pkgPath: string): Promise<void> {
  try {
    await execFileAsync("diff", ["-u", userPath, pkgPath]);
    info("(no differences)");
  } catch (err: any) {
    const out = typeof err?.stdout === "string" ? err.stdout : "";
    if (!out) { info("(diff unavailable)"); return; }
    for (const line of out.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) console.log(`     ${green(line)}`);
      else if (line.startsWith("-") && !line.startsWith("---")) console.log(`     ${red(line)}`);
      else if (line.startsWith("@@")) console.log(`     ${accent(line)}`);
      else console.log(`     ${dim(line)}`);
    }
  }
}

// Resolve a conflict (user-edited or a name-clash on a new file): keep theirs, take
// ours, or — interactively — let them choose (with an optional diff).
async function resolveConflict(rel: string, userPath: string, pkgPath: string, flags: Flags): Promise<"keep" | "replace"> {
  if (flags.theirs) return "replace";
  if (flags.ours || flags.yes || !process.stdout.isTTY) return "keep"; // non-interactive default: never clobber edits
  for (;;) {
    const choice = await select<"keep" | "replace" | "diff">({
      message: `${accent(rel)} differs from the new version — what should I do?`,
      choices: [
        { name: "Keep my version", value: "keep" },
        { name: "Replace with the new version", value: "replace" },
        { name: "Show diff", value: "diff" },
      ],
    });
    if (choice === "diff") { await showDiff(userPath, pkgPath); continue; }
    return choice;
  }
}

async function reconcile(configDir: string, templateDir: string, flags: Flags): Promise<Record<Action, number>> {
  const counts: Record<Action, number> = { create: 0, update: 0, overwrite: 0, keep: 0, current: 0 };
  const shipped = await relFiles(templateDir);
  const manifest = await loadManifest(configDir);
  const next: Manifest = {};

  for (const rel of shipped) {
    const userPath = join(configDir, rel);
    const pkgPath = join(templateDir, rel);
    const [userHash, newHash] = await Promise.all([hashFile(userPath), hashFile(pkgPath)]);
    if (!newHash) continue; // unreadable shipped file — skip defensively
    const recorded = manifest[rel];

    const write = async () => {
      await mkdir(dirname(userPath), { recursive: true });
      await writeFile(userPath, await readFile(pkgPath));
      next[rel] = newHash;
    };

    if (userHash === null) {
      // Not present in the instance → a brand-new file. Create it.
      await write();
      counts.create++;
      ok(`added ${accent(rel)}`);
    } else if (userHash === newHash) {
      // Already identical to the new version — nothing to do.
      next[rel] = newHash;
      counts.current++;
    } else if (recorded && userHash === recorded) {
      // Untouched by the user since we last installed it, but the package changed →
      // safe to fast-forward.
      await write();
      counts.update++;
      ok(`updated ${accent(rel)}`);
    } else {
      // Diverged: the user edited it, or it pre-existed untracked (their own file with
      // the same name). Never clobber without consent.
      const decision = await resolveConflict(rel, userPath, pkgPath, flags);
      if (decision === "replace") {
        await write();
        counts.overwrite++;
        ok(`replaced ${accent(rel)} ${dim("(your version backed out)")}`);
      } else {
        next[rel] = recorded ?? userHash; // keep detecting against the same baseline
        counts.keep++;
        info(`kept your ${rel}`);
      }
    }
  }

  await saveManifest(configDir, next);
  return counts;
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const cwd = process.cwd();
  const configDir = join(cwd, "config");

  if (process.stdout.isTTY) process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
  if (!process.env.STATUS_THEME) {
    const detected = await detectTerminalTheme().catch(() => null);
    if (detected) setTheme(detected);
  }
  // Paint every printed line in the palette's default text color (see deploy.ts /
  // ui.themeLine): the chrome only colors specific glyphs and leaves message text
  // uncolored, which otherwise falls back to the terminal's own foreground.
  if (process.stdout.isTTY) {
    for (const m of ["log", "error"] as const) {
      const orig = console[m].bind(console);
      console[m] = (...args: unknown[]) => orig(...args.map((a) => (typeof a === "string" ? themeLine(a) : a)));
    }
  }

  banner("Update", "Pull the latest engine + skills into this instance");

  if (!existsSync(configDir)) {
    console.log("");
    fail(`No ./config here — run \`yappr update\` from your instance directory (where you ran \`yappr init\`).`);
    process.exitCode = 1;
    return;
  }

  // ── Phase 1: bump the package ────────────────────────────────────────────────
  // Only when yappr is actually an installed dependency of this instance (skip in dev
  // / when running the engine in place, where there's nothing to install).
  const installedHere = existsSync(join(cwd, "node_modules", "yappr"));
  section("Package");
  if (flags.configOnly) {
    info("--config-only — skipping package update");
  } else if (!installedHere) {
    warn("yappr isn't an installed dependency here — skipping package update (syncing config only)");
  } else {
    const { cmd, args } = installCmd(cwd);
    try {
      await spin(`Updating engine — ${dim(`${cmd} ${args.join(" ")}`)}…`, () => execFileAsync(cmd, args, { cwd }), "Engine updated to yappr@latest");
    } catch (err) {
      fail(`Package update failed: ${err instanceof Error ? err.message : String(err)}`);
      if (!(await confirm("Continue and just reconcile config from the currently-installed version?", true))) {
        process.exitCode = 1;
        return;
      }
    }
  }

  // ── Phase 2: reconcile config ────────────────────────────────────────────────
  const templateDir = join(PKG_ROOT, "config");
  section("Config");
  if (!existsSync(templateDir)) {
    fail(`Installed package has no config/ template at ${templateDir}.`);
    process.exitCode = 1;
    return;
  }
  const c = await reconcile(configDir, templateDir, flags);
  const touched = c.create + c.update + c.overwrite;
  if (touched === 0 && c.keep === 0) info("everything already up to date");

  // ── Summary ──────────────────────────────────────────────────────────────────
  console.log("");
  printPanel("UPDATE SUMMARY", [
    kvFmt("Added", c.create, green),
    kvFmt("Updated", c.update, green),
    kvFmt("Replaced", c.overwrite, yellow),
    kvFmt("Kept yours", c.keep, dim),
    kvFmt("Unchanged", c.current, dim),
  ]);

  // ── Next: redeploy ─────────────────────────────────────────────────────────────
  section("Next");
  if (touched === 0) {
    info("No config changes — nothing to redeploy.");
    return;
  }
  console.log(`  ${yellow("⚠")}  ${bold("Your live agent is still running the previous version.")}`);
  info("These changes only take effect on the server after a redeploy.");
  console.log("");
  if (process.stdout.isTTY && await confirm("Redeploy now to apply the update?", true)) {
    const { run } = await import("./deploy.js");
    await run();
  } else {
    kv("Redeploy", `${bold("npx yappr deploy")}   ${dim("— push these changes to your instance")}`);
  }
}

// A right-aligned-ish count row for the summary panel, coloured by the formatter.
function kvFmt(label: string, n: number, color: (s: string) => string): string {
  return `${dim(label.padEnd(11))}${color(String(n))}`;
}

export async function run(): Promise<void> {
  await main();
}

const isMain = (() => {
  try { return fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? ""); }
  catch { return false; }
})();
if (isMain) {
  run().catch((err) => {
    if (err?.name === "ExitPromptError") { console.log("\n  Aborted."); process.exit(0); }
    console.error(`\n  ✗  ${err?.message ?? err}`);
    process.exit(1);
  });
}
