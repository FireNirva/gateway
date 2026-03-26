import sensible from '@fastify/sensible';
import { FastifyPluginAsync } from 'fastify';

import { aerodromeClmmRoutes } from './clmm-routes';

// CLMM routes (Aerodrome Slipstream) — @fastify/sensible registered here for all route handlers
const aerodromeClmmRoutesWrapper: FastifyPluginAsync = async (fastify) => {
  await fastify.register(sensible);

  await fastify.register(async (instance) => {
    instance.addHook('onRoute', (routeOptions) => {
      if (routeOptions.schema && routeOptions.schema.tags) {
        routeOptions.schema.tags = ['/connector/aerodrome'];
      }
    });

    await instance.register(aerodromeClmmRoutes);
  });
};

// Aerodrome only supports CLMM (Slipstream)
export const aerodromeRoutes = {
  clmm: aerodromeClmmRoutesWrapper,
};

export default aerodromeRoutes;
