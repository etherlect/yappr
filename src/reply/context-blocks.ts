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

// An image to send to the vision model, tagged with the tweet block it came from
// (e.g. "ASKER TWEET (id 123)") so the model can be told which image belongs where.
export type ContextImage = { url: string; source: string };

// Caption emitted as a text part immediately before image N, so the model knows
// which tweet each attached image belongs to (ids tie back to the JSON blocks above).
export function imageCaption(index: number, source: string): string {
  return `Image ${index} — attached to the ${source}:`;
}
