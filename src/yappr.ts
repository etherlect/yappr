// Entry point. Wires everything together and starts the two long-running loops:
// the mention poller (reply pipeline) and the treasury cycle (self-funding). Boot
// order: validate config → load hooks/skills/prompts from config/ → init the Bankr
// wallet → start polling → run a startup treasury/claim cycle → schedule the rest.

import { log } from "./log.js";
import { config } from "./config.js";
import { envNumber } from "./util.js";
import { initBankr } from "./wallet.js";
import { loadPrompts } from "./llm/prompts.js";
import { setPrompts, loadModelPricing } from "./llm/index.js";
import { recordEarned } from "./stats.js";
import { createPoller } from "./reply/poller.js";
import { getTreasury } from "./treasury/index.js";
import { startTreasury, runTreasuryCycle } from "./treasury/cycle.js";
import { loadHooks } from "./hooks/loader.js";
import { loadSkills } from "./skills/loader.js";
import { initSkills } from "./skills/registry.js";

const processOld = process.argv.includes("--process-old");

async function main() {
  if (config.burnBps + config.devTokenBps > 10000) {
    throw new Error(`BURN_BPS (${config.burnBps}) + DEV_TOKEN_BPS (${config.devTokenBps}) exceeds 10000`);
  }
  if (config.devWethBps > 10000) {
    throw new Error(`DEV_WETH_BPS (${config.devWethBps}) exceeds 10000`);
  }

  await loadHooks();

  log.info("initialising Bankr signer");
  const address = await initBankr();
  log.info({ address }, "Bankr wallet ready");

  const skills = await loadSkills();
  initSkills(skills);
  log.info({ count: skills.length, names: skills.map((s) => s.name) }, "skills loaded");

  const prompts = await loadPrompts(skills);
  setPrompts(prompts);
  log.info("prompts loaded");

  // Warm the LLM pricing cache (USD per 1M tokens) so every completion can be costed
  // from its token usage and recorded as inference spend.
  await loadModelPricing();

  const treasury = getTreasury();

  const poller = createPoller(log);
  await poller.start({ processOld });

  // First treasury/claim cycle runs a short delay after launch (not at t=0). Right at
  // boot the wallet/Bankr fee indexer isn't always ready, so the claimable-fee check
  // could report "no fees" before freshly-accrued fees became visible — then a later
  // cycle would do the claim, making the boot log look wrong. The hourly scheduler below
  // runs independently. (`runTreasuryCycle` self-catches, so this never crashes boot.)
  const startupCycleDelayMs = envNumber("STARTUP_TREASURY_DELAY_MS", 10_000);
  log.info({ delayMs: startupCycleDelayMs }, "scheduling startup treasury cycle");
  const startupCycle = setTimeout(() => {
    void runTreasuryCycle(treasury, log).catch((err) => log.error({ err }, "startup treasury cycle failed"));
  }, startupCycleDelayMs);

  const stopTreasury = startTreasury(treasury, log);
  log.info("treasury scheduler started");

  // Poll all-time earnings (creator fees, WETH) from Bankr and record into the
  // ledger. A cheap read-only call; default cadence one minute.
  const pollEarnings = async () => {
    try { recordEarned(await treasury.lifetimeEarned()); }
    catch (err) { log.warn({ err }, "earnings poll failed"); }
  };
  await pollEarnings();
  const earningsTimer = setInterval(() => void pollEarnings(), envNumber("EARNINGS_POLL_INTERVAL_MS", 60_000));

  log.info("yappr is running");

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => {
      log.info({ sig }, "shutting down");
      poller.stop();
      stopTreasury();
      clearTimeout(startupCycle);
      clearInterval(earningsTimer);
      process.exit(0);
    });
  }
}

main().catch((err) => {
  log.error(err, "fatal startup error");
  process.exit(1);
});
