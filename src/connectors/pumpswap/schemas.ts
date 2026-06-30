import { Type, Static } from '@sinclair/typebox';

import { getSolanaChainConfig } from '../../chains/solana/solana.config';

import { PumpSwapConfig } from './pumpswap.config';

const solanaChainConfig = getSolanaChainConfig();

// Examples: a graduated pump.fun token + its canonical PumpSwap pool.
const BASE_TOKEN_EXAMPLE = '<token-mint-address>';
const QUOTE_TOKEN = 'SOL';
const POOL_ADDRESS_EXAMPLE = '<pumpswap-pool-address>';
const SWAP_AMOUNT = 1000;

export const PumpSwapAmmGetPoolInfoRequest = Type.Object({
  network: Type.Optional(
    Type.String({
      description: 'Solana network to use',
      default: solanaChainConfig.defaultNetwork,
      enum: [...PumpSwapConfig.networks],
    }),
  ),
  poolAddress: Type.String({
    description: 'PumpSwap AMM pool address',
    examples: [POOL_ADDRESS_EXAMPLE],
  }),
});

export const PumpSwapAmmQuoteSwapRequest = Type.Object({
  network: Type.Optional(
    Type.String({
      description: 'Solana network to use',
      default: solanaChainConfig.defaultNetwork,
      enum: [...PumpSwapConfig.networks],
    }),
  ),
  poolAddress: Type.String({
    description: 'PumpSwap AMM pool address (required — no symbol pool lookup)',
    examples: [POOL_ADDRESS_EXAMPLE],
  }),
  baseToken: Type.String({
    description: 'Base token (the graduated mint) symbol or address',
    examples: [BASE_TOKEN_EXAMPLE],
  }),
  quoteToken: Type.Optional(
    Type.String({
      description: 'Quote token — always SOL for pump pools',
      examples: [QUOTE_TOKEN],
    }),
  ),
  amount: Type.Number({
    description: 'Amount to swap (UI units of the input token)',
    examples: [SWAP_AMOUNT],
  }),
  side: Type.String({
    description: 'Trade direction',
    enum: ['BUY', 'SELL'],
    default: 'SELL',
  }),
  slippagePct: Type.Optional(
    Type.Number({
      minimum: 0,
      maximum: 100,
      description: 'Maximum acceptable slippage percentage',
      default: PumpSwapConfig.config.slippagePct,
      examples: [PumpSwapConfig.config.slippagePct],
    }),
  ),
});

export const PumpSwapAmmExecuteSwapRequest = Type.Object({
  walletAddress: Type.Optional(
    Type.String({
      description: 'Solana wallet address that will execute the swap',
      default: solanaChainConfig.defaultWallet,
    }),
  ),
  network: Type.Optional(
    Type.String({
      description: 'Solana network to use',
      default: solanaChainConfig.defaultNetwork,
      enum: [...PumpSwapConfig.networks],
    }),
  ),
  poolAddress: Type.String({
    description: 'PumpSwap AMM pool address (required — recorded by the bot at graduation)',
    examples: [POOL_ADDRESS_EXAMPLE],
  }),
  baseToken: Type.String({
    description: 'Base token (the graduated mint) symbol or address',
    examples: [BASE_TOKEN_EXAMPLE],
  }),
  quoteToken: Type.Optional(
    Type.String({
      description: 'Quote token — always SOL for pump pools',
      examples: [QUOTE_TOKEN],
    }),
  ),
  amount: Type.Number({
    description: 'Amount to swap (UI units: tokens for SELL, SOL for BUY)',
    examples: [SWAP_AMOUNT],
  }),
  side: Type.String({
    description: 'Trade direction',
    enum: ['BUY', 'SELL'],
    default: 'SELL',
    examples: ['SELL'],
  }),
  slippagePct: Type.Optional(
    Type.Number({
      minimum: 0,
      maximum: 100,
      description: 'Maximum acceptable slippage percentage',
      default: PumpSwapConfig.config.slippagePct,
      examples: [PumpSwapConfig.config.slippagePct],
    }),
  ),
});

export type PumpSwapAmmGetPoolInfoRequestType = Static<typeof PumpSwapAmmGetPoolInfoRequest>;
export type PumpSwapAmmQuoteSwapRequestType = Static<typeof PumpSwapAmmQuoteSwapRequest>;
export type PumpSwapAmmExecuteSwapRequestType = Static<typeof PumpSwapAmmExecuteSwapRequest>;
