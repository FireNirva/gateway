import { FastifyPluginAsync } from 'fastify';

import { executeSwapRoute } from './executeSwap';
import { poolInfoRoute } from './poolInfo';
import { quoteSwapRoute } from './quoteSwap';

export const pumpswapAmmRoutes: FastifyPluginAsync = async (fastify) => {
  await fastify.register(poolInfoRoute);
  await fastify.register(quoteSwapRoute);
  await fastify.register(executeSwapRoute);
};

export default pumpswapAmmRoutes;
