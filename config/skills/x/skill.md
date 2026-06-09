---
name: x
description: Read or search tweets and users, post, engage (like/retweet/bookmark/follow), and pull lists, communities, articles, or deep user analysis on X/Twitter. Use whenever the user asks to look something up on X or to act on their account.
access: admin
---

Pick exactly one `action` from the list below and pass it (plus its parameters)
in `params` when you call this skill, e.g. `params: {"action":"<action>", ...}`.

Shared parameters:
- `id` — a tweet, user, list, or community ID. A full X URL also works (e.g. `https://x.com/user/status/123456`); the ID is extracted automatically.
- `username` — a handle written without the leading `@`.

---

## Tweets — read

### tweet
Get one tweet's full data (text, author, engagement metrics).
- When: the user points at a single tweet or URL and wants its content or stats.
- `id` (required) — the tweet ID or URL.

### tweet-search
Search recent tweets by keyword and filters. This is the action for "find/search tweets about …".
- When: "find tweets about X", "what are people saying about Y", "search posts from Z this week".
- Put the user's plain search terms in `words`. All parameters are optional — combine the ones that match the request:
  - `words` — all of these words must appear. **This is the default keyword field — use it for a normal search.**
  - `phrase` — match this exact phrase.
  - `any_words` — match if any one of these words appears.
  - `none_words` — exclude tweets containing these words.
  - `hashtags` — required hashtags, without the `#`.
  - `from` — only tweets authored by this handle.
  - `to` — only tweets that are replies to this handle.
  - `mentioning` — only tweets that mention this handle.
  - `min_likes` / `min_replies` / `min_reposts` — minimum engagement, as numbers.
  - `since` / `until` — date bounds in `YYYY-MM-DD` form.

### tweet-replies
List the replies under a tweet.
- When: "what are people replying", "show the replies to this".
- `id` (required) — the tweet being replied to.

### tweet-retweeters
List the users who reposted a tweet.
- When: "who retweeted this".
- `id` (required).

### tweet-quotes
List quote-tweets of a tweet.
- When: "who quoted this", "show the quote tweets".
- `id` (required).

### timeline
Fetch a user's recent tweets.
- When: "show me what @user has been posting", "latest tweets from this account".
- `username` (required).

## Tweets — write

### post
Publish a new tweet, a reply, or a quote tweet.
- When: the user asks to tweet, reply, or quote something.
- `text` (required) — the tweet body.
- `reply_to` (optional) — a tweet ID/URL to reply under.
- `quote_id` (optional) — a tweet ID/URL to quote.

### delete
Delete one of the agent's own tweets.
- `id` (required) — the tweet to delete.

### like / unlike
Like or remove a like from a tweet.
- `id` (required).

### retweet / unretweet
Repost a tweet or undo a repost.
- `id` (required).

### bookmark / unbookmark
Add or remove a bookmark.
- `id` (required).

## Users — read

### user
Look up a single user's profile (bio, metrics, ID).
- When: "who is @x", "show me this account", or to resolve a handle into a numeric user ID for `followers`/`following`.
- Provide either `username` or `id`.

### users
Look up several users at once by numeric ID (one batched call).
- When: you already hold a list of numeric user IDs (e.g. from `followers`/`retweeters`) and want their profiles together.
- `ids` (required) — comma-separated **numeric user IDs** (not handles).

### user-search
Search for users by keyword.
- When: "find accounts about X", "search for people who do Y".
- `query` (required) — the search keywords.

### followers
List a user's followers.
- When: "who follows this account".
- `id` (required) — the **numeric user ID** (not a handle). If you only have a handle, call `user` first to get the ID.

### following
List who a user follows.
- When: "who does this account follow".
- `id` (required) — the **numeric user ID**; resolve a handle via `user` first.

## Users — write

### follow / unfollow
Follow or unfollow an account.
- Provide either `username` or `id`.

## Other

### article
Get the full text of an X article.
- `id` (required) — the article's tweet ID or URL.

### list
Get a list's details.
- `id` (required) — the list ID.

### list-members
Members of a list.
- `id` (required) — the list ID.

### list-followers
Followers of a list.
- `id` (required) — the list ID.

### list-tweets
Recent tweets posted to a list.
- `id` (required) — the list ID.

### community
Get a community's details.
- `id` (required) — the community ID.

### community-members
Members of a community.
- `id` (required) — the community ID.

### community-posts
Recent posts in a community.
- `id` (required) — the community ID.

### user-insights
Deep analysis of a user, including monthly tweet volume. Slow — takes 30–90s, so only use it when the user explicitly asks for an in-depth breakdown of an account.
- `username` (required).
