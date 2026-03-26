import { FastifyPluginAsync } from 'fastify';

import { Ethereum } from '../../../chains/ethereum/ethereum';
import { httpErrors } from '../../../services/error-handler';
import { logger } from '../../../services/logger';
import { Aerodrome } from '../aerodrome';
import { formatTokenAmount } from '../aerodrome.utils';
import {
  AerodromeClaimRewardsRequest,
  AerodromeClaimRewardsRequestType,
  AerodromeClaimRewardsResponse,
  AerodromeClaimRewardsResponseType,
} from '../schemas';

export async function claimRewards(
  network: string,
  walletAddress: string,
  tokenId: string,
  poolAddress: string,
): Promise<AerodromeClaimRewardsResponseType> {
  if (!tokenId || !poolAddress) {
    throw httpErrors.badRequest('Missing required parameters');
  }

  const aerodrome = await Aerodrome.getInstance(network);
  const ethereum = await Ethereum.getInstance(network);

  const wallet = await ethereum.getWallet(walletAddress);
  if (!wallet) {
    throw httpErrors.badRequest('Wallet not found');
  }

  // Get gauge address from pool
  const gaugeAddress = await aerodrome.getGaugeAddress(poolAddress);
  if (!gaugeAddress || gaugeAddress === '0x0000000000000000000000000000000000000000') {
    throw httpErrors.notFound('No gauge found for this pool');
  }

  const gauge = aerodrome.getGaugeContract(gaugeAddress);
  const gaugeWithSigner = gauge.connect(wallet);

  // Check earned rewards before claiming
  const earnedBefore = await gaugeWithSigner.earned(tokenId);

  // Claim AERO rewards
  const tx = await gaugeWithSigner.getReward(tokenId);
  const receipt = await ethereum.handleTransactionExecution(tx);

  const gasFee = formatTokenAmount(receipt.gasUsed.mul(receipt.effectiveGasPrice).toString(), 18);
  const aeroAmount = formatTokenAmount(earnedBefore.toString(), 18); // AERO has 18 decimals

  return {
    signature: receipt.transactionHash,
    status: receipt.status,
    data: {
      fee: gasFee,
      aeroAmount,
    },
  };
}

export const claimRewardsRoute: FastifyPluginAsync = async (fastify) => {
  const walletAddressExample = await Ethereum.getWalletAddressExample();

  fastify.post<{
    Body: AerodromeClaimRewardsRequestType;
    Reply: AerodromeClaimRewardsResponseType;
  }>(
    '/claim-rewards',
    {
      schema: {
        description: 'Claim AERO gauge rewards for a staked position (Aerodrome-specific)',
        tags: ['/connector/aerodrome'],
        body: {
          ...AerodromeClaimRewardsRequest,
          properties: {
            ...AerodromeClaimRewardsRequest.properties,
            network: { type: 'string', default: 'base' },
            walletAddress: { type: 'string', examples: [walletAddressExample] },
            tokenId: { type: 'string', examples: ['1234'] },
            poolAddress: { type: 'string', examples: ['0xb2cc224c1c9fee385f8ad6a55b4d94e92359dc59'] },
          },
        },
        response: { 200: AerodromeClaimRewardsResponse },
      },
    },
    async (request) => {
      try {
        const { network, walletAddress, tokenId, poolAddress } = request.body;

        if (!walletAddress) {
          throw httpErrors.badRequest('Wallet address is required');
        }

        return await claimRewards(network, walletAddress, tokenId, poolAddress);
      } catch (e: any) {
        logger.error('Failed to claim rewards:', e);
        if (e.statusCode) {
          throw e;
        }
        throw httpErrors.internalServerError('Failed to claim rewards');
      }
    },
  );
};

export default claimRewardsRoute;
