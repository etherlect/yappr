// Entry point. Wires everything together and starts the two long-running loops:
// the mention poller (reply pipeline) and the treasury cycle (self-funding). Boot
// order: validate config → load hooks/skills/prompts from config/ → init the Bankr
// wallet → start polling → run a startup treasury/claim cycle → schedule the rest.

import { log } from "./log.js";
import { config } from "./config.js";
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

  // Run a treasury/claim cycle on every startup before the recurring scheduler
  // takes over: it claims fees if any have accrued, swaps to USDC, and tops up
  // compute. Awaited so the agent is funded for the run ahead from the first tick.
  log.info("running startup treasury cycle");
  await runTreasuryCycle(treasury, log);

  const stopTreasury = startTreasury(treasury, log);
  log.info("treasury scheduler started");

  // Poll all-time earnings (creator fees, WETH) from Bankr and record into the
  // ledger. A cheap read-only call; default cadence one minute.
  const pollEarnings = async () => {
    try { recordEarned(await treasury.lifetimeEarned()); }
    catch (err) { log.warn({ err }, "earnings poll failed"); }
  };
  await pollEarnings();
  const earningsTimer = setInterval(() => void pollEarnings(), Number(process.env.EARNINGS_POLL_INTERVAL_MS || 60_000));

  log.info("yappr is running");

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => {
      log.info({ sig }, "shutting down");
      poller.stop();
      stopTreasury();
      clearInterval(earningsTimer);
      process.exit(0);
    });
  }
}

main().catch((err) => {
  log.error(err, "fatal startup error");
  process.exit(1);
});
