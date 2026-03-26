import { Token as SdkCoreToken } from '@uniswap/sdk-core';

import { Ethereum } from '../../../../src/chains/ethereum/ethereum';
import { fastifyWithTypeProvider } from '../../../utils/testUtils';
import { MOCK_POOL_ADDRESS, MOCK_POOL_INFO, MOCK_PROVIDER } from '../aerodrome-data.mock';

jest.mock('../../../../src/chains/ethereum/ethereum');
jest.mock('../../../../src/connectors/aerodrome/aerodrome.config', () => ({
  AerodromeConfig: {
    config: { slippagePct: 2, stakeInGauge: true, autoClaimRewards: true },
    networks: ['base'],
    chain: 'ethereum',
    tradingTypes: ['clmm'],
  },
}));
jest.mock('../../../../src/connectors/aerodrome/aerodrome');
jest.mock('../../../../src/connectors/aerodrome/aerodrome.utils');
jest.mock('../../../../src/connectors/aerodrome/slipstream-sdk', () => {
  const actual = jest.requireActual('../../../../src/connectors/aerodrome/slipstream-sdk');
  return {
    ...actual,
    SlipstreamPool: jest.fn().mockImplementation(() => ({
      token0: { address: '0x4200000000000000000000000000000000000006', decimals: 18 },
      token1: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
      token0Price: { toSignificant: () => '2202.75' },
      token1Price: { toSignificant: () => '0.000454' },
      tickCurrent: -202315,
    })),
  };
});

const buildApp = async () => {
  const server = fastifyWithTypeProvider();
  await server.register(require('@fastify/sensible'));

  const { poolInfoRoute } = await import('../../../../src/connectors/aerodrome/clmm-routes/poolInfo');
  await server.register(poolInfoRoute);
  return server;
};

describe('Aerodrome CLMM GET /pool-info', () => {
  let server: any;

  beforeAll(async () => {
    server = await buildApp();
  });

  afterAll(async () => {
    await server.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return pool info for valid pool address', async () => {
    const { Aerodrome } = await import('../../../../src/connectors/aerodrome/aerodrome');
    const { getAerodromePoolInfo, getTickSpacing, getDynamicFee, getSlot0, getPoolLiquidity, formatTokenAmount } =
      await import('../../../../src/connectors/aerodrome/aerodrome.utils');

    const mockEthereumInstance = {
      chainId: 8453,
      provider: MOCK_PROVIDER,
      ready: jest.fn().mockReturnValue(true),
    };
    (Ethereum.getInstance as jest.Mock).mockResolvedValue(mockEthereumInstance);

    // getTokenBySymbol is called with ADDRESS strings (from poolInfo.baseTokenAddress)
    const wethToken = new SdkCoreToken(8453, '0x4200000000000000000000000000000000000006', 18, 'WETH');
    const usdcToken = new SdkCoreToken(8453, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 6, 'USDC');

    const mockAerodrome = {
      getTokenBySymbol: jest.fn().mockImplementation((addressOrSymbol: string) => {
        if (addressOrSymbol.toLowerCase().includes('4200')) return wethToken;
        if (addressOrSymbol.toLowerCase().includes('833589')) return usdcToken;
        return null;
      }),
      getChainId: jest.fn().mockReturnValue(8453),
    };
    (Aerodrome.getInstance as jest.Mock).mockResolvedValue(mockAerodrome);

    (getAerodromePoolInfo as jest.Mock).mockResolvedValue(MOCK_POOL_INFO);
    (getTickSpacing as jest.Mock).mockResolvedValue(1);
    (getDynamicFee as jest.Mock).mockResolvedValue(500);
    (getSlot0 as jest.Mock).mockResolvedValue({
      sqrtPriceX96: '3708917822968360992268288',
      tick: -202315,
      observationIndex: 0,
      observationCardinality: 100,
      observationCardinalityNext: 100,
      unlocked: true,
    });
    (getPoolLiquidity as jest.Mock).mockResolvedValue('77841025956891277');
    (formatTokenAmount as jest.Mock).mockImplementation((amount: string, decimals: number) => {
      return parseFloat(amount) / Math.pow(10, decimals);
    });

    const response = await server.inject({
      method: 'GET',
      url: '/pool-info',
      query: {
        network: 'base',
        poolAddress: MOCK_POOL_ADDRESS,
        baseToken: 'WETH',
        quoteToken: 'USDC',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toHaveProperty('address', MOCK_POOL_ADDRESS);
    expect(body).toHaveProperty('feePct');
  });

  it('should return 404 for invalid pool', async () => {
    const { Aerodrome } = await import('../../../../src/connectors/aerodrome/aerodrome');
    const { getAerodromePoolInfo } = await import('../../../../src/connectors/aerodrome/aerodrome.utils');

    const mockEthereumInstance = {
      chainId: 8453,
      provider: MOCK_PROVIDER,
      ready: jest.fn().mockReturnValue(true),
    };
    (Ethereum.getInstance as jest.Mock).mockResolvedValue(mockEthereumInstance);

    const mockAerodrome = {
      getTokenBySymbol: jest.fn().mockReturnValue(null),
      getChainId: jest.fn().mockReturnValue(8453),
    };
    (Aerodrome.getInstance as jest.Mock).mockResolvedValue(mockAerodrome);

    (getAerodromePoolInfo as jest.Mock).mockResolvedValue(null);

    const response = await server.inject({
      method: 'GET',
      url: '/pool-info',
      query: {
        network: 'base',
        poolAddress: '0x0000000000000000000000000000000000000000',
        baseToken: 'WETH',
        quoteToken: 'USDC',
      },
    });

    expect(response.statusCode).toBe(404);
  });
});
