import {
  type SkillHandler, type SkillResult,
  extractTweetId,
  postTweet, deleteTweet,
  likeTweet, unlikeTweet, retweetTweet, unretweetTweet,
  bookmarkTweet, unbookmarkTweet,
  followUser, unfollowUser, setProfile,
  uploadMediaFromUrl,
} from "yappr";

// Account-mutating X/Twitter actions (access: admin). Read-only lookups/search live
// in the `x-read` skill (access: all).

type Params = Record<string, string>;
type Action = (p: Params) => Promise<SkillResult>;

// Wrap an action that needs an id (tweet/user — accepts a raw id or X URL).
function withId(label: string, fn: (id: string, p: Params) => Promise<SkillResult>): Action {
  return (p) => (p.id ? fn(extractTweetId(p.id), p) : Promise.resolve({ text: `missing ${label}` }));
}

// Wrap a write action that just acknowledges success with a short message.
function ack(label: string, fn: (id: string) => Promise<void>, verb: string): Action {
  return withId(label, async (id) => {
    await fn(id);
    return { text: `${verb} ${id}` };
  });
}

const ID = "tweet id or URL";

// Upload one or more image URLs (comma-separated) to X and return their media_ids to
// attach to a post. Bounded to X's 4-images-per-tweet limit.
async function uploadMediaUrls(raw?: string): Promise<string[] | undefined> {
  const urls = (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (urls.length === 0) return undefined;
  const ids: string[] = [];
  for (const url of urls.slice(0, 4)) ids.push(await uploadMediaFromUrl(url));
  return ids.length ? ids : undefined;
}

const actions: Record<string, Action> = {
  // ── tweets ──
  "post": async (p) => {
    if (!p.text) return { text: "missing tweet text" };
    await postTweet(p.text, {
      replyTo: p.reply_to ? extractTweetId(p.reply_to) : undefined,
      quoteTweetId: p.quote_id ? extractTweetId(p.quote_id) : undefined,
      mediaIds: await uploadMediaUrls(p.media_url),
    });
    return { text: "posted" };
  },
  "delete": ack(ID, deleteTweet, "deleted"),
  "like": ack(ID, likeTweet, "liked"),
  "unlike": ack(ID, unlikeTweet, "unliked"),
  "retweet": ack(ID, retweetTweet, "retweeted"),
  "unretweet": ack(ID, unretweetTweet, "unretweeted"),
  "bookmark": ack(ID, bookmarkTweet, "bookmarked"),
  "unbookmark": ack(ID, unbookmarkTweet, "removed bookmark"),

  // ── users ──
  "follow": async (p) => {
    if (!p.username && !p.id) return { text: "missing username or id" };
    await followUser({ id: p.id, username: p.username });
    return { text: `followed ${p.username ?? p.id}` };
  },
  "unfollow": async (p) => {
    if (!p.username && !p.id) return { text: "missing username or id" };
    await unfollowUser({ id: p.id, username: p.username });
    return { text: `unfollowed ${p.username ?? p.id}` };
  },
  "set-profile": async (p) => {
    // All four fields are required (a profile set replaces the whole thing). `name` must
    // be non-empty; bio/location/url may be an empty string, which CLEARS that field on X.
    for (const f of ["name", "bio", "location", "url"] as const) {
      if (p[f] === undefined) {
        return { text: "set-profile requires all of: name, bio, location, url (pass an empty string for bio/location/url to clear them)" };
      }
    }
    if (p.name.trim() === "") return { text: "name cannot be empty" };
    await setProfile({ name: p.name, bio: p.bio, location: p.location, url: p.url });
    return { text: "profile updated" };
  },
};

export const handler: SkillHandler = async (params) => {
  const action = actions[params.action];
  if (!action) return { text: `unknown action "${params.action}"` };
  return action(params);
};
