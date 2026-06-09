import { encodeFunctionData, createPublicClient, http } from "viem";
import { base } from "viem/chains";
import { submitTx, walletAddress, payFetch, paidUsd } from "../wallet.js";
import { bankrApi } from "../bankr.js";
import { fetchComputeInstance, computeInstanceExpiry } from "../compute.js";
import { config } from "../config.js";
import { log } from "../log.js";
import { ERC20_ABI, WETH_ABI, UNISWAP_ROUTER_ABI } from "./abi.js";

export interface Treasury {
  claimableFees(): Promise<{ token0: string; token1: string; hasClaimable: boolean }>;
  claimFees(): Promise<{ token: bigint; weth: bigint }>;
  burnToken(amount: bigint): Promise<string>;
  transferToken(token: `0x${string}`, to: `0x${string}`, amount: bigint): Promise<string>;
  unwrapWethToEth(amount: bigint): Promise<string>;
  swapWethToUsdc(amount: bigint): Promise<string>;
  extendCompute(): Promise<void>;
  computeExpiry(): Promise<Date | null>;
  balances(): Promise<{ token: bigint; weth: bigint; usdc: bigint; eth: bigint }>;
  lifetimeEarned(): Promise<number>;
}

const UNISWAP_ROUTER = "0x2626664c2603336E57B271c5C0b26F421741e481" as `0x${string}`;
export const WETH    = "0x4200000000000000000000000000000000000006" as `0x${string}`;
const USDC           = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as `0x${string}`;
const BURN_ADDRESS   = "0x000000000000000000000000000000000000dead" as `0x${string}`;

const publicClient = createPublicClient({ chain: base, transport: http() });

// Minimal shape of Bankr's GET /token-launches/:addr/fees response — only the
// fields we read. `claimable` amounts are human-readable decimal strings, sometimes
// prefixed with "<" or ">" to denote rounding (e.g. "<0.0001").
type CreatorFeesResponse = {
  tokens?: Array<{
    tokenAddress: string;
    claimable?: { token0: string; token1: string };
  }>;
  // All-time creator fees earned for this launch, denominated in WETH by Bankr
  // (it values every fee token in WETH). This is the "earned" figure we track.
  lifetimeEarnedWeth?: string;
};

function erc20Balance(token: `0x${string}`, owner: `0x${string}`): Promise<bigint> {
  return publicClient.readContract({
    address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [owner],
  }) as Promise<bigint>;
}

let _treasury: Treasury | null = null;

export function getTreasury(): Treasury {
  if (!_treasury) _treasury = createBankrTreasury();
  return _treasury;
}

export function createBankrTreasury(): Treasury {
  return {
    // Read-only check (no tx, no payment) of unclaimed creator fees for our token,
    // via Bankr's GET /token-launches/:addr/fees. The treasury cycle uses this to
    // skip the claim transaction — and its gas — when there's nothing to collect.
    async claimableFees() {
      const res = await bankrApi<CreatorFeesResponse>(
        config.bankrApiKey,
        `/token-launches/${config.tokenAddress}/fees`,
      );
      const token =
        res.tokens?.find((t) => t.tokenAddress?.toLowerCase() === config.tokenAddress.toLowerCase())
        ?? res.tokens?.[0];
      const token0 = token?.claimable?.token0 ?? "0";
      const token1 = token?.claimable?.token1 ?? "0";
      // Mirrors the Bankr CLI's own "has claimable fees" test: strip any "<"/">"
      // rounding prefix and treat a positive amount on either side as claimable.
      const amount = (s: string) => parseFloat(s.replace(/^[<>]/, "")) || 0;
      return { token0, token1, hasClaimable: amount(token0) > 0 || amount(token1) > 0 };
    },

    async claimFees() {
      if (config.treasuryDryRun) {
        log.info("treasury [dry run] claimFees");
        return { token: 0n, weth: 0n };
      }
      // Measure the claim by diffing wallet balances before/after the on-chain
      // settlement — the claim endpoint returns only a tx hash, not amounts.
      const address = walletAddress();
      const [tokenBefore, wethBefore] = await Promise.all([
        erc20Balance(config.tokenAddress, address),
        erc20Balance(WETH, address),
      ]);

      log.info("treasury claimFees submitting");
      const { transactionHash } = await bankrApi<{ transactionHash: string }>(
        config.bankrApiKey,
        `/token-launches/${config.tokenAddress}/fees/claim`,
        { method: "POST", auth: "bearer", body: JSON.stringify({}) },
      );
      await publicClient.waitForTransactionReceipt({ hash: transactionHash as `0x${string}` });

      const [tokenAfter, wethAfter] = await Promise.all([
        erc20Balance(config.tokenAddress, address),
        erc20Balance(WETH, address),
      ]);
      const token = tokenAfter > tokenBefore ? tokenAfter - tokenBefore : 0n;
      const weth = wethAfter > wethBefore ? wethAfter - wethBefore : 0n;
      log.info({ txHash: transactionHash, token: token.toString(), weth: weth.toString() }, "treasury claimFees ok");
      return { token, weth };
    },

    async burnToken(amount: bigint) {
      if (config.treasuryDryRun) {
        log.info({ amount: amount.toString() }, "treasury [dry run] burnToken");
        return "0xdry";
      }
      log.info({ amount: amount.toString() }, "treasury burnToken submitting");
      const data = encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [BURN_ADDRESS, amount] });
      const txHash = await submitTx(config.tokenAddress, data);
      log.info({ txHash, amount: amount.toString() }, "treasury burnToken ok");
      return txHash;
    },

    async transferToken(token: `0x${string}`, to: `0x${string}`, amount: bigint) {
      if (config.treasuryDryRun) {
        log.info({ token, to, amount: amount.toString() }, "treasury [dry run] transferToken");
        return "0xdry";
      }
      log.info({ token, to, amount: amount.toString() }, "treasury transferToken submitting");
      const data = encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [to, amount] });
      const txHash = await submitTx(token, data);
      log.info({ txHash, token, to, amount: amount.toString() }, "treasury transferToken ok");
      return txHash;
    },

    async unwrapWethToEth(amount: bigint) {
      if (config.treasuryDryRun) {
        log.info({ amount: amount.toString() }, "treasury [dry run] unwrapWethToEth");
        return "0xdry";
      }
      log.info({ amount: amount.toString() }, "treasury unwrapWethToEth submitting");
      const data = encodeFunctionData({ abi: WETH_ABI, functionName: "withdraw", args: [amount] });
      const txHash = await submitTx(WETH, data);
      log.info({ txHash, amount: amount.toString() }, "treasury unwrapWethToEth ok");
      return txHash;
    },

    async swapWethToUsdc(amount: bigint) {
      if (config.treasuryDryRun) {
        log.info({ amount: amount.toString() }, "treasury [dry run] swapWethToUsdc");
        return "0xdry";
      }
      log.info({ amount: amount.toString() }, "treasury swapWethToUsdc submitting");
      const data = encodeFunctionData({
        abi: UNISWAP_ROUTER_ABI,
        functionName: "exactInputSingle",
        args: [{
          tokenIn: WETH, tokenOut: USDC, fee: 500,
          recipient: walletAddress(),
          amountIn: amount, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n,
        }],
      });
      const txHash = await submitTx(UNISWAP_ROUTER, data);
      log.info({ txHash, amount: amount.toString() }, "treasury swapWethToUsdc ok");
      return txHash;
    },

    async extendCompute() {
      if (!config.computeInstanceId) return;
      if (config.treasuryDryRun) {
        log.info({ instanceId: config.computeInstanceId }, "treasury [dry run] extendCompute 24h");
        return;
      }
      log.info({ instanceId: config.computeInstanceId }, "treasury extendCompute submitting 24h");
      const res = await payFetch(
        `https://compute.x402layer.cc/compute/instances/${config.computeInstanceId}/extend`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ extend_hours: 24, network: "base" }),
        },
      );
      if (!res.ok) {
        throw new Error(`Compute extend failed: ${res.status} ${await res.text()}`);
      }
      log.info({ usd: paidUsd(res) }, "treasury extendCompute ok (+24h)");
    },

    async computeExpiry() {
      if (!config.computeInstanceId) return null;
      // Instance lookup needs wallet-signature auth — the same authenticated path
      // the deploy script uses. A plain fetch here would 401 and return null, which
      // the cycle would misread as "expiring soon" and buy compute every run.
      try {
        const instance = await fetchComputeInstance(config.bankrApiKey, walletAddress(), config.computeInstanceId);
        return computeInstanceExpiry(instance);
      } catch (err) {
        log.warn({ err }, "compute expiry lookup failed");
        return null;
      }
    },

    // All-time creator fees earned (WETH), straight from Bankr's fees endpoint —
    // the same one claimableFees() reads, but here we take the lifetime total. A
    // read-only call (no payment); polled on a timer to feed the stats ledger.
    async lifetimeEarned() {
      const res = await bankrApi<CreatorFeesResponse>(
        config.bankrApiKey,
        `/token-launches/${config.tokenAddress}/fees`,
      );
      return parseFloat(res.lifetimeEarnedWeth ?? "0") || 0;
    },

    async balances() {
      const address = walletAddress();
      const [token, weth, usdc, eth] = await Promise.all([
        erc20Balance(config.tokenAddress, address),
        erc20Balance(WETH, address),
        erc20Balance(USDC, address),
        publicClient.getBalance({ address }),
      ]);
      return { token, weth, usdc, eth };
    },
  };
}
