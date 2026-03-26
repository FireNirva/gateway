/**
 * Aerodrome CLMM test mock data
 * Pool: WETH/USDC 0.05% on Base (Slipstream)
 */

export const MOCK_POOL_ADDRESS = '0xb2cc224c1c9fee385f8ad6a55b4d94e92359dc59';

export const MOCK_WETH = {
  symbol: 'WETH',
  address: '0x4200000000000000000000000000000000000006',
  decimals: 18,
};

export const MOCK_USDC = {
  symbol: 'USDC',
  address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  decimals: 6,
};

export const MOCK_AERO_TOKEN = {
  symbol: 'AERO',
  address: '0x940181a94A35A4569E4529A3CDfB74e38FD98631',
  decimals: 18,
};

export const MOCK_WALLET_ADDRESS = '0x1234567890123456789012345678901234567890';
export const MOCK_TX_HASH = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';

export const MOCK_CONTRACTS = {
  clFactory: '0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A',
  nftPositionManager: '0x827922686190790b37229fd06084350E74485b72',
  swapRouter: '0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5',
  quoterV2: '0x254cF9E1E6e233aa1AC962CB9B05b2cfeAaE15b0',
  aeroToken: '0x940181a94A35A4569E4529A3CDfB74e38FD98631',
  voter: '0x16613524e02ad97eDfeF371bC883F2F5d6C480A5',
};

export const MOCK_GAUGE_ADDRESS = '0x4F09bAb2f0Ec4A0Ba8fD9EAa4150E6F79Fe30EE6';

export const MOCK_POOL_INFO = {
  address: MOCK_POOL_ADDRESS,
  baseTokenAddress: MOCK_WETH.address,
  quoteTokenAddress: MOCK_USDC.address,
  feePct: 0.05,
  price: 2202.75,
  baseTokenAmount: 150.25,
  quoteTokenAmount: 330963.1,
  tickSpacing: 100,
  tick: -202315,
  sqrtPriceX96: '3708917822968360992268288',
  liquidity: '77841025956891277',
};

export const MOCK_POSITION = {
  nonce: 0,
  operator: '0x0000000000000000000000000000000000000000',
  token0: MOCK_WETH.address,
  token1: MOCK_USDC.address,
  tickSpacing: 100,
  tickLower: -202500,
  tickUpper: -202000,
  liquidity: { toString: () => '5000000000000000' },
  feeGrowthInside0LastX128: { toString: () => '0' },
  feeGrowthInside1LastX128: { toString: () => '0' },
  tokensOwed0: { toString: () => '0' },
  tokensOwed1: { toString: () => '0' },
};

export const MOCK_TX_RECEIPT = {
  transactionHash: MOCK_TX_HASH,
  status: 1,
  gasUsed: { mul: (_v: any) => ({ toString: () => '2100000000000000' }) },
  effectiveGasPrice: { toString: () => '1000000000' },
  logs: [
    {
      topics: [
        '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', // Transfer
        '0x0000000000000000000000000000000000000000000000000000000000000000',
        '0x0000000000000000000000001234567890123456789012345678901234567890',
        '0x0000000000000000000000000000000000000000000000000000000000000001', // tokenId = 1
      ],
    },
  ],
};

export const MOCK_PROVIDER = {
  _isProvider: true,
  getNetwork: jest.fn().mockResolvedValue({ chainId: 8453 }),
  call: jest.fn(),
  getBlockNumber: jest.fn().mockResolvedValue(1000000),
  getGasPrice: jest.fn().mockResolvedValue({
    mul: jest.fn().mockReturnValue({ toString: () => '20000000000' }),
    toString: () => '20000000000',
  }),
  resolveName: jest.fn(),
  lookupAddress: jest.fn(),
  emit: jest.fn(),
  listenerCount: jest.fn().mockReturnValue(0),
  listeners: jest.fn().mockReturnValue([]),
  removeAllListeners: jest.fn(),
  addListener: jest.fn(),
  on: jest.fn(),
  once: jest.fn(),
  off: jest.fn(),
  removeListener: jest.fn(),
};

export const MOCK_ETHEREUM_INSTANCE = {
  chainId: 8453,
  getToken: jest.fn(),
  getOrFetchToken: jest.fn(),
  provider: MOCK_PROVIDER,
  ready: jest.fn().mockReturnValue(true),
  init: jest.fn().mockResolvedValue(undefined),
  getWallet: jest.fn(),
  getContract: jest.fn(),
  getERC20Allowance: jest.fn(),
  handleTransactionExecution: jest.fn(),
  prepareGasOptions: jest.fn(),
};

export const MOCK_AERODROME_INSTANCE = {
  getTokenBySymbol: jest.fn(),
  getToken: jest.fn(),
  getContracts: jest.fn().mockReturnValue(MOCK_CONTRACTS),
  getGaugeAddress: jest.fn().mockResolvedValue(MOCK_GAUGE_ADDRESS),
  getGaugeContract: jest.fn(),
  getNftManager: jest.fn(),
  getFactory: jest.fn(),
  getEthereum: jest.fn().mockReturnValue(MOCK_ETHEREUM_INSTANCE),
  getChainId: jest.fn().mockReturnValue(8453),
};
