import sensible from '@fastify/sensible';
import { FastifyPluginAsync } from 'fastify';

import { logger } from '../../services/logger';

import { aerodromeClmmRoutes } from './clmm-routes';

// CLMM routes (Aerodrome Slipstream) — @fastify/sensible registered here for all route handlers
const aerodromeClmmRoutesWrapper: FastifyPluginAsync = async (fastify) => {
  await fastify.register(sensible);

  await fastify.register(async (instance) => {
    // Log all incoming Aerodrome requests for debugging
    instance.addHook('onRequest', async (request) => {
      logger.info(
        `[AERODROME] ${request.method} ${request.url} query=${JSON.stringify(request.query)} body=${JSON.stringify(request.body)}`,
      );
    });

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
