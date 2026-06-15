import type { Logger } from "pino";
import { config } from "../config.js";
import { searchMentions } from "../x/client.js";
import { loadState, saveState, type State } from "../state.js";
import { recordMention } from "../stats.js";
import { processTweet } from "./pipeline.js";

// The ingest loop: every POLL_INTERVAL_MS it searches for new @mentions, tracks
// the highest tweet id seen (persisted in the state table) so each mention is handled
// once, and hands every fresh mention to processTweet(). Tweet ids are snowflakes
// (monotonically increasing), so we compare them as BigInts to order by recency.

function idGt(a: string, b: string): boolean {
  return BigInt(a) > BigInt(b);
}
function idMax(a: string, b: string): string {
  return idGt(a, b) ? a : b;
}

// Twitter snowflake ids embed a millisecond timestamp in their high bits (epoch
// 2010-11-04). This builds the smallest id for "now", used to anchor the baseline
// at startup when there are no existing mentions to anchor to — so we still reply
// to mentions that arrive afterward instead of treating the first one as backfill.
const TWITTER_EPOCH_MS = 1288834974657n;
function snowflakeForNow(): string {
  return ((BigInt(Date.now()) - TWITTER_EPOCH_MS) << 22n).toString();
}

export function createPoller(log: Logger) {
  let state: State = { lastSeenId: null };
  let isRunning = false;
  let timer: NodeJS.Timeout | null = null;

  async function cycle() {
    if (isRunning) {
      log.warn("previous poll still running, skipping tick");
      return;
    }
    isRunning = true;
    try {
      log.info("poll cycle start");
      const response = await searchMentions(config.agentHandle);
      const tweets = (response.data || []).slice().sort((a, b) => (idGt(a.id, b.id) ? 1 : -1));

      // No baseline yet: skip pre-existing mentions by anchoring the baseline — to the
      // newest mention if any exist, or to startup time otherwise. Keyed on
      // lastSeenId === null (not a one-shot flag) so an empty first poll just retries
      // next tick instead of leaving it unset.
      if (state.lastSeenId === null) {
        state.lastSeenId = tweets.at(-1)?.id ?? snowflakeForNow();
        await saveState(state);
        log.info({ lastSeenId: state.lastSeenId }, "baseline established on startup; skipping backfill");
        return;
      }

      const baseline = state.lastSeenId;
      const fresh = tweets.filter((t) => idGt(t.id, baseline));
      if (fresh.length === 0) return;

      log.info({ count: fresh.length }, "new mentions found");
      recordMention(fresh.length);

      state.lastSeenId = fresh.reduce((max, t) => idMax(max, t.id), fresh[0].id);
      await saveState(state);

      for (const t of fresh) {
        void processTweet(t, log);
      }
    } catch (err) {
      log.error({ err }, "poll cycle failed");
    } finally {
      isRunning = false;
    }
  }

  async function start() {
    state = await loadState();
    log.info({ lastSeenId: state.lastSeenId }, "poller starting");
    void cycle();
    timer = setInterval(() => void cycle(), config.pollIntervalMs);
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { start, stop };
}
