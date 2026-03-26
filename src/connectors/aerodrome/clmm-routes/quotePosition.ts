import { Position, nearestUsableTick } from '@uniswap/v3-sdk';
import { FastifyPluginAsync } from 'fastify';
import JSBI from 'jsbi';

import {
  QuotePositionRequestType,
  QuotePositionRequest,
  QuotePositionResponseType,
  QuotePositionResponse,
} from '../../../schemas/clmm-schema';
import { httpErrors } from '../../../services/error-handler';
import { logger } from '../../../services/logger';
import { sanitizeErrorMessage } from '../../../services/sanitize';
import { Aerodrome } from '../aerodrome';
import { getAerodromePoolInfo, getSlot0, getTickSpacing, getDynamicFee, getPoolLiquidity } from '../aerodrome.utils';
import { SlipstreamPool } from '../slipstream-sdk';

const POOL_ADDRESS_EXAMPLE = '0xb2cc224c1c9fee385f8ad6a55b4d94e92359dc59';

export async function quotePosition(
  network: string,
  lowerPrice: number,
  upperPrice: number,
  poolAddress: string,
  baseTokenAmount?: number,
  quoteTokenAmount?: number,
): Promise<QuotePositionResponseType> {
  if (!lowerPrice || !upperPrice || !poolAddress || (baseTokenAmount === undefined && quoteTokenAmount === undefined)) {
    throw httpErrors.badRequest('Missing required parameters');
  }

  const aerodrome = await Aerodrome.getInstance(network);

  const poolInfo = await getAerodromePoolInfo(poolAddress, network);
  if (!poolInfo) {
    throw httpErrors.notFound(sanitizeErrorMessage('Pool not found: {}', poolAddress));
  }

  const baseTokenObj = await aerodrome.getTokenBySymbol(poolInfo.baseTokenAddress);
  const quoteTokenObj = await aerodrome.getTokenBySymbol(poolInfo.quoteTokenAddress);

  if (!baseTokenObj || !quoteTokenObj) {
    throw httpErrors.badRequest('Token information not found for pool');
  }

  const [slot0, tickSpacing, dynamicFee, liquidity] = await Promise.all([
    getSlot0(poolAddress, network),
    getTickSpacing(poolAddress, network),
    getDynamicFee(poolAddress, network),
    getPoolLiquidity(poolAddress, network),
  ]);

  const pool = new SlipstreamPool(
    baseTokenObj,
    quoteTokenObj,
    dynamicFee,
    JSBI.BigInt(slot0.sqrtPriceX96.toString()),
    JSBI.BigInt(liquidity.toString()),
    slot0.tick,
    tickSpacing,
  );

  const token0 = pool.token0;
  const token1 = pool.token1;
  const isBaseToken0 = baseTokenObj.address.toLowerCase() === token0.address.toLowerCase();

  // Convert human prices to ticks accounting for decimals
  const priceToTickWithDecimals = (humanPrice: number): number => {
    const rawPrice = humanPrice * Math.pow(10, token1.decimals - token0.decimals);
    return Math.floor(Math.log(rawPrice) / Math.log(1.0001));
  };

  let lowerTick = priceToTickWithDecimals(lowerPrice);
  let upperTick = priceToTickWithDecimals(upperPrice);

  // Align to tick spacing
  lowerTick = nearestUsableTick(lowerTick, tickSpacing);
  upperTick = nearestUsableTick(upperTick, tickSpacing);

  if (lowerTick >= upperTick) {
    throw httpErrors.badRequest('Lower price must be less than upper price');
  }

  let position: Position;
  let baseLimited = false;

  if (baseTokenAmount !== undefined && quoteTokenAmount !== undefined) {
    const baseAmountRaw = JSBI.BigInt(Math.floor(baseTokenAmount * Math.pow(10, baseTokenObj.decimals)).toString());
    const quoteAmountRaw = JSBI.BigInt(Math.floor(quoteTokenAmount * Math.pow(10, quoteTokenObj.decimals)).toString());

    if (isBaseToken0) {
      position = Position.fromAmounts({
        pool,
        tickLower: lowerTick,
        tickUpper: upperTick,
        amount0: baseAmountRaw,
        amount1: quoteAmountRaw,
        useFullPrecision: true,
      });
    } else {
      position = Position.fromAmounts({
        pool,
        tickLower: lowerTick,
        tickUpper: upperTick,
        amount0: quoteAmountRaw,
        amount1: baseAmountRaw,
        useFullPrecision: true,
      });
    }

    const baseRequired = isBaseToken0 ? position.amount0 : position.amount1;
    const quoteRequired = isBaseToken0 ? position.amount1 : position.amount0;
    const baseRatio = parseFloat(baseAmountRaw.toString()) / parseFloat(baseRequired.quotient.toString());
    const quoteRatio = parseFloat(quoteAmountRaw.toString()) / parseFloat(quoteRequired.quotient.toString());
    baseLimited = baseRatio <= quoteRatio;
  } else if (baseTokenAmount !== undefined) {
    const baseAmountRaw = JSBI.BigInt(Math.floor(baseTokenAmount * Math.pow(10, baseTokenObj.decimals)).toString());
    if (isBaseToken0) {
      position = Position.fromAmount0({
        pool,
        tickLower: lowerTick,
        tickUpper: upperTick,
        amount0: baseAmountRaw,
        useFullPrecision: true,
      });
    } else {
      position = Position.fromAmount1({ pool, tickLower: lowerTick, tickUpper: upperTick, amount1: baseAmountRaw });
    }
    baseLimited = true;
  } else if (quoteTokenAmount !== undefined) {
    const quoteAmountRaw = JSBI.BigInt(Math.floor(quoteTokenAmount * Math.pow(10, quoteTokenObj.decimals)).toString());
    if (isBaseToken0) {
      position = Position.fromAmount1({ pool, tickLower: lowerTick, tickUpper: upperTick, amount1: quoteAmountRaw });
    } else {
      position = Position.fromAmount0({
        pool,
        tickLower: lowerTick,
        tickUpper: upperTick,
        amount0: quoteAmountRaw,
        useFullPrecision: true,
      });
    }
    baseLimited = false;
  } else {
    throw httpErrors.badRequest('Either base or quote token amount must be provided');
  }

  const actualToken0Amount = position.amount0;
  const actualToken1Amount = position.amount1;

  const actualBaseAmount = isBaseToken0
    ? parseFloat(actualToken0Amount.toSignificant(18))
    : parseFloat(actualToken1Amount.toSignificant(18));
  const actualQuoteAmount = isBaseToken0
    ? parseFloat(actualToken1Amount.toSignificant(18))
    : parseFloat(actualToken0Amount.toSignificant(18));

  return {
    baseLimited,
    baseTokenAmount: actualBaseAmount,
    quoteTokenAmount: actualQuoteAmount,
    baseTokenAmountMax: baseTokenAmount || actualBaseAmount,
    quoteTokenAmountMax: quoteTokenAmount || actualQuoteAmount,
    liquidity: position.liquidity.toString(),
  };
}

export const quotePositionRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get<{
    Querystring: QuotePositionRequestType;
    Reply: QuotePositionResponseType;
  }>(
    '/quote-position',
    {
      schema: {
        description: 'Get a quote for opening a position on Aerodrome Slipstream',
        tags: ['/connector/aerodrome'],
        querystring: {
          ...QuotePositionRequest,
          properties: {
            ...QuotePositionRequest.properties,
            network: { type: 'string', default: 'base', examples: ['base'] },
            poolAddress: { type: 'string', examples: [POOL_ADDRESS_EXAMPLE] },
            lowerPrice: { type: 'number', examples: [2000] },
            upperPrice: { type: 'number', examples: [4000] },
            baseTokenAmount: { type: 'number', examples: [0.001] },
            quoteTokenAmount: { type: 'number', examples: [3] },
          },
        },
        response: { 200: QuotePositionResponse },
      },
    },
    async (request) => {
      try {
        const { network, lowerPrice, upperPrice, poolAddress, baseTokenAmount, quoteTokenAmount } = request.query;
        return await quotePosition(network, lowerPrice, upperPrice, poolAddress, baseTokenAmount, quoteTokenAmount);
      } catch (e) {
        logger.error(e);
        if (e.statusCode) {
          throw e;
        }
        throw httpErrors.internalServerError('Failed to quote position');
      }
    },
  );
};

export default quotePositionRoute;
