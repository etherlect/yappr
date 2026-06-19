import type { Logger } from "pino";
import type { Tweet } from "../x/types.js";
import { getTweets, postReply, tweetImageUrls } from "../x/client.js";
import { runAgentLoop } from "./agent.js";
import {
  runOnMention, runShouldReply, runOnBeforeInference,
  runOnAfterInference, runOnBeforeReply, runOnAfterReply,
} from "../hooks/registry.js";
import { shouldReply, replyToScreenName } from "./gating.js";
import { BLOCK, referencedBlockLabel, contextBlock, type ContextImage } from "./context-blocks.js";
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
  let context = ctx?.body ? `${ctx.body}\n\n${askingTweet}` : askingTweet;

  // Images to show the vision model: the asker's own photos plus any on the tweets
  // it references (e.g. "what's in the image above"), each tagged with its source
  // tweet and deduped by URL (asker wins when a photo appears in more than one).
  const askerImages: ContextImage[] = tweetImageUrls(t).map((url) => ({ url, source: `${BLOCK.asker} (id ${t.id})` }));
  const images = dedupeImages([...askerImages, ...(ctx?.images ?? [])]);

  try {
    // onBeforeInference receives the asker tweet (for per-user logic like memory
    // injection) and its raw text. The model reads the ask from the ASKER TWEET
    // in `context`, so a hook steers inference by rewriting `context`.
    const inferred = await runOnBeforeInference(t, t.text, context);
    context = inferred.context ?? context;

    const isAdmin = config.adminHandles.length > 0 &&
      config.adminHandles.includes(t.author?.username?.toLowerCase() ?? "");

    // deniedSkills is ignored for live mentions: the model's reply already
    // tells the asker about the denial; it only drives cron failure handling.
    const result = await runAgentLoop(context, isAdmin, t, log, images);
    let replyText = result.text;

    replyText = await runOnAfterInference(t.text, replyText);

    const finalText = await runOnBeforeReply(t, replyText);
    if (finalText === null) {
      log.info({ id: t.id }, "skipping: onBeforeReply hook vetoed reply");
      return;
    }

    // Attach any media the model chose for its reply. These are X media_ids a media skill
    // (chart, generate-image) already uploaded this turn — attached as-is, never forwarded
    // automatically (the model picks them via the reply's `media_id` field).
    const mediaIds = result.mediaIds.length ? result.mediaIds.slice(0, 4) : undefined;
    await postReply(t.id, finalText, mediaIds);
    await runOnAfterReply(t, finalText);
    log.info({ id: t.id }, "replied");
    recordReply();
  } catch (err) {
    log.error({ err, id: t.id }, "reply failed");
  }
}

// Drop duplicate images by URL, keeping the first occurrence (and thus its source
// label) — so a photo on both the asker tweet and a tweet it quotes is sent once,
// attributed to the asker.
function dedupeImages(images: ContextImage[]): ContextImage[] {
  const seen = new Set<string>();
  return images.filter((img) => !seen.has(img.url) && (seen.add(img.url), true));
}

// Fetch the conversation root and/or the reply-to tweet (one paid getTweets call)
// and render them into the context blocks the model reads, plus any images they
// carry (tagged with their source tweet, for the vision path). Returns undefined
// when the mention is a standalone tweet with nothing to fetch.
async function fetchContext(t: Tweet, log: Logger): Promise<{ body?: string; images: ContextImage[] } | undefined> {
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
  const images: ContextImage[] = [];
  const collect = (tweet: Tweet, source: string) =>
    images.push(...tweetImageUrls(tweet).map((url) => ({ url, source })));

  if (wantsRoot) {
    const root = fetched.find((x) => x.id === t.conversation_id);
    if (root) {
      parts.push(contextBlock(BLOCK.root, JSON.stringify(root, null, 2)));
      collect(root, `${BLOCK.root} (id ${root.id})`);
    }
  }
  if (replyToId) {
    const replyTo = fetched.find((x) => x.id === replyToId);
    if (replyTo) {
      parts.push(contextBlock(BLOCK.replyTo, JSON.stringify(replyTo, null, 2)));
      collect(replyTo, `${BLOCK.replyTo} (id ${replyTo.id})`);
    }
  }
  for (const ref of otherRefs) {
    const refTweet = fetched.find((x) => x.id === ref.id);
    if (refTweet) {
      parts.push(contextBlock(referencedBlockLabel(ref.id, ref.type), JSON.stringify(refTweet, null, 2)));
      collect(refTweet, referencedBlockLabel(ref.id, ref.type));
    }
  }

  return parts.length || images.length ? { body: parts.length ? parts.join("\n\n") : undefined, images } : undefined;
}
