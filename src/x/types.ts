export type PublicMetrics = {
  retweet_count?: number;
  reply_count?: number;
  like_count?: number;
  quote_count?: number;
  bookmark_count?: number;
};

export type Tweet = {
  id: string;
  text: string;
  created_at: string;
  author_id: string;
  conversation_id: string;
  in_reply_to_user_id?: string | null;
  // Handle (without @) this tweet is a reply to. Reading it here lets gating run
  // without fetching the parent tweet — see replyToScreenName.
  in_reply_to_screen_name?: string | null;
  referenced_tweets?: { type: string; id: string }[];
  entities?: {
    mentions?: { username: string }[];
    media?: {
      // "photo" | "video" | "animated_gif" — only photos are sent to the vision model.
      type?: string;
      // Direct CDN URL of the image (e.g. https://pbs.twimg.com/media/….jpg).
      media_url_https?: string;
      features?: {
        all?: { tags?: { screen_name: string }[] };
      };
    }[];
  };
  // Parallel media list the X API also returns; carries the same media_url. Used as
  // a fallback when entities.media is absent. (Declared because we read it at runtime.)
  media_metadata?: { media_key?: string; media_url?: string }[];
  public_metrics?: PublicMetrics;
  author?: {
    id: string;
    username: string;
    name: string;
    description?: string;
    public_metrics?: {
      followers_count?: number;
      following_count?: number;
      tweet_count?: number;
      listed_count?: number;
      like_count?: number;
      media_count?: number;
    };
  };
};

export type SearchResponse = {
  data: Tweet[];
  meta?: { next_token?: string };
};
