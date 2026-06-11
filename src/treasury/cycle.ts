import type { Logger } from "pino";
import { config } from "../config.js";
import {
  runOnBeforeClaim, runOnAfterClaim, runOnSwap,
} from "../hooks/registry.js";
import { type Treasury, WETH } from "./index.js";
import { formatUnits } from "viem";
import { recordDevWeth } from "../stats.js";

// The self-funding loop, run on a timer (TREASURY_INTERVAL_MS). Each cycle:
// claim fees → pay optional dev cut → burn a share of the token → keep a small ETH
// gas reserve → swap remaining WETH to USDC → top up compute when it's expiring.
// All amounts are wei BigInts; treasury.* methods are no-ops under TREASURY_DRY_RUN.

// 0.0001 ETH in wei — kept unwrapped as a gas reserve so the wallet can transact.
const ETH_RESERVE = 100_000_000_000_000n;

// What one cycle did, passed to the onAfterClaim hook (see hooks/types.ts).
export type TreasuryCycleResult = {
  tokenClaimed: bigint;
  wethClaimed: bigint;
  tokenBurned: bigint;
  tokenToDev: bigint;
  wethToDev: bigint;
  wethUnwrapped: bigint;
  wethSwapped: bigint;
  computeExtended: boolean;
  txHashes: string[];
  cycledAt: string;
};

// Run one full treasury/claim cycle. Exported so the entry point can fire one at
// startup (every launch) before the recurring scheduler takes over.
export async function runTreasuryCycle(treasury: Treasury, log: Logger): Promise<void> {
  log.info("treasury cycle start");
  const result: TreasuryCycleResult = {
    tokenClaimed: 0n,
    wethClaimed: 0n,
    tokenBurned: 0n,
    tokenToDev: 0n,
    wethToDev: 0n,
    wethUnwrapped: 0n,
    wethSwapped: 0n,
    computeExtended: false,
    txHashes: [],
    cycledAt: new Date().toISOString(),
  };

  try {
    log.info("treasury step: reading wallet balances");
    const balances = await treasury.balances();
    log.info({
      token: formatUnits(balances.token, 18),
      weth: formatUnits(balances.weth, 18),
      usdc: formatUnits(balances.usdc, 6),
      eth: formatUnits(balances.eth, 18),
      dryRun: config.treasuryDryRun || undefined,
    }, "treasury balances");
    await runOnBeforeClaim(balances);

    // Only claim when there's actually something to collect — the claim is an
    // on-chain tx that costs gas even when no fees have accrued. On a failed check
    // we fall back to attempting the claim so we never silently stop collecting.
    let token = 0n;
    let weth = 0n;
    let shouldClaim = true;
    log.info("treasury step: checking claimable fees");
    try {
      const claimable = await treasury.claimableFees();
      shouldClaim = claimable.hasClaimable;
      log.info({ token0: claimable.token0, token1: claimable.token1, hasClaimable: claimable.hasClaimable }, "claimable fees");
      if (!shouldClaim) {
        log.info("no unclaimed fees — skipping claim this cycle");
      }
    } catch (err) {
      log.warn({ err }, "claimable-fee check failed — attempting claim anyway");
    }

    if (shouldClaim) {
      log.info("treasury step: claiming fees");
      ({ token, weth } = await treasury.claimFees());
      result.tokenClaimed = token;
      result.wethClaimed = weth;
      log.info({ token: formatUnits(token, 18), weth: formatUnits(weth, 18) }, "fees claimed");
    }

    // Dev fee — send a cut of each claimed asset to the dev address. The cut is
    // computed on the total amount claimed this cycle, before burn/swap.
    let wethRemaining = weth;
    if (token === 0n && weth === 0n) {
      log.info("nothing claimed this cycle — skipping dev cut, burn and swap");
    }
    if (config.devAddress && (token > 0n || weth > 0n)) {
      log.info("treasury step: dev cut");
      if (config.devTokenBps > 0 && token > 0n) {
        const devToken = (token * BigInt(config.devTokenBps)) / 10000n;
        if (devToken > 0n) {
          const txHash = await treasury.transferToken(config.tokenAddress, config.devAddress, devToken);
          result.tokenToDev = devToken;
          result.txHashes.push(txHash);
          log.info({ devToken: devToken.toString(), txHash }, "token sent to dev");
        }
      }

      if (config.devWethBps > 0 && weth > 0n) {
        const devWeth = (weth * BigInt(config.devWethBps)) / 10000n;
        if (devWeth > 0n) {
          const txHash = await treasury.transferToken(WETH, config.devAddress, devWeth);
          result.wethToDev = devWeth;
          result.txHashes.push(txHash);
          wethRemaining = weth - devWeth;
          recordDevWeth(Number(formatUnits(devWeth, 18))); // track cumulative dev revenue (WETH)
          log.info({ devWeth: devWeth.toString(), txHash }, "weth sent to dev");
        }
      }
    }

    if (token > 0n) {
      const burnAmount = (token * BigInt(config.burnBps)) / 10000n;
      if (burnAmount > 0n) {
        log.info({ burnAmount: formatUnits(burnAmount, 18) }, "treasury step: burning token");
        await runOnSwap("burn", burnAmount);
        const txHash = await treasury.burnToken(burnAmount);
        result.tokenBurned = burnAmount;
        result.txHashes.push(txHash);
        log.info({ burnAmount: burnAmount.toString(), txHash }, "token burned");
      }
    }

    if (wethRemaining > 0n) {
      let wethToSwap = wethRemaining;

      if (wethRemaining > ETH_RESERVE && balances.eth < ETH_RESERVE) {
        const txHash = await treasury.unwrapWethToEth(ETH_RESERVE);
        result.wethUnwrapped = ETH_RESERVE;
        result.txHashes.push(txHash);
        wethToSwap = wethRemaining - ETH_RESERVE;
        log.info({ amount: ETH_RESERVE.toString(), txHash }, "unwrapped WETH to ETH for gas reserve");
      }

      if (wethToSwap > 0n) {
        log.info({ weth: formatUnits(wethToSwap, 18) }, "treasury step: swapping WETH to USDC");
        await runOnSwap("swap", wethToSwap);
        const txHash = await treasury.swapWethToUsdc(wethToSwap);
        result.wethSwapped = wethToSwap;
        result.txHashes.push(txHash);
        log.info({ weth: wethToSwap.toString(), txHash }, "weth swapped to usdc");
      }
    }

    if (config.computeInstanceId) {
      log.info("treasury step: checking compute expiry");
      const expiry = await treasury.computeExpiry();
      if (!expiry) {
        // Unknown expiry → do NOT buy. Extending on a failed lookup would silently
        // purchase compute every cycle. Better to skip and surface the problem.
        log.warn("could not determine compute expiry — skipping extension to avoid an unintended purchase");
      } else {
        const hoursRemaining = (expiry.getTime() - Date.now()) / (1000 * 60 * 60);
        if (hoursRemaining < 24) {
          await treasury.extendCompute();
          result.computeExtended = true;
          log.info({ hoursRemaining: hoursRemaining.toFixed(1) }, "compute extended (+24h)");
        } else {
          log.info({ hoursRemaining: hoursRemaining.toFixed(1), expiry }, "compute has sufficient time remaining — skipping extension");
        }
      }
    }

    await runOnAfterClaim(result);
    log.info({ cycledAt: result.cycledAt }, "treasury cycle complete");
  } catch (err) {
    log.error({ err }, "treasury cycle failed");
  }
}

// Schedule the recurring treasury cycle. The caller runs the initial startup cycle
// itself (see src/yappr.ts), so this only sets up the timer for subsequent runs.
export function startTreasury(treasury: Treasury, log: Logger): () => void {
  const timer = setInterval(() => void runTreasuryCycle(treasury, log), config.treasuryIntervalMs);
  return () => clearInterval(timer);
}
