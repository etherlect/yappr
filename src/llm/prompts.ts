import { readFile } from "node:fs/promises";
import type { SkillDef } from "../skills/types.js";
import { AGENT_INSTRUCTIONS } from "../reply/agent.js";
import { listContextFiles, resolveContextFile } from "../config-loader.js";

// Files excluded from auto-loading. personality.md / security.md have dedicated
// headings/placement below; agent.md is reserved — the agent-loop instructions now
// come from src (AGENT_INSTRUCTIONS), so a stray config/context/agent.md is ignored.
// Every *other* .md in config/context/ is auto-loaded as its own "## <Title>" section.
const SPECIAL_FILES = new Set(["agent.md", "personality.md", "security.md"]);

async function readContext(filename: string, required = false): Promise<string> {
  const path = resolveContextFile(filename);
  if (!path) {
    if (required) throw new Error(`Missing required context file: context/${filename}`);
    return "";
  }
  try {
    return await readFile(path, "utf8");
  } catch {
    if (required) throw new Error(`Missing required context file: context/${filename}`);
    return "";
  }
}

// Any extra .md dropped into config/context/ (not one of SPECIAL_FILES) is loaded
// automatically. Sorted by filename so order is deterministic and controllable via
// a numeric prefix (e.g. 01-foo.md, 02-bar.md).
async function listExtraContextFiles(): Promise<string[]> {
  const files = (await listContextFiles()).map((e) => e.name);
  return files.filter((f) => !SPECIAL_FILES.has(f)).sort();
}

// "trading-rules.md" -> "Trading Rules" (used as the section heading).
function titleFromFilename(file: string): string {
  return file.replace(/\.md$/, "")
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export type Prompts = {
  agent: string;       // for regular users — admin skills excluded
  agentAdmin: string;  // for admin users — all skills included
};

// Rules can be scoped to one audience with HTML-comment markers (in any context file):
//   <!-- public-only -->…<!-- /public-only -->  → normal users only (not admins)
//   <!-- admin-only  -->…<!-- /admin-only  -->  → admins only (not normal users)
// e.g. the wallet-action prohibition is public-only, so it doesn't stop admins
// from invoking wallet/treasury skills. Markers themselves never reach the LLM.
const PUBLIC_ONLY = /<!-- public-only -->([\s\S]*?)<!-- \/public-only -->/g;
const ADMIN_ONLY = /<!-- admin-only -->([\s\S]*?)<!-- \/admin-only -->/g;

// Resolve the public-only/admin-only markers for one audience. Applied to every
// context file so any of them can scope content the same way security.md does.
function scopeForAudience(text: string, isAdmin: boolean): string {
  return (isAdmin
    ? text.replace(ADMIN_ONLY, "$1").replace(PUBLIC_ONLY, "")
    : text.replace(PUBLIC_ONLY, "$1").replace(ADMIN_ONLY, "")
  ).trim();
}

export async function loadPrompts(skills: SkillDef[]): Promise<Prompts> {
  const [personality, security] = await Promise.all([
    readContext("personality.md"),
    readContext("security.md"),
  ]);

  const extraFiles = await listExtraContextFiles();
  const extras = await Promise.all(
    extraFiles.map(async (file) => ({ title: titleFromFilename(file), content: await readContext(file) })),
  );

  // Standing context, shown before the skills/guidance sections. Personality and
  // security keep their fixed headings; every other .md becomes its own section,
  // and all of them honor the public-only/admin-only markers per audience.
  const preamble = (isAdmin: boolean) => [
    personality && `## Agent Personality\n${scopeForAudience(personality, isAdmin)}`,
    security && `## Security Rules\n${scopeForAudience(security, isAdmin)}`,
    ...extras.map(({ title, content }) => {
      const scoped = scopeForAudience(content, isAdmin);
      return scoped && `## ${title}\n${scoped}`;
    }),
  ].filter(Boolean).join("\n\n");

  const publicSkills = skills.filter((s) => s.access === "all");

  return {
    agent: buildAgentPrompt(preamble(false), publicSkills, AGENT_INSTRUCTIONS),
    agentAdmin: buildAgentPrompt(preamble(true), skills, AGENT_INSTRUCTIONS),
  };
}

// One "## <heading>" section listing each skill as "### name / description / body",
// or "" when the list is empty (so the section drops out of the prompt entirely).
function skillsSection(heading: string, skills: SkillDef[]): string {
  if (skills.length === 0) return "";
  const entries = skills.map((s) => {
    const lines = [`### ${s.name}`, s.description];
    if (s.body) lines.push("", s.body);
    return lines.join("\n");
  });
  return `## ${heading}\n\n${entries.join("\n\n")}`;
}

function buildAgentPrompt(preamble: string, skills: SkillDef[], instructions: string): string {
  const toolsSection = skillsSection("Skills (tools you can call)", skills.filter((s) => s.handler));
  const guidanceSection = skillsSection("Response Guidance", skills.filter((s) => !s.handler));
  return [preamble, toolsSection, guidanceSection, instructions].filter(Boolean).join("\n\n");
}
