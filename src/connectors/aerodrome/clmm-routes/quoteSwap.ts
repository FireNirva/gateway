import { Contract } from '@ethersproject/contracts';
import { BigNumber, utils } from 'ethers';
import { FastifyPluginAsync } from 'fastify';

import { Ethereum } from '../../../chains/ethereum/ethereum';
import {
  QuoteSwapRequestType,
  QuoteSwapRequest,
  QuoteSwapResponseType,
  QuoteSwapResponse,
} from '../../../schemas/clmm-schema';
import { httpErrors } from '../../../services/error-handler';
import { logger } from '../../../services/logger';
import { PoolService } from '../../../services/pool-service';
import { sanitizeErrorMessage } from '../../../services/sanitize';
import { Aerodrome } from '../aerodrome';
import { AerodromeConfig } from '../aerodrome.config';
import { getAerodromePoolInfo, getTickSpacing, formatTokenAmount } from '../aerodrome.utils';

// Aerodrome QuoterV2 ABI (uses tickSpacing instead of fee)
const QUOTER_V2_ABI = [
  {
    inputs: [
      {
        components: [
          { internalType: 'address', name: 'tokenIn', type: 'address' },
          { internalType: 'address', name: 'tokenOut', type: 'address' },
          { internalType: 'uint256', name: 'amountIn', type: 'uint256' },
          { internalType: 'int24', name: 'tickSpacing', type: 'int24' },
          { internalType: 'uint160', name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
        internalType: 'struct IQuoterV2.QuoteExactInputSingleParams',
        name: 'params',
        type: 'tuple',
      },
    ],
    name: 'quoteExactInputSingle',
    outputs: [
      { internalType: 'uint256', name: 'amountOut', type: 'uint256' },
      { internalType: 'uint160', name: 'sqrtPriceX96After', type: 'uint160' },
      { internalType: 'uint32', name: 'initializedTicksCrossed', type: 'uint32' },
      { internalType: 'uint256', name: 'gasEstimate', type: 'uint256' },
    ],
    stateMutability: 'nonpayable',
    type: 'function',
  },
];

export async function getAerodromeClmmQuote(
  network: string,
  poolAddress: string,
  baseToken: string,
  quoteToken: string,
  amount: number,
  side: 'BUY' | 'SELL',
  slippagePct: number = AerodromeConfig.config.slippagePct,
): Promise<{ quote: QuoteSwapResponseType }> {
  const aerodrome = await Aerodrome.getInstance(network);
  const ethereum = await Ethereum.getInstance(network);

  const poolInfo = await getAerodromePoolInfo(poolAddress, network);
  if (!poolInfo) {
    throw httpErrors.notFound(sanitizeErrorMessage('Pool not found: {}', poolAddress));
  }

  const baseTokenObj = await aerodrome.getTokenBySymbol(baseToken);
  const quoteTokenObj = await aerodrome.getTokenBySymbol(quoteToken);

  if (!baseTokenObj || !quoteTokenObj) {
    throw httpErrors.badRequest('Token not found');
  }

  const tickSpacing = await getTickSpacing(poolAddress, network);
  const contracts = aerodrome.getContracts();

  const exactIn = side === 'SELL';
  const [inputToken, outputToken] = exactIn ? [baseTokenObj, quoteTokenObj] : [quoteTokenObj, baseTokenObj];

  const amountIn = utils.parseUnits(amount.toString(), inputToken.decimals);

  const quoter = new Contract(contracts.quoterV2, QUOTER_V2_ABI, ethereum.provider);

  const result = await quoter.callStatic.quoteExactInputSingle({
    tokenIn: inputToken.address,
    tokenOut: outputToken.address,
    amountIn,
    tickSpacing,
    sqrtPriceLimitX96: 0,
  });

  const amountOut = result.amountOut;
  const outputAmount = formatTokenAmount(amountOut.toString(), outputToken.decimals);

  // Calculate price
  const inputAmount = amount;
  const price = exactIn ? outputAmount / inputAmount : inputAmount / outputAmount;

  // Calculate minimum output with slippage
  const slippageMultiplier = (100 - slippagePct) / 100;
  const minimumOutput = outputAmount * slippageMultiplier;

  const inputAmountFormatted = formatTokenAmount(amountIn.toString(), inputToken.decimals);

  return {
    quote: {
      poolAddress,
      tokenIn: inputToken.address,
      tokenOut: outputToken.address,
      amountIn: inputAmountFormatted,
      amountOut: outputAmount,
      price,
      slippagePct,
      minAmountOut: minimumOutput,
      maxAmountIn: inputAmountFormatted,
      priceImpactPct: 0, // QuoterV2 doesn't return price impact directly
    },
  };
}

export const quoteSwapRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get<{
    Querystring: QuoteSwapRequestType;
    Reply: QuoteSwapResponseType;
  }>(
    '/quote-swap',
    {
      schema: {
        description: 'Get a swap quote from Aerodrome Slipstream',
        tags: ['/connector/aerodrome'],
        querystring: {
          ...QuoteSwapRequest,
          properties: {
            ...QuoteSwapRequest.properties,
            network: { type: 'string', default: 'base' },
            poolAddress: { type: 'string', examples: ['0xb2cc224c1c9fee385f8ad6a55b4d94e92359dc59'] },
          },
        },
        response: { 200: QuoteSwapResponse },
      },
    },
    async (request) => {
      try {
        const { network, baseToken, quoteToken, amount, side, slippagePct } = request.query;
        let { poolAddress } = request.query;

        // Auto-resolve pool address from pool storage if not provided
        if (!poolAddress) {
          const poolService = PoolService.getInstance();
          const pool = await poolService.getPool('aerodrome', network || 'base', 'clmm', baseToken, quoteToken);
          if (pool) {
            poolAddress = pool.address;
            logger.info(`Auto-resolved pool address for ${baseToken}/${quoteToken}: ${poolAddress}`);
          } else {
            throw httpErrors.badRequest(
              `Pool address is required — no registered pool found for ${baseToken}/${quoteToken}`,
            );
          }
        }

        const { quote } = await getAerodromeClmmQuote(
          network,
          poolAddress,
          baseToken,
          quoteToken,
          amount,
          side as 'BUY' | 'SELL',
          slippagePct,
        );
        return quote;
      } catch (e) {
        logger.error(e);
        if (e.statusCode) {
          throw e;
        }
        throw httpErrors.internalServerError('Failed to get swap quote');
      }
    },
  );
};

export default quoteSwapRoute;
