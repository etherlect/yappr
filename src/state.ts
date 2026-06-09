import { withSchema } from "./db.js";

// Durable agent state, kept in its own table in the shared SQLite DB (see db.ts):
// the newest mention already processed, so restarts — and redeploys, since the DB
// lives outside the wiped project dir — don't re-reply to old mentions. A small
// key/value table, with room for more keys later.
//
// The API stays async (the callers `await` it) even though SQLite is synchronous,
// so nothing downstream changes.

export type State = { lastSeenId: string | null };

const LAST_SEEN = "last_seen_id";

const SCHEMA = "CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT)";
const conn = () => withSchema(SCHEMA);

export async function loadState(): Promise<State> {
  const d = conn();
  if (!d) return { lastSeenId: null };
  try {
    const row = d.prepare("SELECT value FROM state WHERE key = ?").get(LAST_SEEN) as { value: string | null } | undefined;
    return { lastSeenId: row?.value ?? null };
  } catch {
    return { lastSeenId: null };
  }
}

export async function saveState(state: State): Promise<void> {
  const d = conn();
  if (!d) return;
  try {
    d.prepare("INSERT INTO state(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(LAST_SEEN, state.lastSeenId);
  } catch { /* best-effort */ }
}
