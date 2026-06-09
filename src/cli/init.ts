import { cp, mkdir, access } from "node:fs/promises";
import { basename, dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

// The installed package ships a starter config/ + .env.example (see package.json
// "files"); init copies them into the user's project so they have something useful
// to edit. Package root is three levels up from dist/src/cli/init.js (and from
// src/cli/init.ts in the repo).
const here = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(here, "..", "..", "..");

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

// Scaffold a new project. Never clobbers existing files — config is the user's once
// it's there, so re-running init is safe.
export async function runInit(targetArg = "."): Promise<void> {
  const target = resolve(process.cwd(), targetArg);
  await mkdir(target, { recursive: true });

  const destConfig = join(target, "config");
  if (await exists(destConfig)) {
    console.log("• config/ already exists — left untouched");
  } else {
    // Skip hidden files (e.g. a stray .DS_Store) so the scaffold stays clean.
    await cp(join(PKG_ROOT, "config"), destConfig, {
      recursive: true,
      filter: (src) => !basename(src).startsWith("."),
    });
    console.log("• scaffolded config/ — starter skills, hooks and context (edit or delete freely)");
  }

  const destEnv = join(target, ".env");
  const examplePath = join(PKG_ROOT, ".env.example");
  if (await exists(destEnv)) {
    console.log("• .env already exists — left untouched");
  } else if (await exists(examplePath)) {
    await cp(examplePath, destEnv);
    console.log("• created .env from .env.example — fill in your keys");
  }

  const where = targetArg === "." ? "" : `cd ${targetArg} && `;
  console.log(`\nDone. Next:\n  ${where}# edit .env, then run the agent\n  npx yappr start\n`);
}
