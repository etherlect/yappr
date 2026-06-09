// Manual SSH into the deployed yappr compute instance (the `yappr ssh` command).
//
//   yappr ssh                 # uses COMPUTE_INSTANCE_ID from .env
//   yappr ssh <instanceId>    # override the instance id
//
// Resolves the instance IP and one-time root password from the compute API
// (wallet-signature auth via the Bankr key), then opens an interactive shell
// using the password automatically — no prompt. Uses the ssh2 client bundled
// with node-ssh, so there's no dependency on `sshpass`.

import "dotenv/config";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
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

// Open a fully interactive PTY shell over the established connection, wiring it
// to the local terminal (raw mode, resize forwarding). Resolves with the remote
// shell's exit code.
async function interactiveShell(ssh: NodeSSH): Promise<number> {
  const conn = ssh.connection;
  if (!conn) throw new Error("SSH connection not established");

  return new Promise<number>((resolve, reject) => {
    conn.shell(
      { term: process.env.TERM || "xterm-256color" },
      (err: Error | undefined, stream: any) => {
        if (err) return reject(err);

        const stdin = process.stdin;
        const wasRaw = !!stdin.isRaw;
        if (stdin.isTTY) stdin.setRawMode(true);
        stdin.resume();

        stdin.pipe(stream);
        stream.pipe(process.stdout);
        stream.stderr.pipe(process.stderr);

        const syncWindow = () => stream.setWindow(process.stdout.rows ?? 24, process.stdout.columns ?? 80, 0, 0);
        process.stdout.on("resize", syncWindow);
        syncWindow();

        let exitCode = 0;
        stream.on("exit", (code: number | null) => { exitCode = code ?? 0; });
        stream.on("close", () => {
          process.stdout.off("resize", syncWindow);
          stdin.unpipe(stream);
          if (stdin.isTTY) stdin.setRawMode(wasRaw);
          stdin.pause();
          resolve(exitCode);
        });
        stream.on("error", reject);
      },
    );
  });
}

// Connect with a password via the bundled ssh2 client and run an interactive
// shell. Returns the remote shell's exit code.
async function connectAndShell(ip: string, pw: string): Promise<number> {
  const ssh = new NodeSSH();
  await ssh.connect({ host: ip, username: "root", password: pw, tryKeyboard: true });
  const code = await interactiveShell(ssh);
  ssh.dispose();
  return code;
}

async function main() {
  const instanceIdArg = process.argv[2];

  // Fast path: if the deploy already cached the IP (COMPUTE_HOST) and password
  // (COMPUTE_SSH_PASSWORD), connect directly with ZERO Bankr/compute API calls.
  // Only when using the default instance (no explicit id override), since the
  // cached IP belongs to COMPUTE_INSTANCE_ID. Any connection failure (e.g. the
  // instance was reprovisioned and the cached IP is stale) falls through to the
  // full resolve-from-API path below.
  const cachedIp = process.env.COMPUTE_HOST;
  const cachedPw = process.env.COMPUTE_SSH_PASSWORD;
  if (!instanceIdArg && cachedIp && cachedPw) {
    try {
      console.log(`Using cached credentials. Connecting to root@${cachedIp}…\n`);
      const code = await connectAndShell(cachedIp, cachedPw);
      process.exit(code);
    } catch (err) {
      console.warn(`Cached connection failed (${err instanceof Error ? err.message : String(err)}); resolving from the compute API…\n`);
    }
  }

  // Slow path: resolve the IP + one-time password from the compute API (this is
  // what requires the Bankr key + wallet signatures).
  const apiKey = process.env.BANKR_API_KEY;
  if (!apiKey) throw new Error("BANKR_API_KEY not set in .env");

  const instanceId = instanceIdArg || process.env.COMPUTE_INSTANCE_ID;
  if (!instanceId) throw new Error("No instance id — pass one as an argument or set COMPUTE_INSTANCE_ID in .env");

  const spinner = ora("Resolving instance credentials…").start();
  let ip: string | undefined;
  let pw: string | undefined;
  try {
    const address = await resolveEvmAddress(apiKey);
    const instance = await fetchComputeInstance(apiKey, address, instanceId);
    ip = computeInstanceIp(instance);
    if (!ip) throw new Error(`Instance has no IP yet (status: ${instance?.status ?? instance?.order?.status ?? "unknown"})`);

    // The one-time password can only be fetched ONCE per instance. The deploy
    // saves it to .env after fetching, so prefer that before hitting the API.
    pw = computeInstancePassword(instance) || process.env.COMPUTE_SSH_PASSWORD || undefined;
    if (!pw) pw = await fetchOneTimePassword(apiKey, address, instanceId);
    spinner.succeed("Credentials resolved");
  } catch (err) {
    spinner.fail();
    throw err;
  }

  console.log(`\nInstance: ${instanceId}`);
  console.log(`IP:       ${ip}`);

  // With a password we can log in directly via the ssh2 client (no prompt).
  if (pw) {
    console.log(`Connecting to root@${ip}…\n`);
    const code = await connectAndShell(ip, pw);
    process.exit(code);
  }

  // No password available — fall back to the system ssh client (will prompt / use keys).
  console.warn("Password unavailable — falling back to system ssh (key auth or prompt).\n");
  const child = spawn("ssh", ["-o", "StrictHostKeyChecking=accept-new", `root@${ip}`], { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 0));
}

export async function run(): Promise<void> {
  await main();
}

// Direct invocation (`tsx src/cli/ssh.ts`) — the bin calls run() instead.
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
