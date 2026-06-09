import { readFile } from "node:fs/promises";
import { log } from "../log.js";
import { listSkills, importConfigModule } from "../config-loader.js";
import type { SkillDef, SkillHandler } from "./types.js";

function parseFrontmatter(raw: string): { name: string; description: string; body: string; access: "all" | "admin" } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { name: "", description: "", body: raw.trim(), access: "all" };
  const meta = match[1];
  const body = match[2].trim();
  const name = meta.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? "";
  const description = meta.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? "";
  const accessRaw = meta.match(/^access:\s*(.+)$/m)?.[1]?.trim();
  const access = accessRaw === "admin" ? "admin" : "all";
  return { name, description, body, access };
}

export async function loadSkills(): Promise<SkillDef[]> {
  const skills: SkillDef[] = [];

  // Discovery (which skills exist, and where their skill.md + handler live) is owned
  // by config-loader, so user and built-in config layer the same way everywhere.
  for (const entry of await listSkills()) {
    try {
      const raw = await readFile(entry.mdPath, "utf8");
      const { name, description, body, access } = parseFrontmatter(raw);
      if (!name || !description) {
        log.warn({ entry: entry.name }, "skill skipped: missing name or description");
        continue;
      }

      // A skill with no handler file is context-only. If a handler file is present
      // but fails to import, that's a real error worth surfacing (not silent).
      let handler: SkillHandler | undefined;
      if (entry.handlerPath) {
        try {
          const mod = await importConfigModule(entry.handlerPath);
          if (typeof mod.handler === "function") handler = mod.handler as SkillHandler;
        } catch (err: any) {
          log.warn({ entry: entry.name, err: err?.message }, "skill handler failed to load; treating as context-only");
        }
      }

      skills.push({ name, description, body, access, handler });
      log.info({ name, access, type: handler ? "handler" : "context-only" }, `skill loaded: ${name}`);
    } catch (err: any) {
      log.error({ entry: entry.name, err: err.message }, `skill load failed: ${entry.name}`);
    }
  }
  return skills;
}
