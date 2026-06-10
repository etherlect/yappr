#!/usr/bin/env node
// The `yappr` command. A thin dispatcher; each subcommand lazy-imports its module so
// `init` (used before deps/config exist) never loads the engine.

function help(): void {
  console.log(`yappr — self-funding X reply agent

Usage: yappr <command> [args]

  init [dir]        Scaffold a project (config/ + .env.example) into dir (default: .)
  start             Run the agent — loads ./config and ./.env
  deploy            Provision + deploy to an x402 compute instance
  status [id]       Live dashboard for the deployed instance
  ssh [id]          Open an interactive shell on the deployed instance
  help              Show this help
`);
}

// Hand control to a subcommand module's run(), making its process.argv look like a
// direct invocation (drop the subcommand token) so its own argv parsing still works.
async function delegate(path: string): Promise<void> {
  process.argv.splice(2, 1);
  const mod = (await import(path)) as { run: () => Promise<void> };
  await mod.run();
}

const cmd = process.argv[2];

try {
  switch (cmd) {
    case "init": {
      const { runInit } = await import("./init.js");
      await runInit(process.argv[3]);
      break;
    }
    case "start":
      // Booting the agent is a side effect of importing its entry module.
      await import("../yappr.js");
      break;
    case "deploy": await delegate("./deploy.js"); break;
    case "status": await delegate("./status.js"); break;
    case "ssh": await delegate("./ssh.js"); break;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      help();
      break;
    default:
      console.error(`yappr: unknown command "${cmd}"\n`);
      help();
      process.exit(1);
  }
} catch (err: any) {
  // Ctrl-C inside an inquirer prompt rejects with ExitPromptError — that's the
  // user quitting, not a failure: exit quietly instead of dumping a stack trace.
  if (err?.name === "ExitPromptError") {
    console.log("\n  Aborted.");
    process.exit(0);
  }
  console.error(`\n  ✗  ${err?.message ?? err}`);
  process.exit(1);
}
