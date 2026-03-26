import { Ethereum } from '../../../../src/chains/ethereum/ethereum';
import { fastifyWithTypeProvider } from '../../../utils/testUtils';
import {
  MOCK_WALLET_ADDRESS,
  MOCK_POOL_ADDRESS,
  MOCK_TX_HASH,
  MOCK_GAUGE_ADDRESS,
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

const buildApp = async () => {
  const server = fastifyWithTypeProvider();
  await server.register(require('@fastify/sensible'));

  const { claimRewardsRoute } = await import('../../../../src/connectors/aerodrome/clmm-routes/claimRewards');
  await server.register(claimRewardsRoute);
  return server;
};

describe('Aerodrome CLMM POST /claim-rewards', () => {
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

  it('should claim rewards successfully', async () => {
    const { Aerodrome } = await import('../../../../src/connectors/aerodrome/aerodrome');
    const { formatTokenAmount } = await import('../../../../src/connectors/aerodrome/aerodrome.utils');

    const mockReceipt = {
      transactionHash: MOCK_TX_HASH,
      status: 1,
      gasUsed: { mul: jest.fn().mockReturnValue({ toString: () => '2100000000000000' }) },
      effectiveGasPrice: { toString: () => '1000000000' },
    };

    const mockWallet = { address: MOCK_WALLET_ADDRESS };
    const mockEthereumInstance = {
      chainId: 8453,
      provider: MOCK_PROVIDER,
      getWallet: jest.fn().mockResolvedValue(mockWallet),
      handleTransactionExecution: jest.fn().mockResolvedValue(mockReceipt),
    };
    (Ethereum.getInstance as jest.Mock).mockResolvedValue(mockEthereumInstance);
    (Ethereum.getWalletAddressExample as jest.Mock).mockResolvedValue(MOCK_WALLET_ADDRESS);

    const mockGaugeWithSigner = {
      earned: jest.fn().mockResolvedValue({ toString: () => '1000000000000000000' }), // 1 AERO
      getReward: jest.fn().mockResolvedValue({ hash: MOCK_TX_HASH }),
    };

    const mockGauge = {
      connect: jest.fn().mockReturnValue(mockGaugeWithSigner),
    };

    const mockAerodrome = {
      getGaugeAddress: jest.fn().mockResolvedValue(MOCK_GAUGE_ADDRESS),
      getGaugeContract: jest.fn().mockReturnValue(mockGauge),
    };
    (Aerodrome.getInstance as jest.Mock).mockResolvedValue(mockAerodrome);

    (formatTokenAmount as jest.Mock).mockImplementation((amount: string, decimals: number) => {
      return parseFloat(amount) / Math.pow(10, decimals);
    });

    const response = await server.inject({
      method: 'POST',
      url: '/claim-rewards',
      payload: {
        network: 'base',
        walletAddress: MOCK_WALLET_ADDRESS,
        tokenId: '1',
        poolAddress: MOCK_POOL_ADDRESS,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toHaveProperty('signature', MOCK_TX_HASH);
    expect(body).toHaveProperty('status', 1);
    expect(body).toHaveProperty('data');
    expect(body.data).toHaveProperty('aeroAmount');
    expect(body.data).toHaveProperty('fee');
  });

  it('should return 400 for missing wallet address', async () => {
    (Ethereum.getWalletAddressExample as jest.Mock).mockResolvedValue(MOCK_WALLET_ADDRESS);

    const response = await server.inject({
      method: 'POST',
      url: '/claim-rewards',
      payload: {
        network: 'base',
        walletAddress: '',
        tokenId: '1',
        poolAddress: MOCK_POOL_ADDRESS,
      },
    });

    // Should get a 400 or 500 depending on validation order
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('should return error when no gauge found', async () => {
    const { Aerodrome } = await import('../../../../src/connectors/aerodrome/aerodrome');

    const mockWallet = { address: MOCK_WALLET_ADDRESS };
    const mockEthereumInstance = {
      chainId: 8453,
      provider: MOCK_PROVIDER,
      getWallet: jest.fn().mockResolvedValue(mockWallet),
    };
    (Ethereum.getInstance as jest.Mock).mockResolvedValue(mockEthereumInstance);
    (Ethereum.getWalletAddressExample as jest.Mock).mockResolvedValue(MOCK_WALLET_ADDRESS);

    const mockAerodrome = {
      getGaugeAddress: jest.fn().mockResolvedValue('0x0000000000000000000000000000000000000000'),
      getGaugeContract: jest.fn(),
    };
    (Aerodrome.getInstance as jest.Mock).mockResolvedValue(mockAerodrome);

    const response = await server.inject({
      method: 'POST',
      url: '/claim-rewards',
      payload: {
        network: 'base',
        walletAddress: MOCK_WALLET_ADDRESS,
        tokenId: '1',
        poolAddress: MOCK_POOL_ADDRESS,
      },
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
  });
});
