// Shared labels and format for the context blocks fed to the LLM. Used by
// pipeline.ts (which emits the blocks) and by the agent instructions in agent.ts
// (which tell the model how to read them) — kept here so the two can never drift.

export const BLOCK = {
  asker: "ASKER TWEET",
  replyTo: "REPLY-TO TWEET",
  root: "CONVERSATION ROOT TWEET",
} as const;

// Header for a tweet referenced by the asker tweet (e.g. a quoted tweet). The id
// and type come straight from the asker tweet's referenced_tweets entry.
export function referencedBlockLabel(id: string, type: string): string {
  return `REFERENCED TWEET IN THE ASKER TWEET (ID: ${id}, TYPE: ${type})`;
}

// Wrap a label + body into a "=== LABEL ===\n<body>" context block.
export function contextBlock(label: string, body: string): string {
  return `=== ${label} ===\n${body}`;
}
