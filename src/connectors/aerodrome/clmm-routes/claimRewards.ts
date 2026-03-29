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

const CLAIM_REWARDS_GAS_LIMIT = 300000;

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

  // Check earned rewards before claiming (may revert for freshly staked positions)
  let earnedBefore;
  try {
    earnedBefore = await gaugeWithSigner.earned(tokenId);
  } catch (err) {
    logger.info(`earned() reverted for position ${tokenId} (likely freshly staked, no epoch data yet)`);
    return {
      signature: '',
      status: 1,
      data: {
        fee: 0,
        aeroAmount: 0,
      },
    };
  }

  const aeroAmount = formatTokenAmount(earnedBefore.toString(), 18); // AERO has 18 decimals

  // Skip if no rewards to claim
  if (earnedBefore.isZero()) {
    logger.info(`No rewards to claim for position ${tokenId}`);
    return {
      signature: '',
      status: 1,
      data: {
        fee: 0,
        aeroAmount: 0,
      },
    };
  }

  // Dynamic gas estimation with fallback
  let gasLimit: number;
  try {
    const estimated = await gaugeWithSigner.estimateGas.getReward(tokenId);
    gasLimit = Math.ceil(estimated.toNumber() * 1.2);
    logger.info(`claimRewards estimateGas: ${estimated.toNumber()}, using ${gasLimit} (1.2x)`);
  } catch {
    gasLimit = CLAIM_REWARDS_GAS_LIMIT;
    logger.info(`claimRewards estimateGas failed, using fallback: ${gasLimit}`);
  }

  // Use EIP-1559 gas pricing
  const gasOptions = await ethereum.prepareGasOptions(undefined, gasLimit);

  // Claim AERO rewards
  const tx = await gaugeWithSigner.getReward(tokenId, gasOptions);
  const receipt = await ethereum.handleTransactionExecution(tx);

  if (!receipt || receipt.status !== 1) {
    logger.warn(`Reward claim failed or timed out for position ${tokenId}`);
    return {
      signature: receipt?.transactionHash || '',
      status: receipt?.status || 0,
      data: {
        fee: 0,
        aeroAmount,
      },
    };
  }

  const gasFee = formatTokenAmount(receipt.gasUsed.mul(receipt.effectiveGasPrice).toString(), 18);

  logger.info(`Rewards claimed: ${aeroAmount} AERO for position ${tokenId}, gas: ${gasFee} ETH`);

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
