import { Contract } from '@ethersproject/contracts';
import { Percent, CurrencyAmount } from '@uniswap/sdk-core';
import { NonfungiblePositionManager, Position } from '@uniswap/v3-sdk';
import { BigNumber } from 'ethers';
import { FastifyPluginAsync } from 'fastify';
import JSBI from 'jsbi';

import { Ethereum } from '../../../chains/ethereum/ethereum';
import {
  ClosePositionRequestType,
  ClosePositionRequest,
  ClosePositionResponseType,
  ClosePositionResponse,
} from '../../../schemas/clmm-schema';
import { httpErrors } from '../../../services/error-handler';
import { logger } from '../../../services/logger';
import { Aerodrome } from '../aerodrome';
import { getSlot0, getDynamicFee, getPoolLiquidity, formatTokenAmount } from '../aerodrome.utils';
import { SlipstreamPool } from '../slipstream-sdk';

const CLMM_CLOSE_POSITION_GAS_LIMIT = 400000;

export async function closePosition(
  network: string,
  walletAddress: string,
  positionAddress: string,
): Promise<ClosePositionResponseType> {
  if (!positionAddress) {
    throw httpErrors.badRequest('Missing required parameters');
  }

  const aerodrome = await Aerodrome.getInstance(network);
  const ethereum = await Ethereum.getInstance(network);

  const wallet = await ethereum.getWallet(walletAddress);
  if (!wallet) {
    throw httpErrors.badRequest('Wallet not found');
  }

  const nftManager = aerodrome.getNftManager();
  const contracts = aerodrome.getContracts();

  // If staked in gauge, withdraw first (auto-collects fees + rewards)
  const position = await nftManager.positions(positionAddress);
  const token0Address = position.token0;
  const token1Address = position.token1;
  const tickSpacing = position.tickSpacing;

  // Try to find pool and unstake from gauge
  try {
    const factory = aerodrome.getFactory();
    const poolAddress = await factory.getPool(token0Address, token1Address, tickSpacing);
    const gaugeAddress = await aerodrome.getGaugeAddress(poolAddress);

    if (gaugeAddress && gaugeAddress !== '0x0000000000000000000000000000000000000000') {
      const gauge = aerodrome.getGaugeContract(gaugeAddress);
      const gaugeWithSigner = gauge.connect(wallet);

      // Check if staked
      try {
        const isStaked = await gaugeWithSigner.stakedContains(positionAddress);
        if (isStaked) {
          // withdraw() auto-collects both fees AND rewards
          const withdrawTx = await gaugeWithSigner.withdraw(positionAddress);
          await ethereum.handleTransactionExecution(withdrawTx);
          logger.info(`Position ${positionAddress} unstaked from gauge ${gaugeAddress}`);
        }
      } catch (err) {
        logger.warn(`Gauge unstake check failed (may not be staked): ${(err as Error).message}`);
      }
    }
  } catch (err) {
    logger.warn(`Gauge lookup failed: ${(err as Error).message}`);
  }

  // Re-read position after potential gauge withdrawal
  const positionDetails = await nftManager.positions(positionAddress);
  const token0 = await aerodrome.getTokenBySymbol(positionDetails.token0);
  const token1 = await aerodrome.getTokenBySymbol(positionDetails.token1);

  const isBaseToken0 =
    token0.symbol === 'WETH' ||
    (token1.symbol !== 'WETH' && token0.address.toLowerCase() < token1.address.toLowerCase());

  const currentLiquidity = positionDetails.liquidity;

  if (currentLiquidity.isZero() && positionDetails.tokensOwed0.isZero() && positionDetails.tokensOwed1.isZero()) {
    throw httpErrors.badRequest('Position has already been closed or has no liquidity/fees to collect');
  }

  const feeAmount0 = positionDetails.tokensOwed0;
  const feeAmount1 = positionDetails.tokensOwed1;

  // Build SlipstreamPool
  const factory = aerodrome.getFactory();
  const poolAddress = await factory.getPool(
    positionDetails.token0,
    positionDetails.token1,
    positionDetails.tickSpacing,
  );

  const [slot0, dynamicFee, poolLiquidity] = await Promise.all([
    getSlot0(poolAddress, network),
    getDynamicFee(poolAddress, network),
    getPoolLiquidity(poolAddress, network),
  ]);

  const pool = new SlipstreamPool(
    token0,
    token1,
    dynamicFee,
    JSBI.BigInt(slot0.sqrtPriceX96.toString()),
    JSBI.BigInt(poolLiquidity.toString()),
    slot0.tick,
    positionDetails.tickSpacing,
  );

  const positionSDK = new Position({
    pool,
    tickLower: positionDetails.tickLower,
    tickUpper: positionDetails.tickUpper,
    liquidity: currentLiquidity.toString(),
  });

  const amount0 = positionSDK.amount0;
  const amount1 = positionSDK.amount1;

  const slippageTolerance = new Percent(100, 10000);

  const totalAmount0 = CurrencyAmount.fromRawAmount(
    token0,
    JSBI.add(amount0.quotient, JSBI.BigInt(feeAmount0.toString())),
  );
  const totalAmount1 = CurrencyAmount.fromRawAmount(
    token1,
    JSBI.add(amount1.quotient, JSBI.BigInt(feeAmount1.toString())),
  );

  const removeParams = {
    tokenId: positionAddress,
    liquidityPercentage: new Percent(10000, 10000),
    slippageTolerance,
    deadline: Math.floor(Date.now() / 1000) + 60 * 20,
    burnToken: true,
    collectOptions: {
      expectedCurrencyOwed0: totalAmount0,
      expectedCurrencyOwed1: totalAmount1,
      recipient: walletAddress,
    },
  };

  const { calldata, value } = NonfungiblePositionManager.removeCallParameters(positionSDK, removeParams);

  const nftManagerWithSigner = new Contract(
    contracts.nftPositionManager,
    [
      {
        inputs: [{ internalType: 'bytes[]', name: 'data', type: 'bytes[]' }],
        name: 'multicall',
        outputs: [{ internalType: 'bytes[]', name: 'results', type: 'bytes[]' }],
        stateMutability: 'payable',
        type: 'function',
      },
    ],
    wallet,
  );

  const txParams = await ethereum.prepareGasOptions(undefined, CLMM_CLOSE_POSITION_GAS_LIMIT);
  txParams.value = BigNumber.from(value.toString());

  const tx = await nftManagerWithSigner.multicall([calldata], txParams);
  const receipt = await ethereum.handleTransactionExecution(tx);

  const gasFee = formatTokenAmount(receipt.gasUsed.mul(receipt.effectiveGasPrice).toString(), 18);

  const token0AmountRemoved = formatTokenAmount(totalAmount0.quotient.toString(), token0.decimals);
  const token1AmountRemoved = formatTokenAmount(totalAmount1.quotient.toString(), token1.decimals);
  const token0FeeAmount = formatTokenAmount(feeAmount0.toString(), token0.decimals);
  const token1FeeAmount = formatTokenAmount(feeAmount1.toString(), token1.decimals);

  const baseTokenAmountRemoved = isBaseToken0 ? token0AmountRemoved : token1AmountRemoved;
  const quoteTokenAmountRemoved = isBaseToken0 ? token1AmountRemoved : token0AmountRemoved;
  const baseFeeAmountCollected = isBaseToken0 ? token0FeeAmount : token1FeeAmount;
  const quoteFeeAmountCollected = isBaseToken0 ? token1FeeAmount : token0FeeAmount;

  return {
    signature: receipt.transactionHash,
    status: receipt.status,
    data: {
      fee: gasFee,
      positionRentRefunded: 0,
      baseTokenAmountRemoved,
      quoteTokenAmountRemoved,
      baseFeeAmountCollected,
      quoteFeeAmountCollected,
    },
  };
}

export const closePositionRoute: FastifyPluginAsync = async (fastify) => {
  fastify.post<{
    Body: ClosePositionRequestType;
    Reply: ClosePositionResponseType;
  }>(
    '/close-position',
    {
      schema: {
        description:
          'Close an Aerodrome Slipstream position (auto-unstakes from gauge, removes liquidity, collects fees)',
        tags: ['/connector/aerodrome'],
        body: ClosePositionRequest,
        response: { 200: ClosePositionResponse },
      },
    },
    async (request) => {
      try {
        const { network, walletAddress, positionAddress } = request.body;

        if (!walletAddress) {
          throw httpErrors.badRequest('Wallet address is required');
        }

        return await closePosition(network, walletAddress, positionAddress);
      } catch (e: any) {
        logger.error('Failed to close position:', e);
        if (e.statusCode) {
          throw e;
        }
        throw httpErrors.internalServerError('Failed to close position');
      }
    },
  );
};

export default closePositionRoute;
