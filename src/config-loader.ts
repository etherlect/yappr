import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti";

// Config (skills / hooks / context) is purely the user's — add-ons loaded from the
// project's ./config, never essential to the engine. We ship a starter set and
// scaffold it on `yappr init`, but the user can edit or delete any of it. Skills and
// hooks import the engine as "yappr" (src/index.ts), so they load like any user
// module: a .ts loads via jiti with no build step and still resolves the engine to
// the single running instance (jiti defers to native import for the .js engine).
export const CONFIG_DIR = resolve(process.cwd(), "config");

let jiti: ReturnType<typeof createJiti> | null = null;

// Import a config module by absolute path. Native import handles .js (and .ts under
// a TS runtime like tsx in dev); jiti is the fallback so plain node loads a .ts.
export async function importConfigModule(absPath: string): Promise<Record<string, unknown>> {
  try {
    return await import(pathToFileURL(absPath).href);
  } catch (err) {
    if (absPath.endsWith(".ts")) {
      jiti ??= createJiti(import.meta.url);
      return jiti.import(absPath) as Promise<Record<string, unknown>>;
    }
    throw err;
  }
}

function firstExisting(...candidates: string[]): string | null {
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

export type SkillEntry = { name: string; mdPath: string; handlerPath: string | null };

// A skill is a ./config/skills/<name>/ dir containing skill.md; handler.{ts,js} is
// optional (its absence = context-only skill).
export async function listSkills(): Promise<SkillEntry[]> {
  const skillsDir = join(CONFIG_DIR, "skills");
  const dirents = await readdir(skillsDir, { withFileTypes: true }).catch(() => null);
  if (!dirents) return [];
  const out: SkillEntry[] = [];
  for (const d of dirents) {
    if (!d.isDirectory() || d.name.startsWith(".")) continue;
    const dir = join(skillsDir, d.name);
    const mdPath = join(dir, "skill.md");
    if (!existsSync(mdPath)) continue;
    out.push({ name: d.name, mdPath, handlerPath: firstExisting(join(dir, "handler.ts"), join(dir, "handler.js")) });
  }
  return out;
}

export type HookEntry = { name: string; modulePath: string };

export async function listHooks(): Promise<HookEntry[]> {
  const hooksDir = join(CONFIG_DIR, "hooks");
  const entries = await readdir(hooksDir).catch(() => null);
  if (!entries) return [];
  const byName = new Map<string, HookEntry>();
  for (const f of entries) {
    const m = f.match(/^(.+)\.(?:ts|js)$/);
    if (!m || f.startsWith(".")) continue;
    const name = m[1];
    const modulePath = firstExisting(join(hooksDir, `${name}.ts`), join(hooksDir, `${name}.js`));
    if (modulePath) byName.set(name, { name, modulePath });
  }
  return [...byName.values()];
}

export type ContextEntry = { name: string; path: string };

export async function listContextFiles(): Promise<ContextEntry[]> {
  const dir = join(CONFIG_DIR, "context");
  const entries = await readdir(dir).catch(() => null);
  if (!entries) return [];
  return entries
    .filter((f) => f.endsWith(".md") && !f.startsWith("."))
    .map((f) => ({ name: f, path: join(dir, f) }));
}

export function resolveContextFile(filename: string): string | null {
  const p = join(CONFIG_DIR, "context", filename);
  return existsSync(p) ? p : null;
}
