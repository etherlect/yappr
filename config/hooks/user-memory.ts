import { skillStore, log, type AgentHooks, type Tweet } from "yappr";

// Per-user conversation memory. Captures every mention a user sends the agent
// (onMention) and the agent's posted answer (onAfterReply), then injects the
// user's recent exchanges into the prompt on their next ask (onBeforeInference).
// Capture is free — the tweets already flow through the pipeline; nothing here
// calls the paid X API. Storage is the shared SQLite DB via skillStore, so
// memory survives restarts/redeploys and rides along in backups.

type Exchange = {
  id: string;            // the user's tweet id (dedupes --process-old replays)
  at: number;            // epoch ms from the tweet's created_at (sort + render)
  text: string;          // what the user said
  conversationId?: string;
  replyToId?: string;    // tweet id the user was replying to, if any
  replyToUser?: string;  // handle (without @) the user was replying to, if any
  agent?: string;        // our posted answer — final text, set in onAfterReply
};

const MAX_EXCHANGES = 50;   // per user, oldest dropped first
const MAX_TEXT = 280;       // per side of an exchange, to bound prompt tokens

const mem = skillStore("user-memory");

const load = (userId: string): Exchange[] => mem.getJSON<Exchange[]>(userId) ?? [];

const clip = (s: string) =>
  s.length > MAX_TEXT ? s.slice(0, MAX_TEXT - 1) + "…" : s;

// "2026-06-11 14:03" — minute granularity is plenty for the model.
const stamp = (at: number) => new Date(at).toISOString().slice(0, 16).replace("T", " ");

function toExchange(t: Tweet): Exchange {
  const parsed = Date.parse(t.created_at);
  return {
    id: t.id,
    at: Number.isNaN(parsed) ? Date.now() : parsed,
    text: clip(t.text),
    conversationId: t.conversation_id || undefined,
    replyToId: t.referenced_tweets?.find((r) => r.type === "replied_to")?.id,
    replyToUser: t.in_reply_to_screen_name ?? undefined,
  };
}

// One exchange → one or two compact lines:
//   [2026-06-11 14:03] them (tweet 12, conv 10, replying to @bob in 11): gm what's mcap?
//     you replied: …
function render(e: Exchange): string {
  const where = [
    `tweet ${e.id}`,
    e.conversationId ? `conv ${e.conversationId}` : null,
    e.replyToId || e.replyToUser
      ? `replying to ${[e.replyToUser && `@${e.replyToUser}`, e.replyToId && `in ${e.replyToId}`].filter(Boolean).join(" ")}`
      : null,
  ].filter(Boolean).join(", ");
  const lines = [`[${stamp(e.at)}] them (${where}): ${e.text}`];
  if (e.agent) lines.push(`  you replied: ${e.agent}`);
  return lines.join("\n");
}

export const hooks: AgentHooks = {
  // Record every incoming mention (even ones gating later skips) under the
  // author's id — stable across handle renames.
  onMention(t) {
    const uid = t.author?.id;
    if (!uid) return;
    const exchanges = load(uid);
    if (exchanges.some((e) => e.id === t.id)) return; // already seen (backfill replay)
    exchanges.push(toExchange(t));
    exchanges.sort((a, b) => a.at - b.at);
    mem.setJSON(uid, exchanges.slice(-MAX_EXCHANGES));
  },

  // Inject the user's past exchanges as a context block, PREPENDED so the
  // current ask (ASKER TWEET) stays last and most salient — appended memory
  // reads like the newest message and the model answers it instead. The current
  // ask is already in memory (onMention ran first) but the model sees it as the
  // ASKER TWEET block, so it's excluded here.
  onBeforeInference({ tweet, question, context }) {
    const uid = tweet.author?.id;
    const past = uid ? load(uid).filter((e) => e.id !== tweet.id) : [];
    if (past.length === 0) return { question, context };
    log.debug({ user: tweet.author?.username, exchanges: past.length }, "user-memory: injecting");
    const block =
      `=== USER MEMORY: PAST exchanges between you and @${tweet.author?.username} (oldest first) ===\n` +
      `These happened BEFORE the current request — background for continuity and recall, not part of the current ask.\n` +
      past.map(render).join("\n");
    return { question, context: context ? `${block}\n\n${context}` : block };
  },

  // Attach our posted answer (the final, possibly hook-edited text) to the
  // exchange it answered, so memory holds dialogue rather than monologue.
  onAfterReply({ tweet, text }) {
    const uid = tweet.author?.id;
    if (!uid) return;
    const exchanges = load(uid);
    const entry = exchanges.find((e) => e.id === tweet.id);
    if (!entry) return; // trimmed out already (user is past the 50-exchange cap)
    entry.agent = clip(text);
    mem.setJSON(uid, exchanges);
  },
};
