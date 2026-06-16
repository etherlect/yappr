import "dotenv/config";
import { summary, recordSpend, type SpendType } from "./stats.js";
import { getDb } from "./db.js";

// Tiny command-line face on the stats DB, compiled to dist so it can be invoked over
// SSH without tsx. Used by the dashboard:
//   node node_modules/yappr/dist/src/stats-cli.js summary        → prints Summary JSON
//   node node_modules/yappr/dist/src/stats-cli.js cron           → prints the cron_jobs
//        rows as JSON (schedule pre-rendered, source tweet dropped) for the CRON page
//   node node_modules/yappr/dist/src/stats-cli.js backup <dest>  → writes a consistent
//        snapshot of the DB to <dest> (pulled down as a local backup)
//   node node_modules/yappr/dist/src/stats-cli.js record-spend <type> <usd> → append one
//        spend event (used by `yappr deploy` to book the deploy-time compute payment,
//        which is paid locally — outside the agent's payFetch — so it'd otherwise be lost)
// It opens the same DB the agent uses (via db.ts, which reads DB_PATH), so its reads
// land in the same database.

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "summary":
      process.stdout.write(JSON.stringify(summary()));
      return;
    case "cron": {
      // Lazy import: cron/store pulls in config.ts, which requires the full agent
      // env at import time — summary/backup must keep working without it.
      const { listCronJobs, describeSchedule } = await import("./cron/store.js");
      const jobs = listCronJobs().map((j) => ({
        id: j.id,
        prompt: j.prompt,
        schedule: describeSchedule(j.schedule),
        creator: j.creatorHandle,
        enabled: j.enabled,
        nextRunAt: j.nextRunAt,
        lastRunAt: j.lastRunAt,
        lastResult: j.lastResult,
        lastError: j.lastError,
        runs: j.runs,
        consecutiveFailures: j.consecutiveFailures,
        createdAt: j.createdAt,
      }));
      process.stdout.write(JSON.stringify(jobs));
      return;
    }
    case "backup": {
      const dest = args[0];
      if (!dest) {
        process.stderr.write("backup: expected a destination path\n");
        process.exit(1);
      }
      const db = getDb();
      if (!db) {
        process.stderr.write("backup: could not open the stats DB\n");
        process.exit(1);
      }
      // VACUUM INTO writes a single consistent, compacted copy — safe while the agent
      // is writing (WAL readers see a stable snapshot) and free of -wal/-shm sidecars.
      db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
      process.stdout.write(JSON.stringify({ ok: true, dest }));
      return;
    }
    case "record-spend": {
      // Append one spend event to the ledger. Used by `yappr deploy` to book the
      // deploy-time compute payment (paid locally, outside the agent's payFetch).
      const [type, usdRaw] = args;
      const usd = Number(usdRaw);
      const valid: SpendType[] = ["x-api", "compute", "inference", "x402"];
      if (!type || !valid.includes(type as SpendType) || !Number.isFinite(usd) || usd <= 0) {
        process.stderr.write(`record-spend: expected <type: ${valid.join(" | ")}> <usd> (positive number)\n`);
        process.exit(1);
      }
      recordSpend(type as SpendType, usd);
      process.stdout.write(JSON.stringify({ ok: true, type, usd }));
      return;
    }
    default:
      process.stderr.write(`stats-cli: unknown command ${JSON.stringify(cmd)} (expected: summary | cron | backup | record-spend)\n`);
      process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`stats-cli: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
