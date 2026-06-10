// Provision + deploy yappr to an x402 compute instance (the `yappr deploy` command).

import "dotenv/config";
import { readFile, writeFile, copyFile, access, mkdtemp, rm } from "node:fs/promises";
import { resolve, join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { createConnection } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NodeSSH } from "node-ssh";
import { input, password, confirm as inquirerConfirm, select } from "@inquirer/prompts";
import ora, { type Ora } from "ora";
import { bankrApi } from "../bankr.js";
import { createBankrSigner, createPayFetch } from "../x402.js";
import {
  computeInstanceData,
  computeInstanceId,
  computeInstanceIp,
  computeInstancePassword,
  computeInstanceExpiry,
  remainingComputeHours,
  fetchComputeInstance,
  fetchOneTimePassword,
  waitForComputeIp,
  resolveEvmAddress,
} from "../compute.js";
import {
  dim, bold, green, yellow, red, accent, border, YAPPR_LOGO,
  kv as kvRow, fit, panel, sideBySide, centerRows,
} from "./ui.js";
import { isUnset, setEnvVar, setEnvVarInContent, removeEnvVarInContent } from "./env.js";
import { runStatus } from "./status.js";
import { latestLocalBackup, remoteFileExists, backupLabel, REMOTE_DB_PATH } from "./backup.js";
import { hostKeyConfig } from "./host-key.js";

const execFileAsync = promisify(execFile);

// Engine package root. This file is <root>/dist/src/cli/deploy.js in prod (or
// <root>/src/cli/deploy.ts in dev), so the root is three levels up. Used to build +
// pack the engine into a tarball the server installs.
const ENGINE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// Panel width for the deploy chrome (banner, summary boxes) — match the terminal,
// capped so the boxes stay readable on very wide windows.
function uiWidth(): number {
  return Math.max(48, Math.min((process.stdout.columns ?? 80) - 1, 78));
}

// Header: the bare logo art with the title floating beside it, vertically centred.
function banner(subtitle: string) {
  const logoW = 17; // raw logo art width (no box)
  const h = YAPPR_LOGO.length;
  const info = centerRows([
    `${bold("YAPPR")} ${dim("—")} ${bold("Deploy")}`,
    dim(subtitle),
  ], h).map((line: string) => `  ${line}`);
  console.log("");
  // fit() each logo row to a fixed width so the text column lines up exactly.
  for (const row of sideBySide(YAPPR_LOGO.map((l) => "  " + fit(l, logoW)), logoW + 2, info, 0)) {
    console.log(row);
  }
}

// Step header styled like a dashboard panel title: bold caps in a logo-green rule.
function step(n: number, total: number, label: string) {
  const name = label.toUpperCase();
  const counter = `step ${n}/${total}`;
  const fill = Math.max(2, uiWidth() - name.length - counter.length - 10);
  console.log("");
  console.log(`  ${border("──")} ${bold(name)} ${border("─".repeat(fill))} ${dim(counter)} ${border("──")}`);
}

// Aligned dim-label key/value row (the shared kv style from the status dashboard).
function kv(key: string, value: string) {
  console.log(`  ${kvRow(key, value)}`);
}

// Print a status-style bordered panel at the deploy flow's 2-space indent.
function printPanel(title: string, content: string[]) {
  for (const line of panel(title, content, uiWidth() - 2)) console.log(`  ${line}`);
}

function ok(msg: string) { console.log(`  ${green("✓")}  ${msg}`); }
function info(msg: string) { console.log(`     ${dim(msg)}`); }
function warn(msg: string) { console.log(`  ${yellow("⚠")}  ${yellow(msg)}`); }
function fail(msg: string) { console.log(`  ${red("✗")}  ${red(msg)}`); }

// ora's clear() parks the cursor at the `indent` column, so a following
// console.log would inherit those spaces. Reset to column 0 first so spinner
// result lines line up exactly with ok()/fail() lines.
function stopSpinner(spinner: Ora): void {
  spinner.stop();
  if (process.stdout.isTTY) process.stdout.cursorTo(0);
}

// Run an async task behind a spinner, then resolve to a static line that uses
// the same ✓/✗ glyphs and spacing as ok()/fail() so everything stays aligned.
async function spin<T>(label: string, fn: (spinner: Ora) => Promise<T>, doneLabel?: string): Promise<T> {
  const spinner = ora({ text: label, indent: 2 }).start();
  try {
    const result = await fn(spinner);
    const text = spinner.text;
    stopSpinner(spinner);
    ok(doneLabel ?? text);
    return result;
  } catch (err) {
    stopSpinner(spinner);
    fail(label);
    throw err;
  }
}

// `confirm` from inquirer, wrapped so Ctrl-C exits cleanly instead of throwing
async function confirm(message: string, defaultValue = false): Promise<boolean> {
  return inquirerConfirm({ message, default: defaultValue });
}

// ─── process helpers ──────────────────────────────────────────────────────────

async function getLlmCreditBalanceUsd(apiKey: string): Promise<number> {
  const llmUrl = process.env.BANKR_LLM_URL || "https://llm.bankr.bot";
  const res = await fetch(`${llmUrl}/v1/credits`, {
    headers: {
      "X-API-Key": process.env.BANKR_LLM_KEY || apiKey,
      "User-Agent": "yappr-deploy/0.1",
    },
    signal: AbortSignal.timeout(10000),
  });

  if (res.status === 402) return 0;
  if (!res.ok) throw new Error(`Bankr LLM credits check failed: ${res.status} ${await res.text()}`);

  const body = await res.json() as { balanceUsd?: number };
  return Number(body.balanceUsd ?? 0);
}

type LlmModel = {
  id: string;
  name?: string;
  pricing?: { input?: number; output?: number };
};

// List models available on the Bankr LLM Gateway (OpenAI-compatible /v1/models).
async function fetchLlmModels(apiKey: string): Promise<LlmModel[]> {
  const llmUrl = process.env.BANKR_LLM_URL || "https://llm.bankr.bot";
  const res = await fetch(`${llmUrl}/v1/models`, {
    headers: { "X-API-Key": process.env.BANKR_LLM_KEY || apiKey, "User-Agent": "yappr-deploy/0.1" },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Bankr LLM models fetch failed: ${res.status} ${await res.text()}`);
  const body = await res.json() as { data?: LlmModel[] };
  return body.data ?? [];
}

type LlmAutoTopUpToken = {
  address: string;
  chain: "base";
  symbol: string;
  name: string;
  decimals: number;
  imageUrl?: string;
};

type LlmAutoTopUpConfig = {
  enabled?: boolean;
  amountUsd?: number;
  thresholdUsd?: number;
  tokens?: LlmAutoTopUpToken[];
};

const BASE_USDC_AUTO_TOP_UP_TOKEN: LlmAutoTopUpToken = {
  address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  chain: "base",
  symbol: "USDC",
  name: "USD Coin",
  decimals: 6,
};

function regionCode(region: any): string {
  return String(region?.id ?? region?.slug ?? region?.code ?? region?.name ?? "").toLowerCase();
}

function regionLabel(region: any): string {
  const code = regionCode(region);
  const city = region?.city;
  const country = region?.country;
  const explicitName = region?.name ?? region?.label;
  const label = city && country
    ? `${city}, ${country}`
    : explicitName && explicitName !== code
      ? explicitName
      : undefined;
  return label ? `${label} (${code})` : code || "Unknown region";
}

function formatUsd(amount: number, decimals: number): string {
  return `$${amount.toFixed(decimals)}`;
}

async function computeX402Pay<T = unknown>(
  apiKey: string,
  walletAddress: `0x${string}`,
  url: string,
  body: string,
): Promise<T> {
  const payFetch = createPayFetch(createBankrSigner(apiKey, walletAddress));

  const res = await payFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

  const text = await res.text();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = text; }

  if (!res.ok) throw new Error(`Compute payment failed: ${res.status} ${JSON.stringify(parsed)}`);
  return parsed as T;
}

async function extendComputeInstance(apiKey: string, walletAddress: `0x${string}`, instanceId: string): Promise<any> {
  return computeX402Pay<any>(
    apiKey,
    walletAddress,
    `https://compute.x402layer.cc/compute/instances/${instanceId}/extend`,
    JSON.stringify({ extend_hours: 24, network: "base" }),
  );
}

async function topUpLlmCredits(apiKey: string, amountUsd: number): Promise<{ newBalance: number; txHash?: string }> {
  const result = await bankrApi<{ newBalance: number; txHash?: string }>(apiKey, "/llm/credits/topup", {
    method: "POST",
    body: JSON.stringify({ amountUsd, sourceToken: "USDC" }),
  });
  return result;
}

async function getLlmAutoTopUpConfig(apiKey: string): Promise<LlmAutoTopUpConfig> {
  const { config } = await bankrApi<{ config: LlmAutoTopUpConfig }>(apiKey, "/llm/credits/auto-topup");
  return config;
}

async function enableLlmAutoTopUp(apiKey: string, token: LlmAutoTopUpToken): Promise<void> {
  await bankrApi(apiKey, "/llm/credits/auto-topup", {
    method: "POST",
    body: JSON.stringify({
      enabled: true,
      amountUsd: 5,
      thresholdUsd: 1,
      tokens: [token],
    }),
  });
}

async function waitForPort(host: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const reachable = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host, port });
      const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 3000);
      socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve(true); });
      socket.once("error", () => { clearTimeout(timer); socket.destroy(); resolve(false); });
    });
    if (reachable) return;
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`Timed out waiting for ${host}:${port}`);
}

// Run a remote command. By default output is suppressed (quiet); on failure the
// captured stderr/stdout is surfaced in the thrown error.
async function sshExec(ssh: NodeSSH, cmd: string, opts: { quiet?: boolean } = {}): Promise<void> {
  const result = await ssh.execCommand(cmd, { cwd: "/" });
  if (!opts.quiet) {
    if (result.stdout) console.log(result.stdout.split("\n").map((l) => `     ${l}`).join("\n"));
    if (result.stderr) process.stderr.write(result.stderr.split("\n").map((l) => `     ${l}`).join("\n") + "\n");
  }
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout || "").trim().split("\n").slice(-5).join("\n");
    throw new Error(`SSH command failed (exit ${result.code})${detail ? `:\n${detail}` : ""}`);
  }
}

// Returns true if `bin` is on PATH on the remote host (used to skip already-done work).
async function sshHas(ssh: NodeSSH, bin: string): Promise<boolean> {
  const result = await ssh.execCommand(`command -v ${bin} >/dev/null 2>&1`, { cwd: "/" });
  return result.code === 0;
}

// Remote Node.js major version, or null if node isn't installed.
async function sshNodeMajor(ssh: NodeSSH): Promise<number | null> {
  const result = await ssh.execCommand("node -v 2>/dev/null | sed 's/v//' | cut -d. -f1", { cwd: "/" });
  const major = parseInt(result.stdout.trim(), 10);
  return Number.isFinite(major) ? major : null;
}

// Build the engine and pack it into an npm tarball (its `files`: dist + config
// template + .env.example). Returns the local tarball path; the server installs it.
//
// TODO(publish): the engine isn't on npm yet, so we bundle the LOCAL package this way.
// Once `yappr` is published, drop the build+pack+upload and just `npm i yappr@<ver>`
// on the server (the cloud package.json below would depend on the registry version).
async function bundleEngine(): Promise<string> {
  await execFileAsync("npm", ["run", "build"], { cwd: ENGINE_ROOT });
  const dest = await mkdtemp(join(tmpdir(), "yappr-pack-"));
  const { stdout } = await execFileAsync("npm", ["pack", "--pack-destination", dest], { cwd: ENGINE_ROOT });
  return join(dest, stdout.trim().split("\n").pop()!.trim()); // npm prints the .tgz filename last
}

// ─── deploy ─────────────────────────────────────────────────────────────────

async function main() {
  // Start from a clean screen for the deploy UI. The escape sequence clears the
  // screen (2J), the scrollback buffer (3J), and homes the cursor (H). Skipped
  // when stdout isn't a TTY (piped/CI) so we don't write escape codes into logs.
  if (process.stdout.isTTY) process.stdout.write("\x1b[2J\x1b[3J\x1b[H");

  const TOTAL_STEPS = 7;

  banner("Self-sustaining AI agent on X");

  if (process.env.CLOUD_INSTANCE === "true") {
    console.error("\n  This looks like the deployed cloud instance.");
    console.error("  Do not run the deploy script from here. To start or restart the bot, run:");
    console.error("");
    console.error("    cd /yappr && (pm2 delete yappr || true) && pm2 start node_modules/yappr/dist/src/yappr.js --name yappr --update-env");
    console.error("");
    process.exit(1);
  }

  // ── Step 1: collect env ───────────────────────────────────────────────────
  step(1, TOTAL_STEPS, "Configuration");

  const envPath = resolve(process.cwd(), ".env");
  if (!await access(envPath).then(() => true).catch(() => false)) {
    await copyFile(resolve(process.cwd(), ".env.example"), envPath);
    ok(".env created from .env.example");
  }

  type FieldOpts = {
    required?: boolean;
    secret?: boolean;
    validate?: (v: string) => true | string;
    transform?: (v: string) => string;
  };

  async function field(key: string, message: string, opts: FieldOpts = {}): Promise<string> {
    if (!isUnset(process.env[key])) {
      info(`${key} already set — skipping`);
      return process.env[key]!;
    }

    const validate = (raw: string): true | string => {
      const v = raw.trim();
      if (!v) return opts.required ? "Required." : true;
      return opts.validate ? opts.validate(v) : true;
    };

    const answer = opts.secret
      ? await password({ message, mask: "•", validate })
      : await input({ message, validate });

    const value = (opts.transform ? opts.transform(answer.trim()) : answer.trim());

    if (!value) {
      info(`${key} skipped`);
      return "";
    }

    await setEnvVar(envPath, key, value);
    ok(`${key} saved`);
    return value;
  }

  const bankrApiKey = await field("BANKR_API_KEY", "Bankr API key", {
    required: true,
    secret: true,
    validate: (v) => v.startsWith("bk_") || "Bankr keys start with 'bk_'.",
  });
  await field("TWITTER_AUTH_TOKEN", "X/Twitter auth_token cookie", { required: true, secret: true });
  await field("TWITTER_CT0", "X/Twitter ct0 cookie", { required: true, secret: true });
  await field("TOKEN_ADDRESS", "Agent token address on Base", {
    required: true,
    validate: (v) => /^0x[a-fA-F0-9]{40}$/.test(v) || "Must be a 0x… 42-character address.",
  });
  await field("AGENT_HANDLE", "Agent's Twitter handle (without @)", {
    required: true,
    transform: (v) => v.replace(/^@/, ""),
  });
  await field("ADMIN_HANDLES", "Admin handles for admin-only skills, comma-separated (without @, blank to skip)", {
    transform: (v) => v.split(",").map((h) => h.trim().replace(/^@/, "")).filter(Boolean).join(","),
  });

  // LLM model — chosen from the Bankr LLM Gateway catalogue (default deepseek-v4-flash).
  const DEFAULT_MODEL = "deepseek-v4-flash";
  if (isUnset(process.env.LLM_MODEL)) {
    let models: LlmModel[] = [];
    try {
      models = await fetchLlmModels(bankrApiKey);
    } catch (err) {
      warn(`Could not fetch model list (${err instanceof Error ? err.message : String(err)})`);
    }
    if (models.length) {
      models.sort((a, b) => (a.pricing?.output ?? 1e9) - (b.pricing?.output ?? 1e9));
      const model = await select({
        message: "LLM model (via Bankr LLM Gateway)",
        default: models.some((m) => m.id === DEFAULT_MODEL) ? DEFAULT_MODEL : models[0].id,
        choices: models.map((m) => ({
          name: `${m.name ?? m.id}  ${dim(`${m.id} · $${m.pricing?.input ?? "?"}/$${m.pricing?.output ?? "?"} per Mtok`)}`,
          value: m.id,
        })),
      });
      await setEnvVar(envPath, "LLM_MODEL", model);
      ok(`LLM_MODEL saved: ${model}`);
    } else {
      await setEnvVar(envPath, "LLM_MODEL", DEFAULT_MODEL);
      ok(`LLM_MODEL saved: ${DEFAULT_MODEL}`);
    }
  } else {
    info("LLM_MODEL already set — skipping");
  }

  // Token burn rate — % of collected token fees burned each treasury cycle.
  if (isUnset(process.env.BURN_BPS)) {
    const burnPct = await select({
      message: "How much of collected token fees should be burned?",
      default: 50,
      choices: [
        { name: "0%   — keep all fees", value: 0 },
        { name: "25%", value: 25 },
        { name: "50%  — recommended", value: 50 },
        { name: "75%", value: 75 },
        { name: "100% — burn all fees", value: 100 },
      ],
    });
    await setEnvVar(envPath, "BURN_BPS", String(burnPct * 100));
    ok(`BURN_BPS saved: ${burnPct * 100} (${burnPct}%)`);
  } else {
    info("BURN_BPS already set — skipping");
  }

  // Optional dev fee — a cut of each treasury claim sent to a dev address
  if (isUnset(process.env.DEV_ADDRESS)) {
    if (await confirm("Set up a dev fee (send a cut of each claim's token + WETH to a dev address)?", false)) {
      await field("DEV_ADDRESS", "Dev recipient address on Base", {
        required: true,
        validate: (v) => /^0x[a-fA-F0-9]{40}$/.test(v) || "Must be a 0x… 42-character address.",
      });

      const burnBps = Number(process.env.BURN_BPS ?? "5000");
      await field("DEV_TOKEN_BPS", "Dev token fee in basis points (e.g. 500 = 5%)", {
        required: true,
        validate: (v) => {
          if (!/^\d+$/.test(v) || +v < 0 || +v > 10000) return "Whole number between 0 and 10000.";
          if (burnBps + +v > 10000) return `BURN_BPS (${burnBps}) + DEV_TOKEN_BPS (${v}) would exceed 10000.`;
          return true;
        },
      });
      await field("DEV_WETH_BPS", "Dev WETH fee in basis points (e.g. 500 = 5%)", {
        required: true,
        validate: (v) => {
          if (!/^\d+$/.test(v) || +v < 0 || +v > 10000) return "Whole number between 0 and 10000.";
          return true;
        },
      });
    } else {
      await setEnvVar(envPath, "DEV_ADDRESS", "none");
      info("Dev fee skipped");
    }
  } else if (process.env.DEV_ADDRESS !== "none") {
    info("DEV_ADDRESS already set — skipping");
  }

  // ── Step 2: Bankr wallet ──────────────────────────────────────────────────
  step(2, TOTAL_STEPS, "Checking Bankr wallet");

  const address = await resolveEvmAddress(bankrApiKey);
  info(`Wallet:       ${address}`);

  let usdcBalance = 0;
  let llmAutoTopUpToken = BASE_USDC_AUTO_TOP_UP_TOKEN;
  try {
    const balJson = await bankrApi<any>(bankrApiKey, "/wallet/balances");
    const base = balJson.balances?.base;
    const usdc = base?.tokenBalances?.find((t: any) => {
      const symbol = t.symbol ?? t.token?.baseToken?.symbol;
      return symbol?.toUpperCase() === "USDC";
    });
    usdcBalance = Number(usdc?.balance ?? usdc?.token?.balance ?? 0);

    const token = usdc?.token?.baseToken ?? usdc?.baseToken ?? usdc;
    if (token?.address) {
      llmAutoTopUpToken = {
        address: token.address,
        chain: "base",
        symbol: token.symbol ?? "USDC",
        name: token.name ?? "USD Coin",
        decimals: Number(token.decimals ?? 6),
        imageUrl: token.imgUrl ?? token.imageUrl,
      };
    }
  } catch { /* non-fatal */ }
  info(`USDC balance: ${usdcBalance.toFixed(4)} USDC on Base`);

  let llmCreditBalanceUsd: number | undefined;
  try {
    llmCreditBalanceUsd = await getLlmCreditBalanceUsd(bankrApiKey);
    info(`LLM credits:  $${llmCreditBalanceUsd.toFixed(2)}`);
  } catch (err) {
    warn(`Could not check LLM credits: ${err instanceof Error ? err.message : String(err)}`);
  }

  let llmAutoTopUpConfig: LlmAutoTopUpConfig | undefined;
  try {
    llmAutoTopUpConfig = await getLlmAutoTopUpConfig(bankrApiKey);
    info(`LLM auto top-up: ${llmAutoTopUpConfig.enabled ? "enabled" : "disabled"}`);
  } catch (err) {
    warn(`Could not check LLM auto top-up: ${err instanceof Error ? err.message : String(err)}`);
  }

  const needsInitialLlmSeed = llmCreditBalanceUsd === undefined || llmCreditBalanceUsd < 1;
  const requiredBalance = needsInitialLlmSeed ? 20 : 15;

  // The full balance (compute + first day of X API) is only required for a fresh
  // provision. When reusing an existing instance (COMPUTE_INSTANCE_ID set),
  // compute is already prepaid — don't gate on it.
  const reusingCompute = !isUnset(process.env.COMPUTE_INSTANCE_ID);

  if (!reusingCompute && usdcBalance < requiredBalance) {
    warn(`Insufficient balance: ${usdcBalance.toFixed(2)} USDC. You need at least ${requiredBalance} USDC to deploy:`);
    if (needsInitialLlmSeed) warn(`  $5   LLM Gateway credits (initial seed)`);
    else warn(`  $0   LLM Gateway credits (already at or above $1)`);
    warn(`  ~$1   First day of compute`);
    warn(`  ~$14  First day of X API usage via x402`);
    warn(`Deposit USDC on Base to: ${address}`);
    console.log("");
    console.error("  Cannot proceed — top up and re-run.");
    process.exit(1);
  }

  ok(`Balance: ${usdcBalance.toFixed(2)} USDC`);
  if (!await confirm("Proceed with deployment?", true)) process.exit(0);

  // ── Step 3: Bankr LLM Gateway setup ──────────────────────────────────────
  step(3, TOTAL_STEPS, "Bankr LLM Gateway setup");

  const needsAutoTopUp = !llmAutoTopUpConfig?.enabled;

  if (!needsInitialLlmSeed && !needsAutoTopUp) {
    ok(`LLM Gateway ready: $${llmCreditBalanceUsd?.toFixed(2)} credits and auto top-up enabled`);
  } else {
    info("This step will:");
    if (needsInitialLlmSeed) {
      info("  1. Add $5 USDC to your LLM Gateway credits because balance is below $1");
      info("  2. Enable auto top-up: $5 each time balance drops below $1, funded from Base USDC");
      info("");
      info("Cost: ~$5 USDC drawn from your Bankr wallet on Base now.");
    } else {
      info(`  1. Skip initial credit top-up; LLM Gateway already has $${llmCreditBalanceUsd?.toFixed(2)} credits`);
      info("  2. Enable auto top-up: $5 each time balance drops below $1, funded from Base USDC");
      info("");
      info("Cost now: $0 USDC. Future auto top-ups draw $5 USDC from your Bankr wallet on Base.");
    }

    const confirmMessage = needsInitialLlmSeed
      ? "Add $5 LLM credits and enable auto top-up?"
      : "Enable LLM auto top-up from Base USDC?";

    if (!await confirm(confirmMessage, true)) {
      warn("Skipped LLM Gateway setup. The agent may fail on inference when credits run out:");
      if (needsInitialLlmSeed) warn("  bankr llm credits add 5 --yes");
      warn("  bankr llm credits auto --enable --amount 5 --threshold 1 --tokens USDC");
    } else {
      console.log("");
      if (llmCreditBalanceUsd === undefined) {
        info("Checking current LLM credits...");
        llmCreditBalanceUsd = await getLlmCreditBalanceUsd(bankrApiKey);
        info(`Current LLM credits: $${llmCreditBalanceUsd.toFixed(2)}`);
      }

      if (llmCreditBalanceUsd >= 1) {
        info(`Skipping initial LLM credit top-up; balance is already $${llmCreditBalanceUsd.toFixed(2)}.`);
      } else {
        info("Adding $5 initial LLM credits...");
        const result = await topUpLlmCredits(bankrApiKey, 5);
        llmCreditBalanceUsd = result.newBalance;
        info(`New LLM credit balance: $${result.newBalance.toFixed(2)}`);
        if (result.txHash) info(`Transaction: https://basescan.org/tx/${result.txHash}`);
      }

      console.log("");
      info("Enabling auto top-up ($5 when balance < $1, funded from Base USDC)...");
      await enableLlmAutoTopUp(bankrApiKey, llmAutoTopUpToken);

      ok("LLM Gateway ready");
    }
  }

  let sshPassword = "";

  let instance: any = null;
  let instanceId = "";
  let ip = "";

  // Poll a provisioning instance until it reports a real IP, behind a spinner.
  async function pollForIp(id: string, timeoutMs: number): Promise<any> {
    const maxMinutes = Math.round(timeoutMs / 60_000);
    return spin(`Waiting for instance IP — this can take up to ${maxMinutes} min…`, async (spinner) => {
      const inst = await waitForComputeIp(bankrApiKey, address as `0x${string}`, id, timeoutMs);
      spinner.text = computeInstanceIp(inst) ? `IP assigned: ${computeInstanceIp(inst)}` : "Instance IP not ready (timed out)";
      return inst;
    });
  }

  // The one-time root password can be retrieved only ONCE per instance (a second
  // POST 409s). Persist it to .env immediately so a re-run after any later
  // failure can reuse it instead of being locked out.
  async function fetchAndSavePassword(id: string): Promise<string> {
    const pw = await fetchOneTimePassword(bankrApiKey, address as `0x${string}`, id);
    if (!pw) throw new Error("compute API returned no password");
    await setEnvVar(envPath, "COMPUTE_SSH_PASSWORD", pw);
    return pw;
  }

  // The one root-password waterfall, used by both the existing-instance path and
  // the post-provision install step: already-known (instance response) → .env →
  // fetch-once + persist (when the API can serve it) → interactive prompt.
  async function resolveSshPassword(current: string, id: string, canFetch: boolean): Promise<string> {
    let pw = current;
    if (!pw && !isUnset(process.env.COMPUTE_SSH_PASSWORD)) pw = process.env.COMPUTE_SSH_PASSWORD!;
    if (!pw && canFetch) {
      try {
        pw = await spin("Fetching one-time root password…", () => fetchAndSavePassword(id), "Got one-time root password");
      } catch (err) {
        warn(`Could not fetch one-time password: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (!pw) {
      pw = await password({ message: "Root one-time password", mask: "•", validate: (v) => v.trim() ? true : "Required." });
    }
    return pw;
  }

  const existingComputeInstanceId = !isUnset(process.env.COMPUTE_INSTANCE_ID)
    ? process.env.COMPUTE_INSTANCE_ID!
    : "";

  if (existingComputeInstanceId) {
    // ── Step 4: existing compute ────────────────────────────────────────────
    step(4, TOTAL_STEPS, "Checking existing compute");

    info(`COMPUTE_INSTANCE_ID is set: ${existingComputeInstanceId}`);
    try {
      instance = await fetchComputeInstance(bankrApiKey, address as `0x${string}`, existingComputeInstanceId);
    } catch (err) {
      warn(`Could not read compute details directly: ${err instanceof Error ? err.message : String(err)}`);
      info("If this instance was bought with another wallet, enter the IP and one-time root password from that wallet's compute response.");
      instance = { id: existingComputeInstanceId, status: "unknown" };
    }
    instanceId = computeInstanceId(instance) ?? existingComputeInstanceId;
    ip = computeInstanceIp(instance) ?? "";
    sshPassword = computeInstancePassword(instance) ?? "";

    // Instance may still be booting — poll for its IP before falling back to a prompt.
    if (!ip && instance?.status !== "unknown") {
      instance = await pollForIp(instanceId, 180_000);
      ip = computeInstanceIp(instance) ?? "";
    }
    if (!ip) {
      ip = !isUnset(process.env.COMPUTE_HOST)
        ? process.env.COMPUTE_HOST!
        : await input({ message: "Compute public IP", validate: (v) => v.trim() ? true : "Required." });
    }

    // Instances use one-time root-password auth (skip the API fetch when the
    // instance couldn't be read — it likely belongs to another wallet).
    sshPassword = await resolveSshPassword(sshPassword, instanceId, instance?.status !== "unknown");

    const remainingHours = remainingComputeHours(instance);
    if (remainingHours !== null && remainingHours >= 24) {
      ok(`Compute has ${remainingHours.toFixed(1)}h remaining; skipping compute purchase`);

      // ── Step 5: compute ready ─────────────────────────────────────────────
      step(5, TOTAL_STEPS, "Compute ready");
      ok("Reusing existing compute instance");
    } else if (remainingHours === null) {
      warn("Could not determine remaining compute hours; skipping compute purchase because an existing instance was provided");

      // ── Step 5: compute ready ─────────────────────────────────────────────
      step(5, TOTAL_STEPS, "Compute ready");
      ok("Using provided compute instance");
    } else {
      const remaining = remainingHours === null ? "unknown" : `${remainingHours.toFixed(1)}h`;
      warn(`Compute has ${remaining} remaining; extending by 24h`);

      // ── Step 5: extend compute ────────────────────────────────────────────
      step(5, TOTAL_STEPS, "Extending compute");
      await spin("Paying for +24h via x402…", () => extendComputeInstance(bankrApiKey, address as `0x${string}`, instanceId), "Compute extended by 24h");
      instance = await fetchComputeInstance(bankrApiKey, address as `0x${string}`, instanceId);
      ip = computeInstanceIp(instance) ?? ip;
    }
  } else {
    // ── Step 4: select compute ──────────────────────────────────────────────
    step(4, TOTAL_STEPS, "Selecting compute");

    info("Fetching available plans, regions and OS...");

    const [plansRes, regionsRes, osRes] = await Promise.all([
      fetch("https://compute.x402layer.cc/compute/plans?type=vps"),
      fetch("https://compute.x402layer.cc/compute/regions"),
      fetch("https://compute.x402layer.cc/compute/os"),
    ]);

    if (!plansRes.ok) throw new Error(`Failed to fetch plans: ${plansRes.status}`);
    const plansJson = await plansRes.json() as any;
    const plans: any[] = (plansJson.plans ?? plansJson.data ?? plansJson ?? [])
      .sort((a: any, b: any) => (a.our_hourly ?? 999) - (b.our_hourly ?? 999));
    if (!plans.length) throw new Error("No VPS plans found");

    const regionsJson = regionsRes.ok ? await regionsRes.json() as any : {};
    const regions: any[] = regionsJson.regions ?? regionsJson.data ?? regionsJson ?? [];

    const osJson = osRes.ok ? await osRes.json() as any : {};
    const osList: any[] = osJson.os ?? osJson.data ?? osJson ?? [];
    const ubuntu = osList.find((o: any) => /ubuntu.*22|ubuntu.*24/i.test(o.name ?? o.label ?? "")) ?? osList[0];
    const osId = ubuntu?.id ?? ubuntu?.os_id ?? 387;

    console.log("");
    const selectedPlan = await select({
      message: "Select a compute plan",
      choices: plans.map((p: any) => {
        const id = p.id ?? p.slug ?? p.name;
        const provider = p.provider ?? "unknown provider";
        const price = typeof p.our_daily === "number" ? `${formatUsd(p.our_daily, 2)}/day` : "price unavailable";
        const specs = [p.vcpu_count && `${p.vcpu_count} vCPU`, p.ram && `${p.ram}MB RAM`, p.disk && `${p.disk}GB`].filter(Boolean).join(" · ");
        return { name: `${id}  ${dim(`${provider} · ${price}${specs ? " · " + specs : ""}`)}`, value: p };
      }),
    });

    const planLocations = Array.isArray(selectedPlan.locations)
      ? new Set(selectedPlan.locations.map((location: unknown) => String(location).toLowerCase()))
      : undefined;
    const matchingRegions = planLocations
      ? regions.filter((r: any) => planLocations.has(regionCode(r)))
      : regions;
    const selectableRegions = planLocations && matchingRegions.length === 0
      ? [...planLocations].map((id) => ({ id }))
      : matchingRegions;

    if (!selectableRegions.length) {
      throw new Error(`No regions found for plan ${selectedPlan.id ?? selectedPlan.name ?? "unknown"}`);
    }

    const selectedRegion = await select({
      message: "Select a region",
      choices: selectableRegions.map((r: any) => ({
        name: regionLabel(r),
        value: r,
      })),
    });

    const planId = selectedPlan.id ?? selectedPlan.slug ?? selectedPlan.name;
    const provider = selectedPlan.provider ?? "vultr";
    const region = regionCode(selectedRegion);
    const regionName = regionLabel(selectedRegion);
    const hourlyRate = selectedPlan.our_hourly;
    const dailyRate = selectedPlan.our_daily;

    if (typeof dailyRate !== "number" && typeof hourlyRate !== "number") {
      throw new Error(`Plan ${planId} did not include our_daily or our_hourly pricing from the compute API`);
    }

    const hourlyCost = typeof hourlyRate === "number" ? `${formatUsd(hourlyRate, 4)}/hr` : "price unavailable";
    const dailyCost = typeof dailyRate === "number"
      ? formatUsd(dailyRate, 2)
      : `~${formatUsd(hourlyRate * 24, 2)}`;
    console.log("");
    info(`Plan:     ${planId} (${hourlyCost})`);
    info(`Provider: ${provider}`);
    info(`Region:   ${regionName}`);
    info(`OS:       ${ubuntu?.name ?? "Ubuntu"}`);
    info(`Cost:     1 day prepaid (${dailyCost} via x402 on Base)`);
    info("");
    info("After deployment the agent self-extends compute when < 24h remain.");

    if (!await confirm(`Provision VPS (${dailyCost} paid via x402 from your Bankr wallet)?`, true)) {
      console.log("  Aborted.");
      process.exit(0);
    }

    // ── Step 5: provision VPS ───────────────────────────────────────────────
    step(5, TOTAL_STEPS, "Provisioning VPS");

    // Provision without an SSH key — the box uses one-time root-password auth,
    // which we fetch from the compute API once it's up.
    const provisionBody = JSON.stringify({
      plan: planId,
      region,
      os_id: osId,
      label: "yappr",
      hostname: "yappr",
      prepaid_hours: 24,
      network: "base",
      provider,
    });

    const provision = await spin(
      `Paying ${dailyCost} via x402 & provisioning…`,
      () => computeX402Pay<any>(
        bankrApiKey,
        address as `0x${string}`,
        "https://compute.x402layer.cc/compute/provision",
        provisionBody,
      ),
      "Compute paid & provisioning started",
    );

    instanceId = computeInstanceId(provision) ?? "";
    if (!instanceId) throw new Error(`Provision response had no instance id: ${JSON.stringify(provision)}`);

    // Persist the id immediately — payment already happened, so a later failure
    // (e.g. IP not ready) must not orphan a paid instance on re-run.
    await setEnvVar(envPath, "COMPUTE_INSTANCE_ID", instanceId);
    ok(`Instance provisioned: ${instanceId} (saved to .env)`);

    sshPassword = computeInstancePassword(provision) ?? "";
    instance = provision;

    // Freshly provisioned instances report 0.0.0.0 until the provider boots them.
    ip = computeInstanceIp(provision) ?? "";
    if (!ip) {
      instance = await pollForIp(instanceId, 300_000);
      ip = computeInstanceIp(instance) ?? "";
    }
  }

  if (!instanceId) throw new Error("Could not resolve compute instance id");

  instance = await fetchComputeInstance(bankrApiKey, address as `0x${string}`, instanceId).catch(() => instance);
  if (!ip) ip = computeInstanceIp(instance) ?? "";
  if (!ip) throw new Error(`Could not resolve compute IP for instance ${instanceId} (still provisioning?)`);

  // Persist the resolved IP so re-runs / `npm run ssh` can skip the lookup.
  await setEnvVar(envPath, "COMPUTE_HOST", ip);

  const data = computeInstanceData(instance);
  const status = data?.status ?? "provisioning";
  const plan = data?.plan ?? data?.provider_plan_id ?? data?.vultr_plan ?? "—";
  const region = data?.region ?? data?.vultr_region ?? "—";
  const os = data?.os ?? data?.vultr_os ?? "—";
  const expiry = computeInstanceExpiry(instance);
  const expiryFmt = expiry ? expiry.toLocaleString() : "—";

  console.log("");
  printPanel("INSTANCE", [
    kvRow("Instance", instanceId),
    kvRow("IP", ip),
    kvRow("Status", status === "active" ? green(status) : status),
    kvRow("Plan", `${plan}  ${dim("·  " + region)}`),
    kvRow("OS", os),
    kvRow("Expires", expiryFmt),
  ]);

  // ── Step 6: remote setup ──────────────────────────────────────────────────
  step(6, TOTAL_STEPS, "Installing agent on VPS");

  // Password-only auth: resolve the one-time root password (response → env → fetch → prompt).
  if (!sshPassword) sshPassword = computeInstancePassword(instance) ?? "";
  sshPassword = await resolveSshPassword(sshPassword, instanceId, true);

  await spin("Waiting for SSH on port 22…", () => waitForPort(ip, 22, 120_000), "SSH port open");

  const ssh = new NodeSSH();
  await spin("Connecting via SSH…", () => ssh.connect({ host: ip, username: "root", password: sshPassword, ...hostKeyConfig(ip) }), `Connected to ${ip}`);

  // Bundle the local engine into a tarball (the server installs that exact build).
  const tarball = await spin("Bundling engine…", () => bundleEngine(), "Engine bundled");

  await spin("Uploading to /yappr…", async () => {
    // /yappr is wiped and re-uploaded each deploy, so durable data lives elsewhere:
    // the app DB sits in /var/lib/yappr (persisted across redeploys via DB_PATH).
    await sshExec(ssh, "rm -rf /yappr && mkdir -p /yappr /var/lib/yappr", { quiet: true });

    // The engine tarball + a minimal package.json that installs it.
    const tarName = basename(tarball);
    await ssh.putFile(tarball, `/yappr/${tarName}`);

    // Private staging dir (0700) for generated files — the env copy below holds
    // every credential, so it must never sit world-readable in /tmp. Always
    // removed, even when the upload fails.
    const stageDir = await mkdtemp(join(tmpdir(), "yappr-deploy-"));
    try {
      const serverPkg = { name: "yappr-instance", private: true, type: "module", dependencies: { yappr: `file:./${tarName}` } };
      const pkgTmp = join(stageDir, "package.json");
      await writeFile(pkgTmp, JSON.stringify(serverPkg, null, 2));
      await ssh.putFile(pkgTmp, "/yappr/package.json");

      // The instance's config (the user's add-ons) — skip hidden junk.
      const uploaded = await ssh.putDirectory(join(process.cwd(), "config"), "/yappr/config", {
        recursive: true,
        concurrency: 8,
        validate: (p) => !basename(p).startsWith("."),
      });
      if (!uploaded) throw new Error("Failed to upload config/ to /yappr");

      // The uploaded .env carries everything the agent needs — minus the box's own
      // root password, which the server has no use for. 0600 locally and remotely
      // (SFTP would otherwise land it 0644, readable by any non-root user).
      const cloudEnvPath = join(stageDir, "cloud.env");
      const localEnv = await readFile(envPath, "utf8");
      let cloudEnv = setEnvVarInContent(localEnv, "CLOUD_INSTANCE", "true");
      cloudEnv = setEnvVarInContent(cloudEnv, "DB_PATH", "/var/lib/yappr/yappr.db");
      cloudEnv = removeEnvVarInContent(cloudEnv, "COMPUTE_SSH_PASSWORD");
      await writeFile(cloudEnvPath, cloudEnv, { mode: 0o600 });
      await ssh.putFile(cloudEnvPath, "/yappr/.env");
      await sshExec(ssh, "chmod 600 /yappr/.env", { quiet: true });
    } finally {
      await rm(stageDir, { recursive: true, force: true });
    }
  }, "Uploaded");

  // Each step is a separate SSH command (the shell resets to / between calls, so
  // commands that need the project dir cd into /yappr themselves).

  // Node.js: only show the install spinner when it's actually missing or too old.
  // The floor is 20 — better-sqlite3@12 (a native dep) doesn't support older majors,
  // so accepting e.g. a pre-existing Node 18 would fail later, at `npm install`.
  const nodeMajor = await sshNodeMajor(ssh);
  if (nodeMajor !== null && nodeMajor >= 20) {
    ok(`Node.js already installed (v${nodeMajor})`);
  } else {
    await spin("Installing Node.js…",
      () => sshExec(ssh, "curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs", { quiet: true }),
      "Node.js ready");
  }

  // Installs the engine from the tarball + its deps (no build needed — dist ships).
  await spin("Installing engine…",
    () => sshExec(ssh, "cd /yappr && npm install", { quiet: true }), "Engine installed");

  // Migrate stats onto a FRESH box. /var/lib/yappr survives redeploys to the same
  // instance, so the DB is only absent when this is a brand-new instance. If the user
  // has a local backup (pulled by `yappr status`), offer to restore it so stats carry
  // over to the new instance. Never clobber an existing remote DB.
  const localBackup = await latestLocalBackup();
  if (localBackup && !(await remoteFileExists(ssh, REMOTE_DB_PATH))) {
    if (await confirm(`Restore the database from local backup ${backupLabel(localBackup)} onto this instance?`, true)) {
      await spin("Restoring database…", async () => {
        await sshExec(ssh, "mkdir -p /var/lib/yappr", { quiet: true });
        await ssh.putFile(localBackup, REMOTE_DB_PATH);
      }, "Database restored from backup");
    } else {
      info("Starting with a fresh database");
    }
  }

  // Only show the install spinner when pm2 is actually missing.
  if (await sshHas(ssh, "pm2")) {
    ok("pm2 already installed");
  } else {
    await spin("Installing pm2…",
      () => sshExec(ssh, "npm install -g pm2", { quiet: true }), "pm2 installed");
  }

  // Start under pm2 from /yappr so the process cwd is the project dir (config-loader
  // reads /yappr/config). The agent entry lives in the installed engine. We DELETE any
  // existing process first rather than `pm2 restart`: restart reuses the script path
  // baked in at first registration, but each deploy wipes /yappr and reinstalls the
  // engine, so a fresh start is the only way pm2 picks up the current path.
  await spin("Starting agent under pm2…", () => sshExec(ssh, `
    cd /yappr &&
    (pm2 delete yappr || true) &&
    pm2 start node_modules/yappr/dist/src/yappr.js --name yappr --update-env &&
    pm2 save &&
    (pm2 startup systemd -u root --hp /root || true)
  `, { quiet: true }), "Agent started");

  // ── Step 7: health check ──────────────────────────────────────────────────
  step(7, TOTAL_STEPS, "Health check");

  await spin("Waiting for pm2 process to come online…",
    () => sshExec(ssh, "timeout 30 bash -c 'until pm2 show yappr | grep -q online; do sleep 2; done'", { quiet: true }),
    "Agent is online");

  ssh.dispose();

  // ── Summary ───────────────────────────────────────────────────────────────
  const handle = process.env.AGENT_HANDLE;
  console.log("");
  console.log(`  ${green("✓")}  ${bold("Deployment complete")} ${dim("— your agent is live")}`);
  console.log("");
  printPanel("AGENT", [
    kvRow("Agent", accent(`@${handle}`)),
    kvRow("IP", ip),
    kvRow("Wallet", address),
    "",
    dim("The agent will:"),
    ...[
      `Poll for @${handle} mentions every 20s`,
      "Reply via Bankr LLM Gateway",
      "Self-extend compute when < 24h remain",
      "Auto top-up LLM credits when balance < $1",
    ].map((line) => `${accent("·")}  ${dim(line)}`),
    "",
    kvRow("Status", `${bold("yappr status")}   ${dim("live dashboard + logs")}`),
    kvRow("SSH", `${bold("yappr ssh")}   ${dim(`(or ssh root@${ip})`)}`),
  ]);
  console.log("");

  // Hand off to the live status dashboard (interactive terminals only). This
  // streams pm2 logs until the user hits Ctrl+C; the same view is available
  // anytime via `npm run status`.
  if (process.stdout.isTTY) {
    console.log(`  ${dim("Opening live dashboard… (Ctrl+C to exit)")}`);
    await runStatus({ ip, password: sshPassword, handle });
  }
}

export async function run(): Promise<void> {
  await main();
}

// Direct invocation (`tsx src/cli/deploy.ts`) — the bin calls run() instead.
const isMain = (() => {
  try { return fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? ""); }
  catch { return false; }
})();
if (isMain) {
  run().catch((err) => {
    // Inquirer throws ExitPromptError on Ctrl-C — exit quietly
    if (err?.name === "ExitPromptError") {
      console.log("\n  Aborted.");
      process.exit(0);
    }
    console.error(`\n  ✗  ${err.message}`);
    process.exit(1);
  });
}
