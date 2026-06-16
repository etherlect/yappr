import { summary, getTreasury, llmCreditBalance, log, type SkillHandler } from "yappr";

// stats: the agent's all-time metrics from its own ledger, plus a runway estimate (how
// long the treasury lasts at the current burn). The runway mirrors the status dashboard's
// two-tank model: USDC pays x-api + compute + x402, LLM credits pay inference — runway is
// whichever tank empties first. (Burn math kept in sync with cli/status.ts by hand.)

const RUNWAY_MIN_DATA_HOURS = 1; // trust the measured burn only after this much recorded window
const X_API_POLL_COST_USD = 0.005; // always-on mentions-poll cost — the cold-start/floor burn

function fmtDuration(hours: number): string {
  if (!Number.isFinite(hours)) return "∞";
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

export const handler: SkillHandler = async () => {
  const s = summary();

  // Burn rates from the trailing window. usdcBurn = x-api+compute+x402 (total minus the
  // inference slice), floored at the always-on poll cost so downtime can't inflate runway;
  // llmBurn = inference. Before there's enough recorded window, fall back to the poll-cost
  // estimate for USDC and treat inference as not-yet-binding.
  const pollSeconds = Math.round((Number(process.env.POLL_INTERVAL_MS) || 20_000) / 1000);
  const predictedUsdcBurn = pollSeconds > 0 ? (3600 / pollSeconds) * X_API_POLL_COST_USD : 0;
  const hasRate = s.rateWindowHours >= RUNWAY_MIN_DATA_HOURS && s.spentUsdWindow > 0;
  const usdcBurn = hasRate
    ? Math.max((s.spentUsdWindow - s.inferenceUsdWindow) / s.rateWindowHours, predictedUsdcBurn)
    : predictedUsdcBurn;
  const llmBurn = hasRate ? s.inferenceUsdWindow / s.rateWindowHours : 0;

  // Treasury value per tank: the USDC balance (live, on-chain) and the LLM credit balance.
  let usdcUsd: number | null = null;
  try {
    usdcUsd = Number((await getTreasury().balances()).usdc) / 1e6;
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, "stats: balances fetch failed");
  }
  const creditUsd = await llmCreditBalance();

  const usdcRunwayH = usdcBurn > 0 ? (usdcUsd != null ? usdcUsd / usdcBurn : Infinity) : Infinity;
  const llmRunwayH = llmBurn > 0 ? (creditUsd != null ? creditUsd / llmBurn : Infinity) : Infinity;
  const runwayHours = Math.min(usdcRunwayH, llmRunwayH);
  const runwayKnown = usdcUsd != null || creditUsd != null;

  const runway = !runwayKnown
    ? { available: false as const }
    : {
        available: true as const,
        human: fmtDuration(runwayHours),
        hours: Number.isFinite(runwayHours) ? Number(runwayHours.toFixed(1)) : null, // null ≈ effectively infinite
        days: Number.isFinite(runwayHours) ? Number((runwayHours / 24).toFixed(2)) : null,
        estimated: !hasRate, // cold-start estimate — not enough recorded burn yet
        limitedBy: usdcRunwayH <= llmRunwayH ? "usdc" : "llm-credits",
        usdcBalanceUsd: usdcUsd,
        llmCreditUsd: creditUsd,
        usdcBurnUsdPerHour: Number(usdcBurn.toFixed(4)),
        llmBurnUsdPerHour: Number(llmBurn.toFixed(4)),
      };

  return {
    data: {
      mentions: s.mentions,
      replies: s.replies,
      llmCalls: s.llm,
      // warns/errors are deliberately omitted — internal health metrics, not user-facing
      // (and this skill is public). They stay in summary() for the admin status dashboard.
      spentUsd: Number(s.spentUsd.toFixed(4)),
      spentByType: s.spentByType, // { "x-api", inference, compute, x402 }
      earnedWeth: s.earnedWeth, // lifetime gross creator fees, in ETH/WETH
      devWeth: s.devWeth, // dev cut within earnedWeth
      runway,
    },
  };
};
