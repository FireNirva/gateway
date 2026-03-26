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
