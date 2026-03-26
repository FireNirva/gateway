import fs from 'fs';
import path from 'path';

import '../../mocks/app-mocks';

import { FastifyInstance } from 'fastify';

import { gatewayApp } from '../../../src/app';

describe('Aerodrome Routes Structure', () => {
  let fastify: FastifyInstance;

  beforeAll(async () => {
    fastify = gatewayApp;
    await fastify.ready();
  });

  afterAll(async () => {
    await fastify.close();
  });

  describe('Folder Structure', () => {
    it('should have clmm-routes folder', () => {
      const aerodromePath = path.join(__dirname, '../../../src/connectors/aerodrome');
      const clmmRoutesPath = path.join(aerodromePath, 'clmm-routes');

      expect(fs.existsSync(clmmRoutesPath)).toBe(true);
    });

    it('should have correct files in clmm-routes folder', () => {
      const clmmRoutesPath = path.join(__dirname, '../../../src/connectors/aerodrome/clmm-routes');
      const files = fs.readdirSync(clmmRoutesPath);

      expect(files).toContain('poolInfo.ts');
      expect(files).toContain('positionInfo.ts');
      expect(files).toContain('positionsOwned.ts');
      expect(files).toContain('quotePosition.ts');
      expect(files).toContain('quoteSwap.ts');
      expect(files).toContain('executeSwap.ts');
      expect(files).toContain('openPosition.ts');
      expect(files).toContain('addLiquidity.ts');
      expect(files).toContain('removeLiquidity.ts');
      expect(files).toContain('collectFees.ts');
      expect(files).toContain('closePosition.ts');
      expect(files).toContain('claimRewards.ts');
      expect(files).toContain('index.ts');
    });
  });

  describe('Route Registration', () => {
    it('should register all Aerodrome CLMM routes', async () => {
      const routes = fastify.printRoutes();

      expect(routes).toContain('aerodrome/');
      expect(routes).toContain('clmm/');
    });
  });

  describe('Config', () => {
    it('should have aerodrome in connectors list', async () => {
      const response = await fastify.inject({
        method: 'GET',
        url: '/config/connectors',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      const aerodromeConnector = body.connectors.find((c: any) => c.name === 'aerodrome');
      expect(aerodromeConnector).toBeDefined();
      expect(aerodromeConnector.trading_types).toContain('clmm');
      expect(aerodromeConnector.chain).toBe('ethereum');
      expect(aerodromeConnector.networks).toContain('base');
    });
  });
});
