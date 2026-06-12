// Throwaway smoke test for config/hooks/user-memory.ts.
// Run: DB_PATH=/tmp/yappr-memtest.db npx tsx --conditions=development scripts/test-user-memory.ts
import { hooks } from "../config/hooks/user-memory.js";
import type { Tweet } from "../src/index.js";

const tweet = (n: number, over: Partial<Tweet> = {}): Tweet => ({
  id: String(n),
  text: `question number ${n}`,
  created_at: new Date(Date.UTC(2026, 5, 1, 12, n)).toISOString(),
  author_id: "u1",
  conversation_id: "100",
  author: { id: "u1", username: "alice", name: "Alice" },
  ...over,
});

// 1. capture 55 mentions (cap is 50), reply to some
for (let i = 1; i <= 55; i++) {
  const t = tweet(i, i % 2 ? { in_reply_to_screen_name: "bob", referenced_tweets: [{ type: "replied_to", id: "99" }] } : {});
  await hooks.onMention!(t);
  if (i % 2) await hooks.onAfterReply!({ tweet: t, text: `answer to ${i}` });
}
// duplicate onMention must not duplicate the entry
await hooks.onMention!(tweet(55));

// 2. a new mention arrives → memory injected, current ask excluded
const current = tweet(56);
await hooks.onMention!(current);
const out = await hooks.onBeforeInference!({ tweet: current, question: current.text, context: "=== ASKER TWEET ===\n{...}" });
const ctx = out.context!;

const assert = (cond: boolean, msg: string) => { if (!cond) { console.error("FAIL:", msg); process.exit(1); } };
assert(ctx.includes("USER MEMORY: PAST exchanges between you and @alice"), "memory block present");
assert(!ctx.includes("question number 56"), "current ask excluded");
assert(!/question number 6$/m.test(ctx), "oldest entries trimmed (1-6 gone)");
assert(/question number 7$/m.test(ctx), "entry 7 kept (oldest survivor)");
assert(ctx.includes("you replied: answer to 55"), "agent answer attached");
assert(ctx.includes("replying to @bob in 99"), "reply-to id+username rendered");
assert(ctx.includes("conv 100"), "conversation id rendered");
// 55 captured → cap 50 keeps 6..55; current (56) pushes out 6 → 7..56 stored,
// current excluded from rendering → 49 past exchanges shown.
assert((ctx.match(/\[2026-06-01/g) ?? []).length === 49, "stored cap 50 minus current ask = 49 injected");
assert(ctx.startsWith("=== USER MEMORY"), "memory prepended, not appended");
assert(ctx.trimEnd().endsWith("{...}"), "asker tweet stays last (most salient)");

// 3. unknown user → context untouched
const fresh = tweet(1, { author: { id: "u2", username: "carol", name: "C" } });
const out2 = await hooks.onBeforeInference!({ tweet: fresh, question: fresh.text, context: undefined });
assert(out2.context === undefined, "no memory for new user");

console.log("user-memory smoke test: all assertions passed");
console.log("--- sample render ---");
console.log(ctx.split("\n").slice(1, 6).join("\n"));
