/**
 * Replay of stored mainnet mint accounts through GET /quote-swap (real Solana and Jupiter classes;
 * the Connection returns the stored accounts and Jupiter returns one fixed successful quote).
 *
 * Skipped unless GATEWAY_REPLAY_ACCOUNTS_DIR points at a directory with `index.json` and the raw
 * getMultipleAccounts responses it lists (encoding base64 for the accounts, jsonParsed for the
 * reference decimals). Optional: GATEWAY_REPLAY_OUT (per-mint readings JSON), GATEWAY_REPLAY_EXPECT
 * ('candidate' (default): every present mint resolves with the jsonParsed decimals; 'baseline':
 * Token-2022 mints get 400 Token not found, SPL Token mints resolve).
 */
import fs from 'fs';
import path from 'path';

import { unpackMint } from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';

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
        if (key === 'jupiter.slippagePct') return 1;
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

const REPLAY_DIR = process.env.GATEWAY_REPLAY_ACCOUNTS_DIR;
const REPLAY_OUT = process.env.GATEWAY_REPLAY_OUT;
const REPLAY_EXPECT = process.env.GATEWAY_REPLAY_EXPECT || 'candidate';

const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const SPL_TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const FIXED_OUT_AMOUNT = '123456789';

const SOL = {
  address: 'So11111111111111111111111111111111111111112',
  symbol: 'SOL',
  name: 'Wrapped SOL',
  decimals: 9,
  chainId: 101,
};

const loadReplay = (dir: string) => {
  const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  const accounts: Record<string, any> = {};
  const parsed: Record<string, any> = {};
  for (const call of index.calls) {
    if (!call.response_file || call.http_status !== 200) continue;
    const value = JSON.parse(fs.readFileSync(path.join(dir, call.response_file), 'utf8')).result.value;
    call.keys.forEach((mint: string, i: number) => {
      if (call.params.encoding === 'base64') accounts[mint] = value[i];
      if (call.params.encoding === 'jsonParsed') parsed[mint] = value[i];
    });
  }
  return { mints: index.mints as string[], accounts, parsed };
};

const toAccountInfo = (v: any) =>
  v && {
    owner: new PublicKey(v.owner),
    data: Buffer.from(v.data[0], 'base64'),
    lamports: v.lamports,
    executable: v.executable,
    rentEpoch: v.rentEpoch,
  };

(REPLAY_DIR ? describe : describe.skip)('GET /quote-swap replay of stored mint accounts', () => {
  it(`every stored mint gets the ${REPLAY_EXPECT} outcome`, async () => {
    const { mints, accounts, parsed } = loadReplay(REPLAY_DIR as string);

    (Solana as any)._instances = {};
    (Jupiter as any)._instances = {};
    const solana = await Solana.getInstance('mainnet-beta');
    jest.spyOn(solana, 'getTokenList').mockResolvedValue([SOL]);
    (solana.connection as any).getAccountInfo = jest.fn(async (pk: PublicKey) => toAccountInfo(accounts[pk.toBase58()]));
    const resolved: Record<string, any> = {};
    const getToken = solana.getToken.bind(solana);
    jest.spyOn(solana, 'getToken').mockImplementation(async (x: string) => {
      const token = await getToken(x);
      if (!(x in resolved)) resolved[x] = token;
      return token;
    });
    const jupiter = await Jupiter.getInstance('mainnet-beta');
    (jupiter as any).httpClient = {
      get: jest.fn().mockResolvedValue({
        data: {
          inAmount: '1000000',
          outAmount: FIXED_OUT_AMOUNT,
          priceImpactPct: '0',
          otherAmountThreshold: '0',
          slippageBps: 200,
          swapMode: 'ExactIn',
          routePlan: [],
          contextSlot: 1,
          timeTaken: 0,
        },
      }),
    };

    const server = fastifyWithTypeProvider();
    await server.register(require('@fastify/sensible'));
    await server.register(quoteSwapRoute);

    const rows = [];
    for (const mint of mints) {
      const response = await server.inject({
        method: 'GET',
        url: '/quote-swap',
        query: {
          network: 'mainnet-beta',
          baseToken: 'SOL',
          quoteToken: mint,
          amount: '0.001',
          side: 'SELL',
          slippagePct: '2',
        },
      });
      const body = JSON.parse(response.body);
      const account = accounts[mint];
      const info = parsed[mint]?.data?.parsed?.info;
      let unpackError = null;
      if (account && response.statusCode !== 200) {
        try {
          unpackMint(new PublicKey(mint), toAccountInfo(account), new PublicKey(account.owner));
        } catch (e) {
          unpackError = e.name || String(e);
        }
      }
      rows.push({
        mint,
        owner: account ? account.owner : null,
        accountPresent: Boolean(account),
        dataLength: account ? Buffer.from(account.data[0], 'base64').length : null,
        httpStatus: response.statusCode,
        message: response.statusCode === 200 ? null : body.message,
        resolvedDecimals: resolved[mint] ? resolved[mint].decimals : null,
        jsonParsedDecimals: info ? info.decimals : null,
        amountOut: response.statusCode === 200 ? body.amountOut : null,
        jsonParsedExtensions: info && info.extensions ? info.extensions.map((e: any) => e.extension) : [],
        transferFeeBps: (info?.extensions || [])
          .filter((e: any) => e.extension === 'transferFeeConfig')
          .map((e: any) => [e.state.olderTransferFee.transferFeeBasisPoints, e.state.newerTransferFee.transferFeeBasisPoints]),
        unpackError,
      });
    }
    await server.close();

    const tnf = (r: any) => r.httpStatus === 400 && String(r.message).includes(`Token not found: ${r.mint}`);
    const resolvesWithChainDecimals = (r: any) =>
      r.httpStatus === 200 && r.resolvedDecimals !== null && r.resolvedDecimals === r.jsonParsedDecimals;
    const expected = (r: any) => {
      if (!r.accountPresent) return tnf(r);
      if (REPLAY_EXPECT === 'baseline') {
        return r.owner === TOKEN_2022 ? tnf(r) : r.owner === SPL_TOKEN ? resolvesWithChainDecimals(r) : false;
      }
      return resolvesWithChainDecimals(r);
    };
    const count = (xs: any[]) => xs.reduce((m, x) => ({ ...m, [x]: (m[x] || 0) + 1 }), {} as Record<string, number>);
    const t22 = rows.filter((r) => r.owner === TOKEN_2022);
    const summary = {
      expect: REPLAY_EXPECT,
      mints: rows.length,
      accountMissing: rows.filter((r) => !r.accountPresent).length,
      statusByOwner: {
        token2022: count(t22.map((r) => r.httpStatus)),
        splToken: count(rows.filter((r) => r.owner === SPL_TOKEN).map((r) => r.httpStatus)),
        other: count(rows.filter((r) => r.accountPresent && r.owner !== TOKEN_2022 && r.owner !== SPL_TOKEN).map((r) => r.httpStatus)),
      },
      decimalsMismatch: rows.filter((r) => r.httpStatus === 200 && r.resolvedDecimals !== r.jsonParsedDecimals).length,
      unpackErrors: count(rows.filter((r) => r.unpackError).map((r) => r.unpackError)),
      token2022Extensions: count(t22.flatMap((r) => r.jsonParsedExtensions)),
      token2022TransferFeeConfig: t22.filter((r) => r.transferFeeBps.length > 0).length,
      token2022TransferFeeNonZero: t22.filter((r) => r.transferFeeBps.some((p: number[]) => p.some((b) => b > 0))).length,
      unexpected: rows.filter((r) => !expected(r)).map((r) => r.mint),
    };
    if (REPLAY_OUT) {
      fs.writeFileSync(REPLAY_OUT, JSON.stringify({ summary, rows }, null, 1));
    }

    expect(summary.unexpected).toEqual([]);
  }, 300000);
});
