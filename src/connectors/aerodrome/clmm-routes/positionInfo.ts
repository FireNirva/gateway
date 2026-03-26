import { Position, tickToPrice } from '@uniswap/v3-sdk';
import { FastifyPluginAsync, FastifyInstance } from 'fastify';
import JSBI from 'jsbi';

import {
  GetPositionInfoRequestType,
  GetPositionInfoRequest,
  PositionInfo,
  PositionInfoSchema,
} from '../../../schemas/clmm-schema';
import { logger } from '../../../services/logger';
import { Aerodrome } from '../aerodrome';
import { getSlot0, getDynamicFee, getPoolLiquidity, formatTokenAmount } from '../aerodrome.utils';
import { SlipstreamPool } from '../slipstream-sdk';

export async function getPositionInfo(
  fastify: FastifyInstance,
  network: string,
  positionAddress: string,
): Promise<PositionInfo> {
  const aerodrome = await Aerodrome.getInstance(network);
  const nftManager = aerodrome.getNftManager();

  if (!positionAddress) {
    throw fastify.httpErrors.badRequest('Position token ID is required');
  }

  // Get position details — Aerodrome positions() returns tickSpacing (not fee)
  const positionDetails = await nftManager.positions(positionAddress);

  const token0Address = positionDetails.token0;
  const token1Address = positionDetails.token1;

  const token0 = await aerodrome.getTokenBySymbol(token0Address);
  const token1 = await aerodrome.getTokenBySymbol(token1Address);

  const tickLower = positionDetails.tickLower;
  const tickUpper = positionDetails.tickUpper;
  const liquidity = positionDetails.liquidity;
  const tickSpacing = positionDetails.tickSpacing; // Aerodrome-specific (not fee)

  const feeAmount0 = formatTokenAmount(positionDetails.tokensOwed0.toString(), token0.decimals);
  const feeAmount1 = formatTokenAmount(positionDetails.tokensOwed1.toString(), token1.decimals);

  // Find pool address using factory.getPool(token0, token1, tickSpacing)
  const factory = aerodrome.getFactory();
  const poolAddress = await factory.getPool(token0Address, token1Address, tickSpacing);

  // Build SlipstreamPool for price calculation
  const [slot0, dynamicFee, poolLiquidity] = await Promise.all([
    getSlot0(poolAddress, network),
    getDynamicFee(poolAddress, network),
    getPoolLiquidity(poolAddress, network),
  ]);

  const pool = new SlipstreamPool(
    token0,
    token1,
    dynamicFee,
    JSBI.BigInt(slot0.sqrtPriceX96.toString()),
    JSBI.BigInt(poolLiquidity.toString()),
    slot0.tick,
    tickSpacing,
  );

  const lowerPrice = tickToPrice(token0, token1, tickLower).toSignificant(6);
  const upperPrice = tickToPrice(token0, token1, tickUpper).toSignificant(6);
  const price = pool.token0Price.toSignificant(6);

  const position = new Position({
    pool,
    tickLower,
    tickUpper,
    liquidity: liquidity.toString(),
  });

  const token0Amount = formatTokenAmount(position.amount0.quotient.toString(), token0.decimals);
  const token1Amount = formatTokenAmount(position.amount1.quotient.toString(), token1.decimals);

  const isBaseToken0 =
    token0.symbol === 'WETH' ||
    (token1.symbol !== 'WETH' && token0.address.toLowerCase() < token1.address.toLowerCase());

  const [baseTokenAddress, quoteTokenAddress] = isBaseToken0
    ? [token0.address, token1.address]
    : [token1.address, token0.address];

  const [baseTokenAmount, quoteTokenAmount] = isBaseToken0
    ? [token0Amount, token1Amount]
    : [token1Amount, token0Amount];

  const [baseFeeAmount, quoteFeeAmount] = isBaseToken0 ? [feeAmount0, feeAmount1] : [feeAmount1, feeAmount0];

  return {
    address: positionAddress,
    poolAddress,
    baseTokenAddress,
    quoteTokenAddress,
    baseTokenAmount,
    quoteTokenAmount,
    baseFeeAmount,
    quoteFeeAmount,
    lowerBinId: tickLower,
    upperBinId: tickUpper,
    lowerPrice: parseFloat(lowerPrice),
    upperPrice: parseFloat(upperPrice),
    price: parseFloat(price),
  };
}

export const positionInfoRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get<{
    Querystring: GetPositionInfoRequestType;
    Reply: PositionInfo;
  }>(
    '/position-info',
    {
      schema: {
        description: 'Get position information for an Aerodrome Slipstream position',
        tags: ['/connector/aerodrome'],
        querystring: {
          ...GetPositionInfoRequest,
          properties: {
            network: { type: 'string', default: 'base' },
            positionAddress: {
              type: 'string',
              description: 'Position NFT token ID',
              examples: ['1234'],
            },
          },
        },
        response: { 200: PositionInfoSchema },
      },
    },
    async (request) => {
      try {
        const { network, positionAddress } = request.query;
        return await getPositionInfo(fastify, network, positionAddress);
      } catch (e) {
        logger.error(e);
        if (e.statusCode) {
          throw e;
        }
        throw fastify.httpErrors.internalServerError('Failed to get position info');
      }
    },
  );
};

export default positionInfoRoute;
