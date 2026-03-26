/**
 * Slipstream SDK — extends @uniswap/v3-sdk for Aerodrome Slipstream
 *
 * ~80% of v3-sdk is reused (Position, NonfungiblePositionManager, TickMath, etc.)
 * Only Pool class (tickSpacing override) and mint calldata (12-field struct) differ.
 *
 * Pattern validated by: Aperture Finance, dHEDGE (both in production)
 */

import { Token, CurrencyAmount, Percent } from '@uniswap/sdk-core';
import {
  Pool as UniV3Pool,
  Position,
  NonfungiblePositionManager,
  nearestUsableTick,
  TickMath,
  tickToPrice,
  priceToClosestTick,
  encodeSqrtRatioX96,
} from '@uniswap/v3-sdk';
import { utils } from 'ethers';
import JSBI from 'jsbi';

// ─── Re-export everything that works as-is ───
export {
  Position,
  NonfungiblePositionManager, // removeCallParameters + collectCallParameters reused
  nearestUsableTick,
  TickMath,
  tickToPrice,
  priceToClosestTick,
  encodeSqrtRatioX96,
  Token,
  CurrencyAmount,
  Percent,
  JSBI,
};

// ─── 1. SlipstreamPool ───
// Pattern from Aperture Finance: optional 8th tickSpacing param on Pool constructor.
// We use the same approach but as a subclass for clarity.

export class SlipstreamPool extends UniV3Pool {
  private readonly _tickSpacing: number;

  constructor(
    tokenA: Token,
    tokenB: Token,
    dynamicFee: number, // from pool.fee() — satisfies parent validation
    sqrtRatioX96: JSBI,
    liquidity: JSBI,
    tickCurrent: number,
    tickSpacing: number, // Aerodrome pool identifier — passed explicitly
  ) {
    super(tokenA, tokenB, dynamicFee, sqrtRatioX96, liquidity, tickCurrent);
    this._tickSpacing = tickSpacing;
  }

  // Override: parent derives from TICK_SPACINGS[fee], we use stored value
  get tickSpacing(): number {
    return this._tickSpacing;
  }
}

// ─── 2. Slipstream NonfungiblePositionManager ABI ───
// Separate ABI for mint() — identical to UniV3 except:
//   - int24 tickSpacing replaces uint24 fee (3rd field)
//   - uint160 sqrtPriceX96 appended (12th field, pass 0 for existing pools)
// For increaseLiquidity/decreaseLiquidity/collect: use standard UniV3 ABI (identical structs)

import slipstreamNpmAbi from './abi/slipstreamNonfungiblePositionManager.json';

export const SLIPSTREAM_NPM_INTERFACE = new utils.Interface(slipstreamNpmAbi);

// ─── 3. Mint calldata builder ───
// Pattern from dHEDGE: build params array, encode with Slipstream ABI

export function encodeSlipstreamMint(params: {
  token0: string;
  token1: string;
  tickSpacing: number;
  tickLower: number;
  tickUpper: number;
  amount0Desired: string;
  amount1Desired: string;
  amount0Min: string;
  amount1Min: string;
  recipient: string;
  deadline: number;
}): string {
  // dHEDGE pattern: build tuple array, append sqrtPriceX96 = 0
  const mintParams = [
    params.token0,
    params.token1,
    params.tickSpacing,
    params.tickLower,
    params.tickUpper,
    params.amount0Desired,
    params.amount1Desired,
    params.amount0Min,
    params.amount1Min,
    params.recipient,
    params.deadline,
    0, // sqrtPriceX96 = 0 for existing pools
  ];
  return SLIPSTREAM_NPM_INTERFACE.encodeFunctionData('mint', [mintParams]);
}

// ─── 4. Swap calldata (tickSpacing instead of fee) ───

const SLIPSTREAM_SWAP_ABI = [
  'function exactInputSingle((address tokenIn, address tokenOut, int24 tickSpacing, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) external payable returns (uint256 amountOut)',
];

export const SLIPSTREAM_SWAP_INTERFACE = new utils.Interface(SLIPSTREAM_SWAP_ABI);
