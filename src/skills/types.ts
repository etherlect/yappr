import type { Tweet } from "../x/types.js";

// What a skill handler returns to the agent loop. The loop feeds this back to
// the model as the "Observation" for that step (see src/reply/agent.ts), which
// the model then uses to decide the next step or write the final reply.
export type SkillResult = {
  text?: string;       // a ready string observation (e.g. "posted", or a short answer)
  data?: unknown;      // structured data — JSON-stringified into the observation
  // media_id(s) of images this skill uploaded to X (e.g. chart, generate-image). They are
  // surfaced to the agent in the observation so it can attach them to its own reply, or
  // pass them to an x-write post (quote / new tweet / reply elsewhere). NEVER auto-attached.
  mediaIds?: string[];
};

export type SkillHandler = (
  params: Record<string, string>,
  tweet: Tweet,
) => Promise<SkillResult>;

export type SkillAccess = "all" | "admin" | "holder";

export type SkillDef = {
  name: string;
  description: string;
  body: string;           // skill.md content after frontmatter — injected into the agent system prompt
  access: SkillAccess;    // "all" = any user, "admin" = ADMIN_HANDLES only, "holder" = holders of the agent's token
  // For `access: holder` skills: minimum balance of the agent's token (whole
  // tokens) the asker must hold, from the `min_holding:` frontmatter key.
  // Enforced in code against DB-cached holdings (src/skills/holder-access.ts).
  // 0/absent = any user with a known Bankr wallet qualifies.
  minHolding?: number;
  handler?: SkillHandler; // omit for context-only skills (no code execution, LLM uses skill body as reply guidance)
};
