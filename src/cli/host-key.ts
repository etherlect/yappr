// Trust-on-first-use SSH host-key pinning for the CLI's node-ssh connections
// (deploy / status / ssh). ssh2 accepts ANY host key by default, and the target
// IP comes from a third-party compute API — without pinning, a reassigned or
// spoofed IP would silently receive the root password (and then the full .env).
// The first connection records the host's key fingerprint in .yappr-known-hosts
// (next to .env; one "host fingerprint" line per host); later connections refuse
// a changed key instead of proceeding.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const KNOWN_HOSTS_PATH = resolve(process.cwd(), ".yappr-known-hosts");

function loadKnownHosts(): Map<string, string> {
  const map = new Map<string, string>();
  try {
    for (const line of readFileSync(KNOWN_HOSTS_PATH, "utf8").split("\n")) {
      const [host, fp] = line.trim().split(/\s+/);
      if (host && fp) map.set(host, fp);
    }
  } catch { /* no file yet */ }
  return map;
}

function saveKnownHosts(map: Map<string, string>): void {
  const body = [...map].map(([h, fp]) => `${h} ${fp}`).join("\n") + "\n";
  try { writeFileSync(KNOWN_HOSTS_PATH, body, { mode: 0o600 }); } catch { /* best-effort */ }
}

// ssh2 connect-config fragment — spread into every `ssh.connect({...})`. With
// `hostHash` set, the verifier receives the host key's sha256 hash as a string.
export function hostKeyConfig(host: string): { hostHash: "sha256"; hostVerifier: (hash: string) => boolean } {
  return {
    hostHash: "sha256",
    hostVerifier: (hash: string) => {
      const known = loadKnownHosts();
      const pinned = known.get(host);
      if (!pinned) { known.set(host, hash); saveKnownHosts(known); return true; }
      if (pinned === hash) return true;
      console.error(`\n  SSH host key for ${host} changed (pinned ${pinned}, got ${hash}).`);
      console.error(`  If the instance was reprovisioned, remove the ${host} line from ${KNOWN_HOSTS_PATH} and retry.`);
      return false;
    },
  };
}
