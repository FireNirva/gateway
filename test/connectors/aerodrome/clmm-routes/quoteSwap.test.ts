import { Ethereum } from '../../../../src/chains/ethereum/ethereum';
import { fastifyWithTypeProvider } from '../../../utils/testUtils';
import {
  MOCK_WETH,
  MOCK_USDC,
  MOCK_POOL_ADDRESS,
  MOCK_POOL_INFO,
  MOCK_CONTRACTS,
  MOCK_PROVIDER,
} from '../aerodrome-data.mock';

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

jest.mock('@ethersproject/contracts', () => {
  const actual = jest.requireActual('@ethersproject/contracts');
  return {
    ...actual,
    Contract: jest.fn(),
  };
});

const buildApp = async () => {
  const server = fastifyWithTypeProvider();
  await server.register(require('@fastify/sensible'));

  const { quoteSwapRoute } = await import('../../../../src/connectors/aerodrome/clmm-routes/quoteSwap');
  await server.register(quoteSwapRoute);
  return server;
};

describe('Aerodrome CLMM GET /quote-swap', () => {
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

  it('should return a quote for SELL side', async () => {
    const { Aerodrome } = await import('../../../../src/connectors/aerodrome/aerodrome');
    const { getAerodromePoolInfo, getTickSpacing, formatTokenAmount } = await import(
      '../../../../src/connectors/aerodrome/aerodrome.utils'
    );
    const { Contract } = require('@ethersproject/contracts');

    const mockEthereumInstance = {
      chainId: 8453,
      provider: MOCK_PROVIDER,
      ready: jest.fn().mockReturnValue(true),
    };
    (Ethereum.getInstance as jest.Mock).mockResolvedValue(mockEthereumInstance);

    const mockAerodrome = {
      getTokenBySymbol: jest.fn().mockImplementation((symbol: string) => {
        if (symbol === 'WETH') return MOCK_WETH;
        if (symbol === 'USDC') return MOCK_USDC;
        return null;
      }),
      getContracts: jest.fn().mockReturnValue(MOCK_CONTRACTS),
    };
    (Aerodrome.getInstance as jest.Mock).mockResolvedValue(mockAerodrome);

    (getAerodromePoolInfo as jest.Mock).mockResolvedValue(MOCK_POOL_INFO);
    (getTickSpacing as jest.Mock).mockResolvedValue(1);
    (formatTokenAmount as jest.Mock).mockImplementation((amount: string, decimals: number) => {
      return parseFloat(amount) / Math.pow(10, decimals);
    });

    // Mock QuoterV2
    Contract.mockImplementation(() => ({
      callStatic: {
        quoteExactInputSingle: jest.fn().mockResolvedValue({
          amountOut: { toString: () => '2202750000' },
          sqrtPriceX96After: { toString: () => '0' },
          initializedTicksCrossed: 1,
          gasEstimate: { toNumber: () => 180000 },
        }),
      },
    }));

    const response = await server.inject({
      method: 'GET',
      url: '/quote-swap',
      query: {
        network: 'base',
        poolAddress: MOCK_POOL_ADDRESS,
        baseToken: 'WETH',
        quoteToken: 'USDC',
        amount: '1.0',
        side: 'SELL',
        slippagePct: '2',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toHaveProperty('poolAddress', MOCK_POOL_ADDRESS);
    expect(body).toHaveProperty('tokenIn', MOCK_WETH.address);
    expect(body).toHaveProperty('tokenOut', MOCK_USDC.address);
    expect(body).toHaveProperty('amountIn');
    expect(body).toHaveProperty('amountOut');
    expect(body).toHaveProperty('price');
    expect(body).toHaveProperty('minAmountOut');
    expect(body).toHaveProperty('slippagePct', 2);
  });

  it('should return 400 for unknown token', async () => {
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
      getContracts: jest.fn().mockReturnValue(MOCK_CONTRACTS),
    };
    (Aerodrome.getInstance as jest.Mock).mockResolvedValue(mockAerodrome);

    (getAerodromePoolInfo as jest.Mock).mockResolvedValue(MOCK_POOL_INFO);

    const response = await server.inject({
      method: 'GET',
      url: '/quote-swap',
      query: {
        network: 'base',
        poolAddress: MOCK_POOL_ADDRESS,
        baseToken: 'INVALID',
        quoteToken: 'USDC',
        amount: '1.0',
        side: 'SELL',
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it('should return 404 for pool not found', async () => {
    const { Aerodrome } = await import('../../../../src/connectors/aerodrome/aerodrome');
    const { getAerodromePoolInfo } = await import('../../../../src/connectors/aerodrome/aerodrome.utils');

    const mockEthereumInstance = {
      chainId: 8453,
      provider: MOCK_PROVIDER,
      ready: jest.fn().mockReturnValue(true),
    };
    (Ethereum.getInstance as jest.Mock).mockResolvedValue(mockEthereumInstance);

    const mockAerodrome = {
      getTokenBySymbol: jest.fn().mockReturnValue(MOCK_WETH),
      getContracts: jest.fn().mockReturnValue(MOCK_CONTRACTS),
    };
    (Aerodrome.getInstance as jest.Mock).mockResolvedValue(mockAerodrome);

    (getAerodromePoolInfo as jest.Mock).mockResolvedValue(null);

    const response = await server.inject({
      method: 'GET',
      url: '/quote-swap',
      query: {
        network: 'base',
        poolAddress: '0x0000000000000000000000000000000000000000',
        baseToken: 'WETH',
        quoteToken: 'USDC',
        amount: '1.0',
        side: 'SELL',
      },
    });

    expect(response.statusCode).toBe(404);
  });
});
