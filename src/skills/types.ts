import type { Tweet } from "../x/types.js";

// What a skill handler returns to the agent loop. The loop feeds this back to
// the model as the "Observation" for that step (see src/reply/agent.ts), which
// the model then uses to decide the next step or write the final reply.
export type SkillResult = {
  text?: string;     // a ready string observation (e.g. "posted", or a short answer)
  data?: unknown;    // structured data — JSON-stringified into the observation
  mediaUrl?: string; // image/video URL to attach (requires media support in x/client.ts)
};

export type SkillHandler = (
  params: Record<string, string>,
  tweet: Tweet,
) => Promise<SkillResult>;

export type SkillAccess = "all" | "admin";

export type SkillDef = {
  name: string;
  description: string;
  body: string;           // skill.md content after frontmatter — injected into the agent system prompt
  access: SkillAccess;    // "all" = any user, "admin" = ADMIN_HANDLES only
  handler?: SkillHandler; // omit for context-only skills (no code execution, LLM uses skill body as reply guidance)
};
