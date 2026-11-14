import fs from 'fs';
import path from 'path';

import {
  ACCOUNT_SIZE,
  AccountLayout,
  AccountState,
  MINT_SIZE,
  MintLayout,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { PublicKey, SystemProgram } from '@solana/web3.js';

// Mock the logger before importing Solana
jest.mock('../../../src/services/logger', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
  redactUrl: jest.fn((url: string) => url),
}));

// Mock config manager
jest.mock('../../../src/services/config-manager-v2', () => ({
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
        return undefined;
      }),
    })),
  },
}));

import { Solana } from '../../../src/chains/solana/solana';

// Real mainnet mint accounts (getMultipleAccounts, base64 + jsonParsed), see fixture `source`.
const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/mint-accounts.json'), 'utf8'));
const T22_MINT = '322es1iMfEghyuqi6Hby3eLkMsbfAKBCacmiZqG8pump'; // Token-2022, metadataPointer + tokenMetadata
const SPL_MINT = '7ocJPuZdemj8xW4bs8ZQzFV8rTGvrao5PLP1rsaUpump'; // SPL Token

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

const account = (owner: PublicKey, data: Buffer) => ({ owner, data, lamports: 1461600, executable: false, rentEpoch: 0 });

const mintData = (decimals: number): Buffer => {
  const data = new Uint8Array(MINT_SIZE);
  MintLayout.encode(
    {
      mintAuthorityOption: 0,
      mintAuthority: PublicKey.default,
      supply: BigInt(1000),
      decimals,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    data,
  );
  return Buffer.from(data);
};

const tokenAccountData = (mint: PublicKey): Buffer => {
  const data = new Uint8Array(ACCOUNT_SIZE);
  AccountLayout.encode(
    {
      mint,
      owner: PublicKey.default,
      amount: BigInt(1),
      delegateOption: 0,
      delegate: PublicKey.default,
      state: AccountState.Initialized,
      isNativeOption: 0,
      isNative: BigInt(0),
      delegatedAmount: BigInt(0),
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    data,
  );
  return Buffer.from(data);
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

describe('Solana.getToken fallback for tokens not in the token list', () => {
  let solana: Solana;
  let getAccountInfo: jest.Mock;

  beforeEach(async () => {
    (Solana as any)._instances = {};
    solana = await Solana.getInstance('mainnet-beta');
    jest.spyOn(solana, 'getTokenList').mockResolvedValue([SOL, USDC]);
    getAccountInfo = jest.fn();
    (solana.connection as any).getAccountInfo = getAccountInfo;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('listed tokens', () => {
    it('returns the listed token by symbol without any RPC call', async () => {
      await expect(solana.getToken('usdc')).resolves.toEqual(USDC);
      expect(getAccountInfo).not.toHaveBeenCalled();
    });

    it('returns the listed token by address without any RPC call', async () => {
      await expect(solana.getToken(USDC.address)).resolves.toEqual(USDC);
      expect(getAccountInfo).not.toHaveBeenCalled();
    });
  });

  describe('unlisted mints owned by a token program', () => {
    it('resolves a Token-2022 mint with extensions using its on-chain decimals', async () => {
      getAccountInfo.mockResolvedValue(fixtureAccount(T22_MINT));

      const token = await solana.getToken(T22_MINT);

      expect(token).toEqual({
        address: T22_MINT,
        symbol: `DUMMY_${T22_MINT.slice(0, 4)}`,
        name: `Dummy Token (${T22_MINT.slice(0, 8)}...)`,
        decimals: fixtures.accounts[T22_MINT].jsonParsedDecimals,
        chainId: 101,
      });
      expect(getAccountInfo).toHaveBeenCalledTimes(1);
      expect(getAccountInfo.mock.calls[0][0].toBase58()).toBe(T22_MINT);
    });

    it('resolves an SPL Token mint using its on-chain decimals', async () => {
      getAccountInfo.mockResolvedValue(fixtureAccount(SPL_MINT));

      const token = await solana.getToken(SPL_MINT);

      expect(token?.decimals).toBe(fixtures.accounts[SPL_MINT].jsonParsedDecimals);
      expect(token?.address).toBe(SPL_MINT);
      expect(getAccountInfo).toHaveBeenCalledTimes(1);
    });

    it('uses the mint decimals as they are (0 decimals, no default)', async () => {
      const mint = new PublicKey(Buffer.alloc(32, 7)).toBase58();
      getAccountInfo.mockResolvedValue(account(TOKEN_2022_PROGRAM_ID, mintData(0)));

      await expect(solana.getToken(mint)).resolves.toMatchObject({ address: mint, decimals: 0 });
    });
  });

  describe('inputs that are not mints', () => {
    it('returns null for a string that is not a public key, without any RPC call', async () => {
      await expect(solana.getToken('NOT_A_TOKEN')).resolves.toBeNull();
      expect(getAccountInfo).not.toHaveBeenCalled();
    });

    it('returns null when the account does not exist', async () => {
      getAccountInfo.mockResolvedValue(null);
      await expect(solana.getToken(T22_MINT)).resolves.toBeNull();
    });

    it('returns null when the account is owned by another program', async () => {
      getAccountInfo.mockResolvedValue(account(SystemProgram.programId, mintData(6)));
      await expect(solana.getToken(T22_MINT)).resolves.toBeNull();
    });

    it('returns null for a token account owned by the SPL Token program', async () => {
      getAccountInfo.mockResolvedValue(account(TOKEN_PROGRAM_ID, tokenAccountData(new PublicKey(SPL_MINT))));
      await expect(solana.getToken(SPL_MINT)).resolves.toBeNull();
    });

    it('returns null for Token-2022 account data that is too short for a mint', async () => {
      getAccountInfo.mockResolvedValue(account(TOKEN_2022_PROGRAM_ID, Buffer.alloc(10)));
      await expect(solana.getToken(T22_MINT)).resolves.toBeNull();
    });
  });

  describe('RPC failures while fetching the account', () => {
    it('propagates a rate limit as a 429 error instead of returning null', async () => {
      getAccountInfo.mockRejectedValue(new Error('429 Too Many Requests'));
      await expect(solana.getToken(T22_MINT)).rejects.toMatchObject({ statusCode: 429 });
    });

    it('propagates a network error instead of returning null', async () => {
      getAccountInfo.mockRejectedValue(new Error('fetch failed'));
      await expect(solana.getToken(T22_MINT)).rejects.toThrow('fetch failed');
    });
  });
});
