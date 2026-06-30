import { FastifyPluginAsync } from 'fastify';

import { Solana } from '../../../chains/solana/solana';
import { PoolInfo, PoolInfoSchema } from '../../../schemas/amm-schema';
import { httpErrors } from '../../../services/error-handler';
import { logger } from '../../../services/logger';
import { sanitizeErrorMessage } from '../../../services/sanitize';
import { PumpSwap } from '../pumpswap';
import { PumpSwapAmmGetPoolInfoRequest, PumpSwapAmmGetPoolInfoRequestType } from '../schemas';

export const poolInfoRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get<{
    Querystring: PumpSwapAmmGetPoolInfoRequestType;
    Reply: PoolInfo;
  }>(
    '/pool-info',
    {
      schema: {
        description: 'Get PumpSwap (pump.fun) AMM pool reserves, price and fee',
        tags: ['/connector/pumpswap'],
        querystring: PumpSwapAmmGetPoolInfoRequest,
        response: { 200: PoolInfoSchema },
      },
    },
    async (request) => {
      try {
        const { network, poolAddress } = request.query;
        await Solana.getInstance(network);
        const pumpswap = await PumpSwap.getInstance(network);
        const poolInfo = await pumpswap.getAmmPoolInfo(poolAddress);
        if (!poolInfo) {
          throw httpErrors.notFound(sanitizeErrorMessage('Pool not found: {}', poolAddress));
        }
        return poolInfo;
      } catch (e) {
        logger.error(e);
        if (e.statusCode) throw e;
        throw httpErrors.internalServerError('Failed to fetch PumpSwap pool info');
      }
    },
  );
};

export default poolInfoRoute;
