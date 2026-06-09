// Stats DB backup/restore helpers shared by the CLI.
//
// The agent's stats live in a SQLite DB on the server at /var/lib/yappr/yappr.db
// (outside the redeploy-wiped /yappr, so it survives redeploys to the SAME instance).
// To survive *switching* instances, the status dashboard periodically pulls a
// consistent snapshot down into instance/backups/, and a fresh deploy offers to
// restore the latest snapshot onto the new box. Everything here is best-effort.

import { resolve, join, basename } from "node:path";
import { mkdir, readdir, unlink } from "node:fs/promises";
import type { NodeSSH } from "node-ssh";

// Where the server keeps the live DB (matches DB_PATH set by deploy).
export const REMOTE_DB_PATH = "/var/lib/yappr/yappr.db";

// Keep at most this many daily snapshots (one file per day) — ~one week of coverage.
const MAX_LOCAL_BACKUPS = 7;

export function backupDir(): string {
  return resolve(process.cwd(), "backups");
}

// Day stamp (YYYY-MM-DD) for the local filename — lexically sortable (= chronological).
// Repeated backups within a day overwrite the same file, so we keep one snapshot per day.
function dayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

async function listBackups(): Promise<string[]> {
  try {
    return (await readdir(backupDir()))
      .filter((f) => f.startsWith("yappr-") && f.endsWith(".db"))
      .sort();
  } catch {
    return [];
  }
}

// Path to the newest local backup, or null if there are none.
export async function latestLocalBackup(): Promise<string | null> {
  const files = await listBackups();
  return files.length ? join(backupDir(), files[files.length - 1]) : null;
}

// Single-quote a path for safe interpolation into a remote shell command.
const shq = (p: string) => `'${p.split("'").join(`'\\''`)}'`;

// True if `path` exists on the remote host. Decided by `test -f`'s exit code —
// never by parsing stdout, which channel noise could corrupt.
export async function remoteFileExists(ssh: NodeSSH, path: string): Promise<boolean> {
  const r = await ssh.execCommand(`test -f ${shq(path)}`, { cwd: "/" });
  return r.code === 0;
}

// Snapshot the server DB (consistent, via SQLite VACUUM INTO in stats-cli) and pull it
// into instance/backups/. Returns the local file path. Throws on failure (callers are
// best-effort and catch).
export async function backupRemoteDb(ssh: NodeSSH): Promise<string> {
  // Remote temp is uniquely named (VACUUM INTO requires a non-existent dest); the local
  // file is named per-day, so a later backup the same day overwrites it.
  const remoteTmp = `/tmp/yappr-backup-${Date.now()}.db`;

  // `cd /yappr` so stats-cli's dotenv picks up DB_PATH; the engine lives in node_modules.
  const snap = await ssh.execCommand(
    `cd /yappr && node node_modules/yappr/dist/src/stats-cli.js backup ${shq(remoteTmp)}`,
    { cwd: "/" },
  );
  if (snap.code !== 0) {
    throw new Error((snap.stderr || snap.stdout || "remote snapshot failed").trim());
  }

  await mkdir(backupDir(), { recursive: true });
  const local = join(backupDir(), `yappr-${dayStamp()}.db`);
  try {
    await ssh.getFile(local, remoteTmp);
  } finally {
    // Remove the remote snapshot even when the download fails — each one is a
    // full DB copy, and stranded ones would pile up in the server's /tmp.
    await ssh.execCommand(`rm -f ${shq(remoteTmp)}`, { cwd: "/" }).catch(() => {});
  }

  await pruneOldBackups();
  return local;
}

async function pruneOldBackups(): Promise<void> {
  const files = await listBackups();
  const excess = files.slice(0, Math.max(0, files.length - MAX_LOCAL_BACKUPS));
  await Promise.all(excess.map((f) => unlink(join(backupDir(), f)).catch(() => {})));
}

// Short, cwd-relative label for a backup path (e.g. "backups/yappr-….db").
export function backupLabel(absPath: string): string {
  return `backups/${basename(absPath)}`;
}
