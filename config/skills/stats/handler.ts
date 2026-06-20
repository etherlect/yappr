import { summary, dailyStats, getTreasury, llmCreditBalance, log, type SkillHandler, type SpendType } from "yappr";

// stats: the agent's all-time metrics from its own ledger, plus a runway estimate (how
// long the treasury lasts at the current burn). The runway mirrors the status dashboard's
// two-tank model: USDC pays x-api + compute + x402, LLM credits pay inference — runway is
// whichever tank empties first. (Burn math kept in sync with cli/status.ts by hand.)

const RUNWAY_MIN_DATA_HOURS = 1; // trust the measured burn only after this much recorded window
const X_API_POLL_COST_USD = 0.005; // always-on mentions-poll cost — the cold-start/floor burn
// Every Bankr/Clanker launch ships a fixed 100B supply, so burned-% is computed against
// this constant rather than fetched (same assumption as the status dashboard, cli/status.ts).
const TOKEN_TOTAL_SUPPLY = 100_000_000_000;

// Tokens burned as a % of total supply, matching the dashboard's precision: 1 decimal once
// past 1%, else 2 significant figures so early burns (e.g. 0.0025%) still show.
function burnedPctOfSupply(tokensBurned: number): number {
  const pct = (tokensBurned / TOKEN_TOTAL_SUPPLY) * 100;
  return pct >= 1 ? Number(pct.toFixed(1)) : Number(pct.toPrecision(2));
}

// Abbreviate a token balance for display: 2,452,720 → "2.5M", 1,200 → "1.2K", 940 → "940".
function abbreviateTokens(n: number): string {
  for (const [base, suffix] of [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]] as const) {
    if (n >= base) return `${(n / base).toFixed(1).replace(/\.0$/, "")}${suffix}`;
  }
  return n.toFixed(0);
}

function fmtDuration(hours: number): string {
  if (!Number.isFinite(hours)) return "∞";
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

// Public spend breakdown: fold X-data (x-api) into x402 so the reply only ever shows a
// single x402 figure, never the internal x-api/x402 split. Rounded for display.
function publicSpendByType(byType: Record<SpendType, number>) {
  return {
    inference: Number(byType.inference.toFixed(4)),
    compute: Number(byType.compute.toFixed(4)),
    x402: Number((byType.x402 + byType["x-api"]).toFixed(4)),
  };
}

export const handler: SkillHandler = async () => {
  const s = summary();
  const day = dailyStats(); // trailing-24h rollup from the same ledger

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

  // Live, on-chain treasury reads (best-effort, independent via allSettled so one failing
  // keeps the other): the USDC balance for the runway, and the exact tokens burned to date,
  // read straight from the burn address — ground truth, with the stats ledger's tokenBurned
  // as the fallback. Then the LLM credit balance for the inference tank.
  let usdcUsd: number | null = null;
  let tokenBurned = s.tokenBurned;
  let balances: { token: bigint; weth: bigint; usdc: bigint; eth: bigint } | null = null;
  let tokenSymbol = "TOKEN";
  {
    const treasury = getTreasury();
    const [balRes, burnRes, symRes] = await Promise.allSettled([
      treasury.balances(), treasury.tokensBurned(), treasury.tokenSymbol(),
    ]);
    if (balRes.status === "fulfilled") { balances = balRes.value; usdcUsd = Number(balances.usdc) / 1e6; }
    else log.warn({ err: String(balRes.reason) }, "stats: balances fetch failed");
    if (burnRes.status === "fulfilled") tokenBurned = burnRes.value;
    else log.warn({ err: String(burnRes.reason) }, "stats: on-chain burned read failed — using ledger total");
    if (symRes.status === "fulfilled") tokenSymbol = symRes.value;
    else log.warn({ err: String(symRes.reason) }, "stats: token symbol read failed");
  }
  const creditUsd = await llmCreditBalance();

  // Treasury holdings, one line: USDC, agent token, WETH, ETH, LLM credits — each segment
  // dropped when its balance is 0 (and the whole line null if nothing's known). ETH/WETH to
  // 3 decimals, the token abbreviated (e.g. "2.4M YAPPR"), credits in USD. (token/weth/eth
  // are 18-decimals, usdc 6 — converted by plain division so the handler needs no viem.)
  const treasuryParts: string[] = [];
  if (balances) {
    const usdc = Number(balances.usdc) / 1e6;
    const token = Number(balances.token) / 1e18;
    const weth = Number(balances.weth) / 1e18;
    const eth = Number(balances.eth) / 1e18;
    if (usdc > 0) treasuryParts.push(`${usdc.toFixed(2)} USDC`);
    if (token > 0) treasuryParts.push(`${abbreviateTokens(token)} ${tokenSymbol}`);
    if (weth > 0) treasuryParts.push(`${weth.toFixed(3)} WETH`);
    if (eth > 0) treasuryParts.push(`${eth.toFixed(3)} ETH`);
  }
  if (creditUsd != null && creditUsd > 0) treasuryParts.push(`$${creditUsd.toFixed(2)} LLM credits`);
  const treasuryLine = treasuryParts.length > 0 ? treasuryParts.join(", ") : null;

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

  // Three groups: `daily` (last 24h activity), `allTime` (lifetime totals), and `balance`
  // (current holdings + forward-looking runway). warns/errors are deliberately omitted from
  // both rollups — internal health metrics, not user-facing (kept in summary() for the
  // admin dashboard). x-api is folded into x402 in every spentByType (publicSpendByType).
  return {
    data: {
      daily: {
        mentions: day.mentions,
        replies: day.replies,
        llmCalls: day.llmCalls,
        spentUsd: Number(day.spentUsd.toFixed(4)),
        spentByType: publicSpendByType(day.spentByType),
        earnedWeth: day.earnedWeth, // gross creator fees in the last 24h, ETH/WETH
        tokenBurned: day.tokenBurned, // tokens burned in the last 24h (ledger-recorded burns)
      },
      allTime: {
        mentions: s.mentions,
        replies: s.replies,
        llmCalls: s.llm,
        spentUsd: Number(s.spentUsd.toFixed(4)),
        spentByType: publicSpendByType(s.spentByType),
        earnedWeth: s.earnedWeth, // lifetime gross creator fees, in ETH/WETH
        devWeth: s.devWeth, // dev cut within earnedWeth
        tokenBurned, // exact tokens burned to date, read live on-chain from the burn address
        tokenBurnedPctOfSupply: burnedPctOfSupply(tokenBurned), // burned as a % of the fixed 100B supply
      },
      balance: {
        treasury: treasuryLine, // ready-to-show holdings line (null when no balance is known)
        runway,
      },
    },
  };
};
