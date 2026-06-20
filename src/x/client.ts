import twitterText from "twitter-text";
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
  "/users/setProfile",
  // (/tweets/mediaUpload is also authenticated, but uploadMedia injects auth itself —
  // it's multipart/form-data and bypasses the JSON post()/withAuth() path.)
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
    // warn before throwing: the catch site logs the (counted) error — see log.ts.
    log.warn({ path, status: res.status, ms: Date.now() - t }, `x-api GET ${path} failed`);
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
        log.warn({ path, status: res.status, ms: Date.now() - t, errors: apiErrors }, `x-api POST ${path} returned errors`);
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
    log.warn({ path, status: res.status, ms: Date.now() - t, body: text }, `x-api POST ${path} failed`);
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
    log.warn({ path, status: res.status, ms: Date.now() - t }, `x-api DELETE ${path} failed`);
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

// Direct CDN URLs of the still images attached to a tweet (photos only — video /
// animated_gif are skipped). Reads entities.media first, falling back to the
// parallel media_metadata list, and dedupes. Used by the reply loop to attach the
// image to a vision model when a mention carries one.
export function tweetImageUrls(tweet: Tweet): string[] {
  const urls = new Set<string>();
  for (const m of tweet.entities?.media ?? []) {
    if ((m.type ?? "photo") === "photo" && m.media_url_https) urls.add(m.media_url_https);
  }
  for (const m of tweet.media_metadata ?? []) {
    if (m.media_url) urls.add(m.media_url);
  }
  return [...urls];
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

export async function postTweet(
  text: string,
  opts: { replyTo?: string; quoteTweetId?: string; mediaIds?: string[] } = {},
): Promise<void> {
  // /tweets/long supports the full character limit; plain /tweets rejects longer text.
  // Use the cheaper /tweets endpoint when the text fits within the standard 280-char
  // limit, and only fall back to /tweets/long when it's longer. The limit is X's own
  // *weighted* length (twitter-text), so URLs count as 23 chars, CJK/emoji as 2, etc.
  // Both accept `medias` — a comma-separated list of media IDs from uploadMedia() — to
  // attach images to the post.
  const path = twitterText.parseTweet(text).weightedLength > 280 ? "/tweets/long" : "/tweets";
  await post(path, {
    text,
    ...(opts.replyTo ? { in_reply_to_tweet_id: opts.replyTo } : {}),
    ...(opts.quoteTweetId ? { quote_tweet_id: opts.quoteTweetId } : {}),
    ...(opts.mediaIds?.length ? { medias: opts.mediaIds.join(",") } : {}),
  });
}

export async function postReply(tweetId: string, text: string, mediaIds?: string[]): Promise<void> {
  log.info({ tweetId, media: mediaIds?.length ?? 0 }, "POST x-api reply");
  await postTweet(text, { replyTo: tweetId, mediaIds });
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

// ─── media ─────────────────────────────────────────────────────────────────

// Upload an image to X and return its media_id — attach it to a post via
// postTweet({ mediaIds: [id] }). This endpoint is multipart/form-data with auth on the
// query string (per the twit.sh spec), so it bypasses the JSON post() helper and builds
// the request itself. Accepts raw bytes (Blob / Uint8Array / ArrayBuffer).
export async function uploadMedia(
  file: Blob | ArrayBuffer | Uint8Array,
  opts: { filename?: string; contentType?: string } = {},
): Promise<string> {
  const path = "/tweets/mediaUpload";
  const url = buildUrl(path, auth()); // auth_token + ct0 on the query string
  // Cast at the Blob boundary: TS 5.7's generic Uint8Array<ArrayBufferLike> doesn't
  // structurally match lib.dom's BlobPart (ArrayBufferView<ArrayBuffer>), though the
  // bytes are valid — see microsoft/TypeScript#59417.
  const blob = file instanceof Blob ? file : new Blob([file as BlobPart], { type: opts.contentType ?? "application/octet-stream" });
  const form = new FormData();
  form.append("file", blob, opts.filename ?? "image.png");
  const t = Date.now();
  log.info({ path }, `x-api POST ${path}`);
  // No Content-Type header: fetch sets multipart/form-data with the correct boundary.
  const res = await payFetch(url, { method: "POST", body: form });
  if (!res.ok) {
    const body = await res.text();
    log.warn({ path, status: res.status, ms: Date.now() - t }, `x-api POST ${path} failed`);
    throw new Error(`POST ${path} failed: ${res.status} ${body}`);
  }
  const json = (await res.json().catch(() => undefined)) as any;
  // The success body is undocumented in the spec; pull the id from the usual
  // Twitter/twit.sh field names (media_id_string is the canonical Twitter one).
  const id = json?.media_id_string ?? json?.media_id ?? json?.data?.media_id_string ?? json?.data?.media_id ?? json?.id ?? json?.data?.id;
  log.info({ path, status: res.status, ms: Date.now() - t, usd: paidUsd(res), mediaId: id }, `x-api POST ${path} ok`);
  if (id == null) throw new Error(`mediaUpload: no media id in response ${JSON.stringify(json)}`);
  return String(id);
}

// Convenience: fetch an image by URL (plain fetch — public CDN, not x402) and upload it,
// returning the media_id. Pairs with image-generation skills that produce a hosted URL.
export async function uploadMediaFromUrl(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`fetch media ${url} failed: ${res.status}`);
  const contentType = res.headers.get("content-type") ?? "image/png";
  const bytes = new Uint8Array(await res.arrayBuffer());
  const filename = new URL(url).pathname.split("/").pop() || "image.png";
  return uploadMedia(bytes, { filename, contentType });
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

// Update the authenticated user's profile. Only the fields you pass are sent; an
// omitted field is left unchanged (pass an empty string to clear one).
export async function setProfile(
  opts: { name?: string; bio?: string; location?: string; url?: string },
): Promise<void> {
  await post("/users/setProfile", {
    ...(opts.name !== undefined ? { name: opts.name } : {}),
    ...(opts.bio !== undefined ? { bio: opts.bio } : {}),
    ...(opts.location !== undefined ? { location: opts.location } : {}),
    ...(opts.url !== undefined ? { url: opts.url } : {}),
  });
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
