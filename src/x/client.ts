import { payFetch, paidUsd } from "../wallet.js";
import { config } from "../config.js";
import { log } from "../log.js";
import { sleep } from "../util.js";
import type { SearchResponse, Tweet } from "./types.js";

// Full X/Twitter API SDK over the x402-paid data endpoint. Not every export is
// wired to a skill — these are the building blocks skills (e.g. config/skills/x)
// compose into actions.

// ─── helpers ────────────────────────────────────────────────────────────────

function base(path: string): string {
  return `${config.xApiBaseUrl}${path}`;
}

function auth() {
  return { auth_token: config.twitterAuthToken, ct0: config.twitterCt0 };
}

// twit.sh endpoints that act on behalf of the authenticated user. They require
// auth_token + ct0, which we inject automatically (from env) on every call — these
// params are never exposed to the LLM/skill. Read endpoints don't need auth.
const AUTHENTICATED_PATHS = new Set<string>([
  "/tweets",
  "/tweets/long",
  "/tweets/like",
  "/tweets/bookmark",
  "/tweets/retweet",
  "/users/following",
]);

function withAuth<T extends Record<string, unknown>>(path: string, params: T): T {
  return AUTHENTICATED_PATHS.has(path) ? { ...params, ...auth() } : params;
}

function buildUrl(path: string, params: Record<string, string | number | undefined>): string {
  const url = new URL(base(path));
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  return url.toString();
}

async function get<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
  const t = Date.now();
  log.info({ path, params: sanitizeParams(params) }, `x-api GET ${path}`);
  const res = await payFetch(buildUrl(path, params));
  if (!res.ok) {
    const body = await res.text();
    log.error({ path, status: res.status, ms: Date.now() - t }, `x-api GET ${path} failed`);
    throw new Error(`GET ${path} failed: ${res.status} ${body}`);
  }
  log.info({ path, status: res.status, ms: Date.now() - t, usd: paidUsd(res) }, `x-api GET ${path} ok`);
  return res.json() as Promise<T>;
}

async function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const payload = withAuth(path, body);
  // twit.sh proxy endpoints read their params (including auth_token/ct0) from the
  // QUERY STRING, not the body — confirmed: a correctly-sent body-only POST still
  // returns "ct0 is null". So put the payload on the URL (and keep it in the body
  // too for any endpoint that reads it, e.g. /tweets/long's `text`).
  const url = buildUrl(path, payload as Record<string, string | number | undefined>);
  for (let attempt = 1; attempt <= 5; attempt++) {
    const t = Date.now();
    log.info({ path, attempt }, `x-api POST ${path}`);
    const res = await payFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    // twit.sh returns 2xx (often 201) even when the action failed — the real
    // signal is an `errors` array embedded in the body (e.g. a created tweet has
    // `data.id`, a failure has `data.errors` like the 186 length/auth error). So
    // on a 2xx we inspect the body and treat an embedded error as a failure.
    if (res.ok) {
      const json = await res.json().catch(() => undefined);
      const apiErrors = (json as any)?.errors ?? (json as any)?.data?.errors;
      if (Array.isArray(apiErrors) && apiErrors.length > 0) {
        log.error({ path, status: res.status, ms: Date.now() - t, errors: apiErrors }, `x-api POST ${path} returned errors`);
        throw new Error(`POST ${path} failed: ${JSON.stringify(apiErrors)}`);
      }
      // Log the raw twit.sh response body (e.g. the created tweet on POST /tweets).
      log.info({ path, status: res.status, ms: Date.now() - t, usd: paidUsd(res), response: json }, `x-api POST ${path} ok`);
      return json as T;
    }
    const text = await res.text();
    if (res.status === 500 && attempt < 5) {
      log.warn({ path, attempt, status: res.status }, `x-api POST ${path} 500, retrying`);
      await sleep(attempt * 1000);
      continue;
    }
    log.error({ path, status: res.status, ms: Date.now() - t, body: text }, `x-api POST ${path} failed`);
    throw new Error(`POST ${path} failed: ${res.status} ${text}`);
  }
  throw new Error(`POST ${path} exhausted retries`);
}

async function del<T>(path: string, params: Record<string, string | number | undefined>): Promise<T> {
  const all = withAuth(path, params);
  const t = Date.now();
  log.info({ path }, `x-api DELETE ${path}`);
  const res = await payFetch(buildUrl(path, all), { method: "DELETE" });
  if (!res.ok) {
    const body = await res.text();
    log.error({ path, status: res.status, ms: Date.now() - t }, `x-api DELETE ${path} failed`);
    throw new Error(`DELETE ${path} failed: ${res.status} ${body}`);
  }
  log.info({ path, status: res.status, ms: Date.now() - t, usd: paidUsd(res) }, `x-api DELETE ${path} ok`);
  return res.json() as Promise<T>;
}

function sanitizeParams(params: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (k === "auth_token" || k === "ct0") safe[k] = "[redacted]";
    else safe[k] = v;
  }
  return safe;
}

// ─── tweets ─────────────────────────────────────────────────────────────────

export function extractTweetId(raw: string): string {
  return raw.match(/\/status\/(\d+)/)?.[1] ?? raw.trim();
}

export async function getTweetById(id: string): Promise<Tweet> {
  return get<Tweet>("/tweets/by/id", { id });
}

export async function getTweets(ids: string[]): Promise<Tweet[]> {
  if (ids.length === 0) return [];
  log.info({ ids }, "GET x-api /tweets");
  const json = await get<{ data?: Tweet[] }>("/tweets", { ids: ids.join(",") });
  return json.data ?? [];
}

export async function getUserTweets(username: string, next_token?: string): Promise<SearchResponse> {
  return get<SearchResponse>("/tweets/user", { username, next_token });
}

export type TweetSearchParams = {
  words?: string; phrase?: string; anyWords?: string; noneWords?: string;
  hashtags?: string; from?: string; to?: string; mentioning?: string;
  minReplies?: number; minLikes?: number; minReposts?: number;
  since?: string; until?: string; next_token?: string;
};

export async function searchTweets(params: TweetSearchParams): Promise<SearchResponse> {
  return get<SearchResponse>("/tweets/search", params as Record<string, string | number | undefined>);
}

// Poll the authenticated account's mentions. Uses the purpose-built
// /tweets/mentions endpoint, which returns the same shape as search but only
// needs auth (auth_token + ct0). `type` is an optional filter we leave unset.
// Poll for mentions using the method chosen in config (POLL_METHOD):
//  - "search":   /tweets/search filtered to tweets mentioning the agent handle.
//  - "mentions": the dedicated /tweets/mentions endpoint (auth_token + ct0 only).
// Both return the same SearchResponse shape.
export async function searchMentions(handle: string): Promise<SearchResponse> {
  // No banner log here — the underlying get()/searchTweets already logs the request
  // and its "ok" line (with cost), so a separate line would just triple the output.
  if (config.pollMethod === "mentions") {
    return get<SearchResponse>("/tweets/mentions", auth());
  }
  return searchTweets({ mentioning: handle });
}

export async function getTweetReplies(id: string, next_token?: string): Promise<SearchResponse> {
  return get<SearchResponse>("/tweets/replies", { id, next_token });
}

export async function getRetweetedBy(id: string, next_token?: string): Promise<SearchResponse> {
  return get<SearchResponse>("/tweets/retweeted_by", { id, next_token });
}

export async function getQuoteTweets(id: string, next_token?: string): Promise<SearchResponse> {
  return get<SearchResponse>("/tweets/quote_tweets", { id, next_token });
}

export async function postTweet(text: string, opts: { replyTo?: string; quoteTweetId?: string } = {}): Promise<void> {
  // /tweets/long supports the full character limit; plain /tweets rejects longer text.
  await post("/tweets/long", {
    text,
    ...(opts.replyTo ? { in_reply_to_tweet_id: opts.replyTo } : {}),
    ...(opts.quoteTweetId ? { quote_tweet_id: opts.quoteTweetId } : {}),
  });
}

export async function postReply(tweetId: string, text: string): Promise<void> {
  log.info({ tweetId }, "POST x-api reply");
  await postTweet(text, { replyTo: tweetId });
}

export async function deleteTweet(id: string): Promise<void> {
  await del("/tweets", { id });
}

export async function likeTweet(id: string): Promise<void> {
  await post("/tweets/like", { id });
}

export async function unlikeTweet(id: string): Promise<void> {
  await del("/tweets/like", { id });
}

export async function retweetTweet(id: string): Promise<void> {
  await post("/tweets/retweet", { id });
}

export async function unretweetTweet(id: string): Promise<void> {
  await del("/tweets/retweet", { id });
}

export async function bookmarkTweet(id: string): Promise<void> {
  await post("/tweets/bookmark", { id });
}

export async function unbookmarkTweet(id: string): Promise<void> {
  await del("/tweets/bookmark", { id });
}

// ─── users ──────────────────────────────────────────────────────────────────

export async function getUserByUsername(username: string): Promise<unknown> {
  return get("/users/by/username", { username });
}

export async function getUserById(id: string): Promise<unknown> {
  return get("/users/by/id", { id });
}

export async function searchUsers(query: string, next_token?: string): Promise<unknown> {
  return get("/users/search", { query, next_token });
}

// Batch-fetch several users in one call. Cheaper than N `getUserById` calls when
// you already have the numeric ids (e.g. resolving a list of authors/followers).
export async function getUsers(ids: string[]): Promise<unknown> {
  return get("/users", { ids: ids.join(",") });
}

export async function getFollowers(id: string, next_token?: string): Promise<unknown> {
  return get("/users/followers", { id, next_token });
}

export async function getFollowing(id: string, next_token?: string): Promise<unknown> {
  return get("/users/following", { id, next_token });
}

export async function followUser(opts: { id?: string; username?: string }): Promise<void> {
  await post("/users/following", opts);
}

export async function unfollowUser(opts: { id?: string; username?: string }): Promise<void> {
  await del("/users/following", opts as Record<string, string>);
}

// ─── articles ───────────────────────────────────────────────────────────────

export async function getArticle(id: string): Promise<unknown> {
  return get("/articles/by/id", { id });
}

// ─── lists ──────────────────────────────────────────────────────────────────

export async function getList(id: string): Promise<unknown> {
  return get("/lists/by/id", { id });
}

export async function getListMembers(id: string, next_token?: string): Promise<unknown> {
  return get("/lists/members", { id, next_token });
}

export async function getListFollowers(id: string, next_token?: string): Promise<unknown> {
  return get("/lists/followers", { id, next_token });
}

export async function getListTweets(id: string, next_token?: string): Promise<SearchResponse> {
  return get<SearchResponse>("/lists/tweets", { id, next_token });
}

// ─── communities ─────────────────────────────────────────────────────────────

export async function getCommunity(id: string): Promise<unknown> {
  return get("/communities/by/id", { id });
}

export async function getCommunityMembers(id: string, next_token?: string): Promise<unknown> {
  return get("/communities/members", { id, next_token });
}

export async function getCommunityPosts(id: string, next_token?: string): Promise<SearchResponse> {
  return get<SearchResponse>("/communities/posts", { id, next_token });
}

// ─── workflows ───────────────────────────────────────────────────────────────

export async function getUserInsights(username: string): Promise<unknown> {
  return get("/workflows/userInsights", { username });
}
