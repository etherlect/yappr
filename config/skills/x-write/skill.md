---
name: x-write
description: Act on the agent's own X/Twitter account — post, reply, quote, delete, like/unlike, retweet/unretweet, bookmark, follow/unfollow, and update the profile. Use when the user asks to publish or change something on the account. Admin-only.
access: admin
---

Pick exactly one `action` from the list below and pass it (plus its parameters) in `params` when you call this skill, e.g. `params: {"action":"<action>", ...}`.

This skill changes the account. To only read or search X (no posting), use the `x-read` skill, which any user can call.

Shared parameters:
- `id` — a tweet, user, list, or community ID. A full X URL also works (e.g. `https://x.com/user/status/123456`); the ID is extracted automatically.
- `username` — a handle written without the leading `@`.

---

## Tweets

### post
Publish a new tweet, a reply, or a quote tweet.
- When: the user asks to tweet, reply, or quote something.
- `text` (required unless media is attached) — the tweet body. Pass an empty string for an image-only post. Long-form (>280 chars) is fine — it's auto-routed to the long-tweet endpoint, and reply / quote / media all still apply, so you can write a long quote tweet or a long reply.
- `reply_to` (optional) — a tweet ID/URL to reply under.
- `quote_id` (optional) — a tweet ID/URL to quote. Works for posts of any length, short or long-form.
- `media_url` (optional) — an image URL to attach (or several, comma-separated, up to 4). Each is uploaded to X automatically and embedded in the post.
- `media_id` (optional) — one or more media IDs already uploaded to X (comma-separated), e.g. the `media_id`(s) returned by a media skill like `chart` or `generate-image`. Attached as-is, no re-upload. Combines with `media_url`, up to 4 total.

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

## Users

### follow / unfollow
Follow or unfollow an account.
- Provide either `username` or `id`.

### set-profile
Update the agent's own X profile. **All four fields are required** — a profile update replaces the whole profile, so always include every field, even ones you're keeping the same (carry over the current value).
- `name` (required) — display name. **Cannot be empty.**
- `bio` (required) — profile bio/description. Pass an empty string `""` to clear it.
- `location` (required) — profile location. Pass an empty string `""` to clear it.
- `url` (required) — profile website URL. Pass an empty string `""` to clear it.
