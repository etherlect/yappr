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
      features?: {
        all?: { tags?: { screen_name: string }[] };
      };
    }[];
  };
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
