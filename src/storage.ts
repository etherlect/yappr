import { withSchema } from "./db.js";

// Namespaced key/value storage for skills and hooks, in the shared SQLite DB
// (see db.ts). This is the convenience layer of the public storage API: a skill
// calls skillStore("<its-name>") and gets get/set/delete/list with zero SQL and
// zero schema decisions. All namespaces share one table (skill_kv) keyed on
// (ns, key), so a store can only see its own namespace's rows.
//
// Because rows live in yappr.db at DB_PATH, skill data survives restarts and
// redeploys and is included in the dashboard's rolling backups — which is why
// skills should store here rather than open their own files.
//
// Convention: namespace = the skill's folder name, unless two extensions are
// deliberately sharing data. Skills that need real columns instead of KV use
// withSchema() directly with their own `skill_<name>_*` table.
//
// Like everything on db.ts, operations are best-effort: if the DB can't be
// opened, reads return empty and writes no-op, degrading the skill instead of
// crashing the agent.

const SCHEMA = `CREATE TABLE IF NOT EXISTS skill_kv (
  ns TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (ns, key)
)`;

const conn = () => withSchema(SCHEMA);

// Escape LIKE wildcards so list("user:") treats the prefix literally.
const likePrefix = (prefix: string) => prefix.replace(/[\\%_]/g, (c) => "\\" + c) + "%";

export type SkillStoreEntry = { key: string; value: string; updatedAt: number };

export type SkillStore = {
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string): boolean;
  list(prefix?: string): SkillStoreEntry[];
};

export function skillStore(ns: string): SkillStore {
  return {
    get(key) {
      const d = conn();
      if (!d) return null;
      try {
        const row = d.prepare("SELECT value FROM skill_kv WHERE ns = ? AND key = ?").get(ns, key) as { value: string } | undefined;
        return row?.value ?? null;
      } catch {
        return null;
      }
    },

    set(key, value) {
      const d = conn();
      if (!d) return;
      try {
        d.prepare(
          "INSERT INTO skill_kv(ns, key, value, updated_at) VALUES(?, ?, ?, ?) " +
          "ON CONFLICT(ns, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        ).run(ns, key, value, Date.now());
      } catch { /* best-effort */ }
    },

    delete(key) {
      const d = conn();
      if (!d) return false;
      try {
        return d.prepare("DELETE FROM skill_kv WHERE ns = ? AND key = ?").run(ns, key).changes > 0;
      } catch {
        return false;
      }
    },

    list(prefix) {
      const d = conn();
      if (!d) return [];
      try {
        const rows = prefix !== undefined
          ? d.prepare("SELECT key, value, updated_at FROM skill_kv WHERE ns = ? AND key LIKE ? ESCAPE '\\' ORDER BY key").all(ns, likePrefix(prefix))
          : d.prepare("SELECT key, value, updated_at FROM skill_kv WHERE ns = ? ORDER BY key").all(ns);
        return (rows as { key: string; value: string; updated_at: number }[])
          .map((r) => ({ key: r.key, value: r.value, updatedAt: r.updated_at }));
      } catch {
        return [];
      }
    },
  };
}
