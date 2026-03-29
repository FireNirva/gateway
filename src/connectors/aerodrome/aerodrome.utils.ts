import { Contract } from '@ethersproject/contracts';
import { Token } from '@uniswap/sdk-core';
import { FastifyInstance } from 'fastify';

import { Ethereum } from '../../chains/ethereum/ethereum';
import { logger } from '../../services/logger';

import { Aerodrome } from './aerodrome';

// Minimal inline ABIs — Aerodrome CLPool (Slipstream)
// DO NOT import from shared pool-info-helpers (has UniV3-specific fee encoding)

const POOL_TOKEN_ABI = [
  { inputs: [], name: 'token0', outputs: [{ type: 'address' }], stateMutability: 'view', type: 'function' },
  { inputs: [], name: 'token1', outputs: [{ type: 'address' }], stateMutability: 'view', type: 'function' },
];

const POOL_TICK_SPACING_ABI = [
  { inputs: [], name: 'tickSpacing', outputs: [{ type: 'int24' }], stateMutability: 'view', type: 'function' },
];

const POOL_FEE_ABI = [
  { inputs: [], name: 'fee', outputs: [{ type: 'uint24' }], stateMutability: 'view', type: 'function' },
];

// Aerodrome slot0 has 6 fields (NOT 7 like UniV3 — no feeProtocol)
const POOL_SLOT0_ABI = [
  {
    inputs: [],
    name: 'slot0',
    outputs: [
      { name: 'sqrtPriceX96', type: 'uint160' },
      { name: 'tick', type: 'int24' },
      { name: 'observationIndex', type: 'uint16' },
      { name: 'observationCardinality', type: 'uint16' },
      { name: 'observationCardinalityNext', type: 'uint16' },
      { name: 'unlocked', type: 'bool' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
];

const POOL_LIQUIDITY_ABI = [
  { inputs: [], name: 'liquidity', outputs: [{ type: 'uint128' }], stateMutability: 'view', type: 'function' },
];

// Aerodrome Slipstream ticks() has an extra `stakedLiquidityNet` field vs Uniswap V3
const POOL_FEE_GROWTH_ABI = [
  {
    inputs: [],
    name: 'feeGrowthGlobal0X128',
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'feeGrowthGlobal1X128',
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: '', type: 'int24' }],
    name: 'ticks',
    outputs: [
      { name: 'liquidityGross', type: 'uint128' },
      { name: 'liquidityNet', type: 'int128' },
      { name: 'stakedLiquidityNet', type: 'int128' },
      { name: 'feeGrowthOutside0X128', type: 'uint256' },
      { name: 'feeGrowthOutside1X128', type: 'uint256' },
      { name: 'rewardGrowthOutsideX128', type: 'uint256' },
      { name: 'tickCumulativeOutside', type: 'int56' },
      { name: 'secondsPerLiquidityOutsideX128', type: 'uint160' },
      { name: 'secondsOutside', type: 'uint32' },
      { name: 'initialized', type: 'bool' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
];

const POOL_GAUGE_ABI = [
  { inputs: [], name: 'gauge', outputs: [{ type: 'address' }], stateMutability: 'view', type: 'function' },
];

export interface AerodromePoolInfo {
  baseTokenAddress: string;
  quoteTokenAddress: string;
  poolType: 'clmm';
}

/**
 * Get pool token addresses from on-chain
 */
export async function getAerodromePoolInfo(poolAddress: string, network: string): Promise<AerodromePoolInfo | null> {
  try {
    const ethereum = await Ethereum.getInstance(network);
    const poolContract = new Contract(poolAddress, POOL_TOKEN_ABI, ethereum.provider);

    const [token0, token1] = await Promise.all([poolContract.token0(), poolContract.token1()]);

    return { baseTokenAddress: token0, quoteTokenAddress: token1, poolType: 'clmm' };
  } catch (error) {
    logger.error(`Error getting Aerodrome pool info: ${(error as Error).message}`);
    return null;
  }
}

/**
 * Read tickSpacing from pool contract (Aerodrome pool identifier, NOT fee)
 */
export async function getTickSpacing(poolAddress: string, network: string): Promise<number> {
  const ethereum = await Ethereum.getInstance(network);
  const pool = new Contract(poolAddress, POOL_TICK_SPACING_ABI, ethereum.provider);
  return await pool.tickSpacing();
}

/**
 * Read dynamic fee from pool contract (in pips, e.g. 500 = 0.05%)
 * Aerodrome fees are mutable via SwapFeeModule — always read live.
 */
export async function getDynamicFee(poolAddress: string, network: string): Promise<number> {
  const ethereum = await Ethereum.getInstance(network);
  const pool = new Contract(poolAddress, POOL_FEE_ABI, ethereum.provider);
  return await pool.fee();
}

/**
 * Read slot0 — only extract sqrtPriceX96 and tick (same usage as Uniswap)
 * Aerodrome returns 6 fields (no feeProtocol), but we only use first 2.
 */
export async function getSlot0(poolAddress: string, network: string): Promise<{ sqrtPriceX96: any; tick: number }> {
  const ethereum = await Ethereum.getInstance(network);
  const pool = new Contract(poolAddress, POOL_SLOT0_ABI, ethereum.provider);
  const slot0 = await pool.slot0();
  const [sqrtPriceX96, tick] = slot0;
  return { sqrtPriceX96, tick };
}

/**
 * Read current pool liquidity
 */
export async function getPoolLiquidity(poolAddress: string, network: string): Promise<any> {
  const ethereum = await Ethereum.getInstance(network);
  const pool = new Contract(poolAddress, POOL_LIQUIDITY_ABI, ethereum.provider);
  return await pool.liquidity();
}

/**
 * Read gauge address from pool contract (pool.gauge())
 */
export async function getPoolGauge(poolAddress: string, network: string): Promise<string> {
  const ethereum = await Ethereum.getInstance(network);
  const pool = new Contract(poolAddress, POOL_GAUGE_ABI, ethereum.provider);
  return await pool.gauge();
}

/**
 * Compute uncollected LP trading fees for a position.
 *
 * For gauge-staked positions, tokensOwed0/1 stays 0 because collect() hasn't
 * been called. The real fees are computed from feeGrowthInside deltas:
 *   uncollected = (feeGrowthInsideCurrent - feeGrowthInsideLast) * liquidity / 2^128
 *
 * feeGrowthInsideCurrent is derived from pool's global and per-tick data.
 */
export async function getUncollectedFees(
  poolAddress: string,
  network: string,
  tickLower: number,
  tickUpper: number,
  liquidity: any, // BigNumber
  feeGrowthInside0LastX128: any, // BigNumber from position
  feeGrowthInside1LastX128: any, // BigNumber from position
  token0Decimals: number,
  token1Decimals: number,
): Promise<{ fee0: number; fee1: number }> {
  try {
    const { BigNumber } = await import('ethers');
    const ethereum = await Ethereum.getInstance(network);
    const pool = new Contract(poolAddress, [...POOL_FEE_GROWTH_ABI, ...POOL_SLOT0_ABI], ethereum.provider);

    const [feeGrowthGlobal0, feeGrowthGlobal1, tickLowerData, tickUpperData, slot0] = await Promise.all([
      pool.feeGrowthGlobal0X128(),
      pool.feeGrowthGlobal1X128(),
      pool.ticks(tickLower),
      pool.ticks(tickUpper),
      pool.slot0(),
    ]);

    const currentTick: number = slot0[1];
    const Q128 = BigNumber.from(2).pow(128);
    const Q256 = BigNumber.from(2).pow(256);

    // Modular subtraction for uint256 (handles wrap-around like Solidity)
    const subMod256 = (a: any, b: any) => {
      const result = a.sub(b);
      return result.lt(0) ? result.add(Q256) : result;
    };

    // Compute feeGrowthInside for each token (Uniswap V3 / Slipstream math)
    const computeFeeGrowthInside = (feeGrowthGlobal: any, feeGrowthOutsideLower: any, feeGrowthOutsideUpper: any) => {
      // feeGrowthBelow
      const feeGrowthBelow =
        currentTick >= tickLower ? feeGrowthOutsideLower : subMod256(feeGrowthGlobal, feeGrowthOutsideLower);
      // feeGrowthAbove
      const feeGrowthAbove =
        currentTick < tickUpper ? feeGrowthOutsideUpper : subMod256(feeGrowthGlobal, feeGrowthOutsideUpper);
      // feeGrowthInside = global - below - above (mod 2^256)
      return subMod256(subMod256(feeGrowthGlobal, feeGrowthBelow), feeGrowthAbove);
    };

    const feeGrowthInside0Current = computeFeeGrowthInside(
      feeGrowthGlobal0,
      tickLowerData.feeGrowthOutside0X128,
      tickUpperData.feeGrowthOutside0X128,
    );
    const feeGrowthInside1Current = computeFeeGrowthInside(
      feeGrowthGlobal1,
      tickLowerData.feeGrowthOutside1X128,
      tickUpperData.feeGrowthOutside1X128,
    );

    // uncollected = (current - last) * liquidity / 2^128 (all mod 2^256)
    const liq = BigNumber.from(liquidity.toString());
    const delta0 = subMod256(feeGrowthInside0Current, BigNumber.from(feeGrowthInside0LastX128.toString()));
    const delta1 = subMod256(feeGrowthInside1Current, BigNumber.from(feeGrowthInside1LastX128.toString()));

    const uncollected0 = delta0.mul(liq).div(Q128);
    const uncollected1 = delta1.mul(liq).div(Q128);

    const fee0 = formatTokenAmount(uncollected0.toString(), token0Decimals);
    const fee1 = formatTokenAmount(uncollected1.toString(), token1Decimals);

    return { fee0, fee1 };
  } catch (error) {
    logger.warn(`Failed to compute uncollected fees: ${(error as Error).message}`);
    return { fee0: 0, fee1: 0 };
  }
}

/**
 * Gets a Uniswap SDK Token from a token symbol (for use with SlipstreamPool)
 */
export async function getFullTokenFromSymbol(
  fastify: FastifyInstance,
  ethereum: Ethereum,
  aerodrome: Aerodrome,
  tokenSymbol: string,
): Promise<Token> {
  if (!ethereum.ready()) {
    await ethereum.init();
  }

  const tokenInfo = await ethereum.getToken(tokenSymbol);

  if (!tokenInfo) {
    throw fastify.httpErrors.badRequest(`Token ${tokenSymbol} is not supported`);
  }

  return aerodrome.getToken(tokenInfo);
}

/**
 * Format token amounts for display
 */
export const formatTokenAmount = (amount: string | number, decimals: number): number => {
  try {
    if (typeof amount === 'string') {
      return parseFloat(amount) / Math.pow(10, decimals);
    }
    return amount / Math.pow(10, decimals);
  } catch (error) {
    logger.error(`Error formatting token amount: ${error}`);
    return 0;
  }
};
