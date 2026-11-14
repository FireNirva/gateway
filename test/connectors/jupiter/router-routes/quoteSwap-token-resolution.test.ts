import fs from 'fs';
import path from 'path';

import { PublicKey } from '@solana/web3.js';

// Mock the logger before importing Solana / Jupiter
jest.mock('../../../../src/services/logger', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
  redactUrl: jest.fn((url: string) => url),
}));

jest.mock('../../../../src/services/config-manager-v2', () => ({
  ConfigManagerV2: {
    getInstance: jest.fn(() => ({
      get: jest.fn((key: string) => {
        if (key === 'solana.defaultNetwork') return 'mainnet-beta';
        if (key === 'solana.defaultWallet') return 'test-wallet';
        if (key === 'solana.rpcProvider') return 'url';
        if (key === 'solana-mainnet-beta.nodeURL') return 'https://api.mainnet-beta.solana.com';
        if (key === 'solana-mainnet-beta.nativeCurrencySymbol') return 'SOL';
        if (key === 'solana-mainnet-beta.defaultComputeUnits') return 200000;
        if (key === 'solana-mainnet-beta.confirmRetryInterval') return 2;
        if (key === 'solana-mainnet-beta.confirmRetryCount') return 30;
        if (key === 'solana-mainnet-beta.minPriorityFeePerCU') return 0;
        if (key === 'jupiter.slippagePct') return 1;
        if (key === 'jupiter.priorityLevel') return 'veryHigh';
        if (key === 'jupiter.maxLamports') return 1000000;
        if (key === 'jupiter.onlyDirectRoutes') return false;
        if (key === 'jupiter.restrictIntermediateTokens') return true;
        if (key === 'jupiter.apiKey') return '';
        return undefined;
      }),
    })),
  },
}));

import { Solana } from '../../../../src/chains/solana/solana';
import { Jupiter } from '../../../../src/connectors/jupiter/jupiter';
import { quoteSwapRoute } from '../../../../src/connectors/jupiter/router-routes/quoteSwap';
import { fastifyWithTypeProvider } from '../../../utils/testUtils';

// Real mainnet mint accounts (getMultipleAccounts, base64 + jsonParsed), see fixture `source`.
const fixtures = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../../../chains/solana/fixtures/mint-accounts.json'), 'utf8'),
);
const T22_MINT = '322es1iMfEghyuqi6Hby3eLkMsbfAKBCacmiZqG8pump';
const SPL_MINT = '7ocJPuZdemj8xW4bs8ZQzFV8rTGvrao5PLP1rsaUpump';

const fixtureAccount = (mint: string) => {
  const f = fixtures.accounts[mint];
  return {
    owner: new PublicKey(f.owner),
    data: Buffer.from(f.dataBase64, 'base64'),
    lamports: f.lamports,
    executable: f.executable,
    rentEpoch: f.rentEpoch,
  };
};

const SOL = {
  address: 'So11111111111111111111111111111111111111112',
  symbol: 'SOL',
  name: 'Wrapped SOL',
  decimals: 9,
  chainId: 101,
};
const USDC = {
  address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  symbol: 'USDC',
  name: 'USD Coin',
  decimals: 6,
  chainId: 101,
};

const quote = (outAmount: string) => ({
  inAmount: '1000000',
  outAmount,
  priceImpactPct: '0',
  otherAmountThreshold: '0',
  slippageBps: 200,
  swapMode: 'ExactIn',
  routePlan: [],
  contextSlot: 1,
  timeTaken: 0,
});

const rateLimited = () => new Error('429 Too Many Requests');
const networkError = () => new Error('fetch failed');
const axiosError = (status: number, data?: any) =>
  Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data } });

// Same request shape as the meme-sniper bot shadow c5 quote (SOL -> token, SELL, 0.001 SOL, 2% slippage)
const quoteRequest = (mint: string) => ({
  method: 'GET' as const,
  url: '/quote-swap',
  query: { network: 'mainnet-beta', baseToken: 'SOL', quoteToken: mint, amount: '0.001', side: 'SELL', slippagePct: '2' },
});

describe('GET /quote-swap token resolution (real Solana and Jupiter classes)', () => {
  let server: any;
  let getAccountInfo: jest.Mock;
  let jupiterGet: jest.Mock;

  beforeAll(async () => {
    server = fastifyWithTypeProvider();
    await server.register(require('@fastify/sensible'));
    await server.register(quoteSwapRoute);
  });

  afterAll(async () => {
    await server.close();
  });

  beforeEach(async () => {
    (Solana as any)._instances = {};
    (Jupiter as any)._instances = {};
    const solana = await Solana.getInstance('mainnet-beta');
    jest.spyOn(solana, 'getTokenList').mockResolvedValue([SOL, USDC]);
    getAccountInfo = jest.fn();
    (solana.connection as any).getAccountInfo = getAccountInfo;
    const jupiter = await Jupiter.getInstance('mainnet-beta');
    jupiterGet = jest.fn();
    (jupiter as any).httpClient = { get: jupiterGet };
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const expectNotTokenNotFoundNorNoRoute = (body: any) => {
    expect(body.message).not.toContain('Token not found');
    expect(body.message).not.toContain('No route found');
  };

  it('quotes an unlisted Token-2022 mint with amounts scaled by its on-chain decimals', async () => {
    getAccountInfo.mockResolvedValue(fixtureAccount(T22_MINT));
    jupiterGet.mockResolvedValue({ data: quote('123456789') });

    const response = await server.inject(quoteRequest(T22_MINT));

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.tokenOut).toBe(T22_MINT);
    expect(body.quoteResponse.outAmount).toBe('123456789');
    expect(body.amountOut).toBe(123456789 / 10 ** fixtures.accounts[T22_MINT].jsonParsedDecimals);
  });

  it('returns 400 Token not found when the mint account does not exist', async () => {
    getAccountInfo.mockResolvedValue(null);

    const response = await server.inject(quoteRequest(T22_MINT));

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).message).toContain(`Token not found: ${T22_MINT}`);
    expect(jupiterGet).not.toHaveBeenCalled();
  });

  describe('RPC errors during token resolution', () => {
    it('route-level resolution hits a rate limit => 429', async () => {
      getAccountInfo.mockRejectedValueOnce(rateLimited());

      const response = await server.inject(quoteRequest(SPL_MINT));

      expect(response.statusCode).toBe(429);
      expectNotTokenNotFoundNorNoRoute(JSON.parse(response.body));
      expect(jupiterGet).not.toHaveBeenCalled();
    });

    it('route-level resolution hits a network error => 5xx', async () => {
      getAccountInfo.mockRejectedValueOnce(networkError());

      const response = await server.inject(quoteRequest(SPL_MINT));

      expect(response.statusCode).toBeGreaterThanOrEqual(500);
      expect(response.statusCode).toBeLessThan(600);
      expectNotTokenNotFoundNorNoRoute(JSON.parse(response.body));
      expect(jupiterGet).not.toHaveBeenCalled();
    });

    it('resolution inside getQuote hits a rate limit => 429', async () => {
      getAccountInfo.mockResolvedValueOnce(fixtureAccount(SPL_MINT)).mockRejectedValueOnce(rateLimited());

      const response = await server.inject(quoteRequest(SPL_MINT));

      expect(getAccountInfo).toHaveBeenCalledTimes(2);
      expect(response.statusCode).toBe(429);
      expectNotTokenNotFoundNorNoRoute(JSON.parse(response.body));
      expect(jupiterGet).not.toHaveBeenCalled();
    });

    it('resolution inside getQuote hits a network error => 5xx', async () => {
      getAccountInfo.mockResolvedValueOnce(fixtureAccount(SPL_MINT)).mockRejectedValueOnce(networkError());

      const response = await server.inject(quoteRequest(SPL_MINT));

      expect(getAccountInfo).toHaveBeenCalledTimes(2);
      expect(response.statusCode).toBeGreaterThanOrEqual(500);
      expect(response.statusCode).toBeLessThan(600);
      expectNotTokenNotFoundNorNoRoute(JSON.parse(response.body));
      expect(jupiterGet).not.toHaveBeenCalled();
    });
  });

  describe('Jupiter outcomes after a successful Token-2022 resolution', () => {
    beforeEach(() => {
      getAccountInfo.mockResolvedValue(fixtureAccount(T22_MINT));
    });

    it('no route from Jupiter stays 404 No route found', async () => {
      jupiterGet.mockRejectedValue(
        axiosError(400, { errorCode: 'COULD_NOT_FIND_ANY_ROUTE', error: 'Could not find any route' }),
      );

      const response = await server.inject(quoteRequest(T22_MINT));

      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body.message).toContain('No route found');
      expect(body.message).toContain('No route found for this token pair');
    });

    it('empty Jupiter response stays 404', async () => {
      jupiterGet.mockResolvedValue({ data: '' });

      const response = await server.inject(quoteRequest(T22_MINT));

      expect(response.statusCode).toBe(404);
    });

    it('Jupiter 429 keeps its existing 404 form with the rate-limit text', async () => {
      jupiterGet.mockRejectedValue(axiosError(429));

      const response = await server.inject(quoteRequest(T22_MINT));

      expect(response.statusCode).toBe(404);
      expect(JSON.parse(response.body).message).toContain('Jupiter rate-limited (HTTP 429)');
    });
  });
});
