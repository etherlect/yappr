import type { Logger } from "pino";
import type { Tweet } from "../x/types.js";
import { getTweets, postReply } from "../x/client.js";
import { runAgentLoop } from "./agent.js";
import {
  runOnMention, runShouldReply, runOnBeforeInference,
  runOnAfterInference, runOnBeforeReply, runOnAfterReply,
} from "../hooks/registry.js";
import { shouldReply, replyToScreenName } from "./gating.js";
import { BLOCK, referencedBlockLabel, contextBlock } from "./context-blocks.js";
import { config } from "../config.js";
import { recordReply } from "../stats.js";

// Handles one mention end-to-end: decide whether to reply (positional gating +
// hooks) → gather thread context → run the agent loop → post the reply. Gating runs
// before the (paid) context fetch, so mentions we skip cost nothing. User hooks run
// at each stage so forks can observe or veto without touching this file.
export async function processTweet(t: Tweet, log: Logger): Promise<void> {
  await runOnMention(t);

  // Who the asker tweet replies to is carried on the tweet itself, so positional
  // gating needs no extra fetch — we only pay for context once we'll actually reply.
  if (!shouldReply(t.text, config.agentHandle, replyToScreenName(t))) {
    log.info({ id: t.id, text: t.text }, "skipping: mention not in valid position");
    return;
  }

  const hookVeto = await runShouldReply(t);
  if (!hookVeto) {
    log.info({ id: t.id }, "skipping: hook vetoed reply");
    return;
  }

  log.info({ id: t.id, author: t.author?.username, text: t.text }, "processing mention");

  const ctx = await fetchContext(t, log);
  const askingTweet = contextBlock(BLOCK.asker, JSON.stringify(t, null, 2));
  let context = ctx ? `${ctx}\n\n${askingTweet}` : askingTweet;

  try {
    // onBeforeInference receives the raw tweet text (for inspection, logging,
    // side-effects). The model reads the ask from the ASKER TWEET in `context`,
    // so a hook steers inference by rewriting `context`.
    const inferred = await runOnBeforeInference(t.text, context);
    context = inferred.context ?? context;

    const isAdmin = config.adminHandles.length > 0 &&
      config.adminHandles.includes(t.author?.username?.toLowerCase() ?? "");

    let replyText = await runAgentLoop(context, isAdmin, t, log);

    replyText = await runOnAfterInference(t.text, replyText);

    const finalText = await runOnBeforeReply(t, replyText);
    if (finalText === null) {
      log.info({ id: t.id }, "skipping: onBeforeReply hook vetoed reply");
      return;
    }

    await postReply(t.id, finalText);
    await runOnAfterReply(t, finalText);
    log.info({ id: t.id }, "replied");
    recordReply();
  } catch (err) {
    log.error({ err, id: t.id }, "reply failed");
  }
}

// Fetch the conversation root and/or the reply-to tweet (one paid getTweets call)
// and render them into the context blocks the model reads. Returns undefined when
// the mention is a standalone tweet with nothing to fetch.
async function fetchContext(t: Tweet, log: Logger): Promise<string | undefined> {
  const refs = t.referenced_tweets ?? [];
  const replyToId = refs.find((r) => r.type === "replied_to")?.id;
  // Other references carried on the asker tweet (e.g. a "quoted" tweet) — fetched
  // and shown individually with their id + type.
  const otherRefs = refs.filter((r) => r.type !== "replied_to" && r.id);

  // The tweet the asker replied to is always shown as REPLY-TO TWEET. We also show
  // the CONVERSATION ROOT TWEET only when the reply-to tweet isn't itself the root —
  // i.e. its conversation_id differs from its id (equivalently: replyToId differs
  // from the thread's conversation_id, which is invariant across the thread).
  const wantsRoot = !!replyToId && !!t.conversation_id && replyToId !== t.conversation_id;

  // One batched (paid) fetch for everything we need. Dedupe in case ids overlap.
  const idsToFetch = [...new Set([
    ...(wantsRoot ? [t.conversation_id] : []),
    ...(replyToId ? [replyToId] : []),
    ...otherRefs.map((r) => r.id),
  ])];
  if (idsToFetch.length === 0) return undefined;

  let fetched: Tweet[] = [];
  try {
    fetched = await getTweets(idsToFetch);
  } catch (err) {
    log.error({ err }, "context fetch failed; proceeding without context");
    return undefined;
  }

  const parts: string[] = [];

  if (wantsRoot) {
    const root = fetched.find((x) => x.id === t.conversation_id);
    if (root) parts.push(contextBlock(BLOCK.root, JSON.stringify(root, null, 2)));
  }
  if (replyToId) {
    const replyTo = fetched.find((x) => x.id === replyToId);
    if (replyTo) parts.push(contextBlock(BLOCK.replyTo, JSON.stringify(replyTo, null, 2)));
  }
  for (const ref of otherRefs) {
    const refTweet = fetched.find((x) => x.id === ref.id);
    if (refTweet) {
      parts.push(contextBlock(referencedBlockLabel(ref.id, ref.type), JSON.stringify(refTweet, null, 2)));
    }
  }

  return parts.length ? parts.join("\n\n") : undefined;
}
