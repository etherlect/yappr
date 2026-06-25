// `yappr logs` — pull ALL of the deployed agent's logs into a local .txt and open it.
//
//   yappr logs                 # uses cached COMPUTE_HOST/PW or COMPUTE_INSTANCE_ID from .env
//   yappr logs <instanceId>    # override the instance id
//
// Unlike the status dashboard (which tails the last few lines live), this reads the
// agent's full pm2 stdout + stderr log files, merges them in chronological order,
// strips the ANSI colors pino-pretty wrote into them, writes the result to a temp
// .txt, and opens it in the OS default viewer. Connection is resolved the same way
// as `yappr ssh`: cached credentials first (zero API calls), then the compute API.
//
// `dumpLogs()` is exported so the status dashboard can grab logs over its EXISTING
// SSH connection (the `l` key) without tearing down the TUI.

import "dotenv/config";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ora from "ora";
import { NodeSSH } from "node-ssh";
import {
  resolveEvmAddress,
  fetchComputeInstance,
  fetchOneTimePassword,
  computeInstanceIp,
  computeInstancePassword,
} from "../compute.js";
import { hostKeyConfig } from "./host-key.js";

const PM2_APP = "yappr";
// Conventional pm2 paths for the agent (root user), used if `pm2 jlist` can't be read.
const FALLBACK_PATHS = { out: "/root/.pm2/logs/yappr-out.log", err: "/root/.pm2/logs/yappr-error.log" };

// pino-pretty writes SGR color codes (ESC[…m) into the pm2 log files; strip them for a clean .txt.
const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g");
const stripAnsi = (s: string): string => s.replace(ANSI, "");

const human = (bytes: number): string => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`);

// Resolve the instance IP + one-time password from the compute API (the path that
// needs the Bankr key + wallet signatures). Mirrors `yappr ssh`.
async function resolveViaApi(instanceIdArg?: string): Promise<{ ip: string; password: string }> {
  const apiKey = process.env.BANKR_API_KEY;
  if (!apiKey) throw new Error("BANKR_API_KEY not set in .env");
  const instanceId = instanceIdArg || process.env.COMPUTE_INSTANCE_ID;
  if (!instanceId) throw new Error("No instance id — pass one as an argument or set COMPUTE_INSTANCE_ID in .env");

  const spinner = ora("Resolving instance credentials…").start();
  try {
    const address = await resolveEvmAddress(apiKey);
    const instance = await fetchComputeInstance(apiKey, address, instanceId);
    const ip = computeInstanceIp(instance);
    if (!ip) throw new Error(`Instance has no IP yet (status: ${instance?.status ?? instance?.order?.status ?? "unknown"})`);
    const password =
      computeInstancePassword(instance) ||
      process.env.COMPUTE_SSH_PASSWORD ||
      (await fetchOneTimePassword(apiKey, address, instanceId));
    if (!password) throw new Error("Could not obtain an SSH password for the instance");
    spinner.succeed("Credentials resolved");
    return { ip, password };
  } catch (err) {
    spinner.fail();
    throw err;
  }
}

// Ask pm2 for the exact out/err log paths of the yappr process; fall back to the
// conventional locations if jlist can't be parsed.
async function logPaths(ssh: NodeSSH): Promise<{ out: string; err: string }> {
  const res = await ssh.execCommand("pm2 jlist", { cwd: "/" }).catch(() => null);
  if (!res?.stdout?.trim()) return FALLBACK_PATHS;
  try {
    const list = JSON.parse(res.stdout) as Array<{ name?: string; pm2_env?: { pm2_out_log_path?: string; pm2_err_log_path?: string } }>;
    const proc = list.find((p) => p.name === PM2_APP);
    return {
      out: proc?.pm2_env?.pm2_out_log_path || FALLBACK_PATHS.out,
      err: proc?.pm2_env?.pm2_err_log_path || FALLBACK_PATHS.err,
    };
  } catch {
    return FALLBACK_PATHS;
  }
}

// Read a remote file in full; "" if it's missing or empty.
async function readRemote(ssh: NodeSSH, path: string): Promise<string> {
  const res = await ssh.execCommand(`cat ${JSON.stringify(path)} 2>/dev/null`, { cwd: "/" }).catch(() => null);
  return res?.stdout ?? "";
}

// Merge stdout + stderr into one chronological stream. pino-pretty writes one line
// per entry prefixed with [YYYY-MM-DD HH:MM:SS], so we tag each line with the most
// recent timestamp it carries (continuation lines inherit the previous one) and
// stable-sort by it — equal timestamps keep stdout before stderr and original order.
function mergeLogs(out: string, err: string): string {
  const TS = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/;
  const tag = (text: string) => {
    let last = "";
    return stripAnsi(text)
      .split("\n")
      .filter((l) => l.length > 0)
      .map((line) => {
        const m = line.match(TS);
        if (m) last = m[1];
        return { line, ts: last };
      });
  };
  const all = [...tag(out), ...tag(err)];
  all.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0)); // stable since Node 20
  return all.map((e) => e.line).join("\n");
}

// Open a file in the OS default application. Best-effort: the path is always printed.
function openFile(path: string): void {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [path]]
    : process.platform === "win32" ? ["cmd", ["/c", "start", "", path]]
    : ["xdg-open", [path]];
  try {
    spawn(cmd as string, args as string[], { stdio: "ignore", detached: true }).unref();
  } catch {
    /* opening is best-effort */
  }
}

// Read the full logs over an already-connected SSH session, write the merged+cleaned
// dump to a timestamped temp .txt, and open it. Returns the summary, or null if the
// instance has no logs yet. Pure of console/spinner output so callers (CLI + the
// status dashboard) can report however they like.
export async function dumpLogs(ssh: NodeSSH, instanceLabel: string): Promise<{ file: string; lines: number; bytes: number } | null> {
  const paths = await logPaths(ssh);
  const [out, err] = await Promise.all([readRemote(ssh, paths.out), readRemote(ssh, paths.err)]);
  if (!out.trim() && !err.trim()) return null;

  const merged = mergeLogs(out, err);
  const header = [
    "# yappr logs",
    `# instance: ${instanceLabel}`,
    `# fetched:  ${new Date().toISOString()}`,
    `# sources:  ${paths.out} (${human(Buffer.byteLength(out))}) · ${paths.err} (${human(Buffer.byteLength(err))})`,
    "",
    "",
  ].join("\n");

  const file = join(tmpdir(), `yappr-logs-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`);
  await writeFile(file, header + merged + "\n", "utf8");
  openFile(file);
  return { file, lines: merged ? merged.split("\n").length : 0, bytes: Buffer.byteLength(merged) };
}

// Open an SSH session to the instance, trying cached credentials first (no API
// calls), then the compute API; a connection failure on the cached IP (e.g. a
// reprovisioned instance) falls through to the API.
async function connectToInstance(instanceIdArg?: string): Promise<{ ssh: NodeSSH; ip: string }> {
  const sources: Array<{ label: string; get: () => Promise<{ ip: string; password: string }> }> = [];
  const cachedIp = process.env.COMPUTE_HOST;
  const cachedPw = process.env.COMPUTE_SSH_PASSWORD;
  if (!instanceIdArg && cachedIp && cachedPw) {
    sources.push({ label: "cached credentials", get: async () => ({ ip: cachedIp, password: cachedPw }) });
  }
  sources.push({ label: "compute API", get: () => resolveViaApi(instanceIdArg) });

  let lastErr: unknown;
  for (const source of sources) {
    let creds: { ip: string; password: string };
    try {
      creds = await source.get();
    } catch (err) {
      lastErr = err;
      continue;
    }
    const ssh = new NodeSSH();
    const spinner = ora(`Connecting to root@${creds.ip} (${source.label})…`).start();
    try {
      await ssh.connect({ host: creds.ip, username: "root", password: creds.password, tryKeyboard: true, ...hostKeyConfig(creds.ip) });
      spinner.succeed(`Connected to root@${creds.ip}`);
      return { ssh, ip: creds.ip };
    } catch (err) {
      spinner.fail(`Connection via ${source.label} failed`);
      lastErr = err;
      try { ssh.dispose(); } catch { /* ignore */ }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("Could not connect to the instance");
}

async function main() {
  const instanceIdArg = process.argv[2];
  const { ssh, ip } = await connectToInstance(instanceIdArg);
  const spinner = ora("Fetching logs…").start();
  try {
    const result = await dumpLogs(ssh, instanceIdArg || process.env.COMPUTE_INSTANCE_ID || ip);
    if (!result) {
      spinner.info("No logs available yet on the instance.");
      return;
    }
    spinner.succeed(`Fetched ${result.lines.toLocaleString()} log lines (${human(result.bytes)})`);
    console.log(`\n  Saved and opened:\n  ${result.file}\n`);
  } finally {
    ssh.dispose();
  }
}

export async function run(): Promise<void> {
  await main();
}

// Direct invocation (`tsx src/cli/logs.ts`) — the bin calls run() instead.
const isMain = (() => {
  try { return fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? ""); }
  catch { return false; }
})();
if (isMain) {
  run().catch((err) => {
    console.error("Error:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
