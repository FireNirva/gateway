import sensible from '@fastify/sensible';
import type { FastifyPluginAsync } from 'fastify';

import { pumpswapAmmRoutes } from './amm-routes';

// AMM routes (swap endpoints) tagged under the pumpswap connector group.
const pumpswapAmmRoutesWrapper: FastifyPluginAsync = async (fastify) => {
  await fastify.register(sensible);

  await fastify.register(async (instance) => {
    instance.addHook('onRoute', (routeOptions) => {
      if (routeOptions.schema && routeOptions.schema.tags) {
        routeOptions.schema.tags = ['/connector/pumpswap'];
      }
    });

    await instance.register(pumpswapAmmRoutes);
  });
};

export const pumpswapRoutes = {
  amm: pumpswapAmmRoutesWrapper,
};
