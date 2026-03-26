import { Type, Static } from '@sinclair/typebox';

import { AerodromeConfig } from './aerodrome.config';

// Only Aerodrome-specific schemas go here.
// Standard CLMM schemas are imported from src/schemas/clmm-schema.ts in each route file.

// Constants for swagger examples
const CLMM_POOL_ADDRESS_EXAMPLE = '0xb2cc224c1c9fee385f8ad6a55b4d94e92359dc59';

// CLMM request schemas with Aerodrome-specific defaults
export const AerodromeClmmGetPoolInfoRequest = Type.Object({
  network: Type.Optional(
    Type.String({
      description: 'The EVM network to use',
      default: 'base',
      enum: [...AerodromeConfig.networks],
    }),
  ),
  poolAddress: Type.String({
    description: 'Aerodrome Slipstream pool address',
    examples: [CLMM_POOL_ADDRESS_EXAMPLE],
  }),
});

export const AerodromeClmmAddLiquidityRequest = Type.Object({
  network: Type.Optional(Type.String({ default: 'base', enum: [...AerodromeConfig.networks] })),
  walletAddress: Type.Optional(Type.String()),
  positionAddress: Type.String({ description: 'Position NFT token ID' }),
  baseTokenAmount: Type.Optional(Type.Number()),
  quoteTokenAmount: Type.Optional(Type.Number()),
  slippagePct: Type.Optional(Type.Number({ default: AerodromeConfig.config.slippagePct })),
});

// Claim AERO gauge rewards (Aerodrome-only endpoint)
export const AerodromeClaimRewardsRequest = Type.Object(
  {
    network: Type.Optional(Type.String()),
    walletAddress: Type.Optional(Type.String()),
    tokenId: Type.String({ description: 'Position NFT token ID' }),
    poolAddress: Type.String({ description: 'Pool address for gauge lookup' }),
  },
  { $id: 'AerodromeClaimRewardsRequest' },
);
export type AerodromeClaimRewardsRequestType = Static<typeof AerodromeClaimRewardsRequest>;

export const AerodromeClaimRewardsResponse = Type.Object(
  {
    signature: Type.String(),
    status: Type.Number({ description: 'TransactionStatus enum value' }),
    data: Type.Optional(
      Type.Object({
        fee: Type.Number(),
        aeroAmount: Type.Number(),
      }),
    ),
  },
  { $id: 'AerodromeClaimRewardsResponse' },
);
export type AerodromeClaimRewardsResponseType = Static<typeof AerodromeClaimRewardsResponse>;
