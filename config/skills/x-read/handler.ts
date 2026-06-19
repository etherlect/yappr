import {
  type SkillHandler, type SkillResult,
  extractTweetId,
  getTweetById, getUserTweets, searchTweets,
  getTweetReplies, getRetweetedBy, getQuoteTweets,
  getUserByUsername, getUserById, getUsers, searchUsers,
  getFollowers, getFollowing,
  getArticle,
  getList, getListMembers, getListFollowers, getListTweets,
  getCommunity, getCommunityMembers, getCommunityPosts,
  getUserInsights,
} from "yappr";

// Read-only X/Twitter actions (access: all). Anything that posts or mutates the
// account lives in the `x-write` skill (access: admin).

type Params = Record<string, string>;
type Action = (p: Params) => Promise<SkillResult>;

// Wrap an action that needs an id (tweet/user/list/community — accepts a raw id or X URL).
function withId(label: string, fn: (id: string, p: Params) => Promise<SkillResult>): Action {
  return (p) => (p.id ? fn(extractTweetId(p.id), p) : Promise.resolve({ text: `missing ${label}` }));
}

const ID = "tweet id or URL";

const actions: Record<string, Action> = {
  // ── tweets ──
  "tweet": withId(ID, async (id) => ({ data: await getTweetById(id) })),
  "tweet-search": async (p) => ({
    data: await searchTweets({
      words: p.words ?? p.query, phrase: p.phrase, anyWords: p.any_words, noneWords: p.none_words,
      hashtags: p.hashtags, from: p.from, to: p.to, mentioning: p.mentioning,
      minReplies: p.min_replies ? Number(p.min_replies) : undefined,
      minLikes: p.min_likes ? Number(p.min_likes) : undefined,
      minReposts: p.min_reposts ? Number(p.min_reposts) : undefined,
      since: p.since, until: p.until,
    }),
  }),
  "tweet-replies": withId(ID, async (id) => ({ data: await getTweetReplies(id) })),
  "tweet-retweeters": withId(ID, async (id) => ({ data: await getRetweetedBy(id) })),
  "tweet-quotes": withId(ID, async (id) => ({ data: await getQuoteTweets(id) })),
  "timeline": async (p) => (p.username ? { data: await getUserTweets(p.username) } : { text: "missing username" }),

  // ── users ──
  "user": async (p) => {
    if (!p.username && !p.id) return { text: "missing username or id" };
    return { data: p.username ? await getUserByUsername(p.username) : await getUserById(p.id) };
  },
  "users": async (p) => {
    const ids = (p.ids ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    return ids.length ? { data: await getUsers(ids) } : { text: "missing ids (comma-separated numeric user IDs)" };
  },
  "user-search": async (p) => (p.query ? { data: await searchUsers(p.query) } : { text: "missing search query" }),
  "followers": withId("user id", async (id) => ({ data: await getFollowers(id) })),
  "following": withId("user id", async (id) => ({ data: await getFollowing(id) })),

  // ── other ──
  "article": withId(ID, async (id) => ({ data: await getArticle(id) })),
  "list": withId("list id", async (id) => ({ data: await getList(id) })),
  "list-members": withId("list id", async (id) => ({ data: await getListMembers(id) })),
  "list-followers": withId("list id", async (id) => ({ data: await getListFollowers(id) })),
  "list-tweets": withId("list id", async (id) => ({ data: await getListTweets(id) })),
  "community": withId("community id", async (id) => ({ data: await getCommunity(id) })),
  "community-members": withId("community id", async (id) => ({ data: await getCommunityMembers(id) })),
  "community-posts": withId("community id", async (id) => ({ data: await getCommunityPosts(id) })),
  "user-insights": async (p) => (p.username ? { data: await getUserInsights(p.username) } : { text: "missing username" }),
};

export const handler: SkillHandler = async (params) => {
  const action = actions[params.action];
  if (!action) return { text: `unknown action "${params.action}"` };
  return action(params);
};
