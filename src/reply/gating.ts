import type { Tweet } from "../x/types.js";

// Pure helpers for deciding whether/how to engage a mention — no I/O, no payments.
// `shouldReply` is the positional filter described below.

// The handle (without @) this tweet replies to, read straight off the tweet — no
// extra fetch. Feeds shouldReply's "agent is first mention" branch so gating can
// run before we pay to fetch conversation context.
export function replyToScreenName(t: Tweet): string | undefined {
  return t.in_reply_to_screen_name ?? undefined;
}

// Decide whether a mention is actually directed at us, to avoid replying when X
// auto-prepends our handle into an unrelated reply chain. We reply if our handle
// appears in the tweet body, or is the last of the leading @mentions, or is the
// first leading mention only when the tweet replies to us (or replies to nobody).
export function shouldReply(
  text: string,
  handle: string,
  replyToAuthorHandle?: string | null,
): boolean {
  const trimmed = text.trim();
  const leadingMentions = trimmed.match(/^(@\w+\s*)+/)?.[0] ?? "";
  const body = trimmed.slice(leadingMentions.length);
  const handleRe = new RegExp(`@${handle}\\b`, "i");
  const h = handle.toLowerCase();

  if (handleRe.test(body)) return true;

  const mentions = [...leadingMentions.matchAll(/@(\w+)/g)].map((m) => m[1].toLowerCase());
  if (mentions.length === 0) return false;

  if (mentions[mentions.length - 1] === h) return true;

  if (mentions[0] === h) {
    // Agent is first in leading mentions — only reply if this tweet is itself
    // a reply to the agent (i.e. agent started the thread), not when the agent
    // handle was auto-prepended by X into someone else's reply chain.
    if (!replyToAuthorHandle) return true;
    return replyToAuthorHandle.toLowerCase() === h;
  }

  return false;
}
