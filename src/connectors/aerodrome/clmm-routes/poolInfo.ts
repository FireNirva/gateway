import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import JSBI from 'jsbi';

import { Ethereum } from '../../../chains/ethereum/ethereum';
import { GetPoolInfoRequestType, PoolInfo, PoolInfoSchema } from '../../../schemas/clmm-schema';
import { logger } from '../../../services/logger';
import { sanitizeErrorMessage } from '../../../services/sanitize';
import { Aerodrome } from '../aerodrome';
import {
  getAerodromePoolInfo,
  getSlot0,
  getTickSpacing,
  getDynamicFee,
  getPoolLiquidity,
  formatTokenAmount,
} from '../aerodrome.utils';
import { AerodromeClmmGetPoolInfoRequest } from '../schemas';
import { SlipstreamPool } from '../slipstream-sdk';

export async function getPoolInfo(fastify: FastifyInstance, network: string, poolAddress: string): Promise<PoolInfo> {
  const aerodrome = await Aerodrome.getInstance(network);

  if (!poolAddress) {
    throw fastify.httpErrors.badRequest('Pool address is required');
  }

  // Get pool token addresses
  const poolInfo = await getAerodromePoolInfo(poolAddress, network);
  if (!poolInfo) {
    throw fastify.httpErrors.notFound(sanitizeErrorMessage('Pool not found: {}', poolAddress));
  }

  const baseTokenObj = await aerodrome.getTokenBySymbol(poolInfo.baseTokenAddress);
  const quoteTokenObj = await aerodrome.getTokenBySymbol(poolInfo.quoteTokenAddress);

  if (!baseTokenObj || !quoteTokenObj) {
    throw fastify.httpErrors.badRequest('Token information not found for pool');
  }

  // Read pool state from contract
  const [slot0, tickSpacing, dynamicFee, liquidity] = await Promise.all([
    getSlot0(poolAddress, network),
    getTickSpacing(poolAddress, network),
    getDynamicFee(poolAddress, network),
    getPoolLiquidity(poolAddress, network),
  ]);

  // Build SlipstreamPool for price calculation
  const pool = new SlipstreamPool(
    baseTokenObj,
    quoteTokenObj,
    dynamicFee,
    JSBI.BigInt(slot0.sqrtPriceX96.toString()),
    JSBI.BigInt(liquidity.toString()),
    slot0.tick,
    tickSpacing,
  );

  // Determine token ordering
  const token0 = pool.token0;
  const isBaseToken0 = baseTokenObj.address.toLowerCase() === token0.address.toLowerCase();

  const price0 = pool.token0Price.toSignificant(15);
  const price1 = pool.token1Price.toSignificant(15);
  const price = isBaseToken0 ? parseFloat(price0) : parseFloat(price1);

  // Aerodrome fees are dynamic — read from pool.fee() (in pips)
  const feePct = dynamicFee / 10000;

  const token0Amount = formatTokenAmount(liquidity.toString(), token0.decimals);
  const token1Amount = formatTokenAmount(liquidity.toString(), pool.token1.decimals);
  const baseTokenAmount = isBaseToken0 ? token0Amount : token1Amount;
  const quoteTokenAmount = isBaseToken0 ? token1Amount : token0Amount;

  return {
    address: poolAddress,
    baseTokenAddress: baseTokenObj.address,
    quoteTokenAddress: quoteTokenObj.address,
    binStep: tickSpacing,
    feePct,
    price,
    baseTokenAmount,
    quoteTokenAmount,
    activeBinId: slot0.tick,
  };
}

export const poolInfoRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get<{
    Querystring: GetPoolInfoRequestType;
    Reply: Record<string, any>;
  }>(
    '/pool-info',
    {
      schema: {
        description: 'Get CLMM pool information from Aerodrome Slipstream',
        tags: ['/connector/aerodrome'],
        querystring: AerodromeClmmGetPoolInfoRequest,
        response: { 200: PoolInfoSchema },
      },
    },
    async (request): Promise<PoolInfo> => {
      try {
        const { poolAddress } = request.query;
        const network = request.query.network;
        return await getPoolInfo(fastify, network, poolAddress);
      } catch (e) {
        logger.error(e);
        if (e.statusCode) {
          throw e;
        }
        throw fastify.httpErrors.internalServerError('Failed to fetch pool info');
      }
    },
  );
};

export default poolInfoRoute;
