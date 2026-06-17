// Provenance tracking for the scaffolded config/, so `yappr update` can tell which
// skill/hook/context files the user has edited from those still pristine.
//
// `init` records a manifest — the hash of every file it scaffolded — at
// config/.yappr-sync.json. On `update`, for each file the new package ships we compare
// the user's copy against (a) the recorded hash (what we last installed) and (b) the
// new shipped hash, to decide: fast-forward an untouched file, leave/ask on an edited
// one, or create a brand-new one. The manifest is dot-prefixed so the engine's config
// loader (which skips dotfiles) never treats it as a skill.

import { createHash } from "node:crypto";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";

export const MANIFEST_NAME = ".yappr-sync.json";

// sha256 of a file's bytes, or null if it doesn't exist / can't be read.
export async function hashFile(path: string): Promise<string | null> {
  try {
    return createHash("sha256").update(await readFile(path)).digest("hex");
  } catch {
    return null;
  }
}

// All files under `dir`, as forward-slash relative paths, skipping any dot-prefixed
// file or directory (matches init's scaffold filter and the engine's loader). Returns
// [] if `dir` is absent.
export async function relFiles(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  async function walk(abs: string): Promise<void> {
    const entries = await readdir(abs, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const child = join(abs, e.name);
      if (e.isDirectory()) await walk(child);
      else if (e.isFile()) out.push(relative(dir, child).split(sep).join("/"));
    }
  }
  await walk(dir);
  return out.sort();
}

export type Manifest = Record<string, string>; // relPath → sha256 of the last-installed version

export async function loadManifest(configDir: string): Promise<Manifest> {
  try {
    const raw = await readFile(join(configDir, MANIFEST_NAME), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed.files ?? parsed) as Manifest : {};
  } catch {
    return {};
  }
}

export async function saveManifest(configDir: string, files: Manifest): Promise<void> {
  const body = { version: 1, updatedAt: new Date().toISOString(), files };
  await writeFile(join(configDir, MANIFEST_NAME), JSON.stringify(body, null, 2) + "\n");
}

// Build a manifest by hashing every (non-dot) file in a config dir — used by init to
// record exactly what it scaffolded.
export async function manifestForDir(configDir: string): Promise<Manifest> {
  const files = await relFiles(configDir);
  const out: Manifest = {};
  for (const rel of files) {
    const h = await hashFile(join(configDir, rel));
    if (h) out[rel] = h;
  }
  return out;
}
