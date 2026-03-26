import { Contract } from '@ethersproject/contracts';
import { Percent, CurrencyAmount } from '@uniswap/sdk-core';
import { NonfungiblePositionManager, Position } from '@uniswap/v3-sdk';
import { BigNumber } from 'ethers';
import { FastifyPluginAsync } from 'fastify';
import JSBI from 'jsbi';

import { Ethereum } from '../../../chains/ethereum/ethereum';
import {
  RemoveLiquidityRequestType,
  RemoveLiquidityRequest,
  RemoveLiquidityResponseType,
  RemoveLiquidityResponse,
} from '../../../schemas/clmm-schema';
import { httpErrors } from '../../../services/error-handler';
import { logger } from '../../../services/logger';
import { Aerodrome } from '../aerodrome';
import { getSlot0, getDynamicFee, getPoolLiquidity, formatTokenAmount } from '../aerodrome.utils';
import { SlipstreamPool } from '../slipstream-sdk';

const CLMM_REMOVE_LIQUIDITY_GAS_LIMIT = 500000;

export async function removeLiquidity(
  network: string,
  walletAddress: string,
  positionAddress: string,
  percentageToRemove: number,
): Promise<RemoveLiquidityResponseType> {
  if (!positionAddress || percentageToRemove === undefined) {
    throw httpErrors.badRequest('Missing required parameters');
  }

  if (percentageToRemove < 0 || percentageToRemove > 100) {
    throw httpErrors.badRequest('Percentage to remove must be between 0 and 100');
  }

  const aerodrome = await Aerodrome.getInstance(network);
  const ethereum = await Ethereum.getInstance(network);

  const wallet = await ethereum.getWallet(walletAddress);
  if (!wallet) {
    throw httpErrors.badRequest('Wallet not found');
  }

  const nftManager = aerodrome.getNftManager();
  const contracts = aerodrome.getContracts();
  const positionDetails = await nftManager.positions(positionAddress);

  const token0 = await aerodrome.getTokenBySymbol(positionDetails.token0);
  const token1 = await aerodrome.getTokenBySymbol(positionDetails.token1);
  const tickSpacing = positionDetails.tickSpacing;

  const isBaseToken0 =
    token0.symbol === 'WETH' ||
    (token1.symbol !== 'WETH' && token0.address.toLowerCase() < token1.address.toLowerCase());

  const currentLiquidity = positionDetails.liquidity;

  if (currentLiquidity.isZero()) {
    throw httpErrors.badRequest('Position has no liquidity to remove');
  }

  // Build SlipstreamPool
  const factory = aerodrome.getFactory();
  const poolAddress = await factory.getPool(positionDetails.token0, positionDetails.token1, tickSpacing);

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
    tickSpacing,
  );

  const positionSDK = new Position({
    pool,
    tickLower: positionDetails.tickLower,
    tickUpper: positionDetails.tickUpper,
    liquidity: currentLiquidity.toString(),
  });

  const slippageTolerance = new Percent(100, 10000);
  const liquidityPercentage = new Percent(Math.floor(percentageToRemove * 100), 10000);

  const feeAmount0 = positionDetails.tokensOwed0;
  const feeAmount1 = positionDetails.tokensOwed1;

  const totalAmount0 = CurrencyAmount.fromRawAmount(
    token0,
    JSBI.add(positionSDK.amount0.quotient, JSBI.BigInt(feeAmount0.toString())),
  );
  const totalAmount1 = CurrencyAmount.fromRawAmount(
    token1,
    JSBI.add(positionSDK.amount1.quotient, JSBI.BigInt(feeAmount1.toString())),
  );

  const removeParams = {
    tokenId: positionAddress,
    liquidityPercentage,
    slippageTolerance,
    deadline: Math.floor(Date.now() / 1000) + 60 * 20,
    burnToken: false,
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

  const txParams = await ethereum.prepareGasOptions(undefined, CLMM_REMOVE_LIQUIDITY_GAS_LIMIT);
  txParams.value = BigNumber.from(value.toString());

  const tx = await nftManagerWithSigner.multicall([calldata], txParams);
  const receipt = await ethereum.handleTransactionExecution(tx);

  const gasFee = formatTokenAmount(receipt.gasUsed.mul(receipt.effectiveGasPrice).toString(), 18);

  const token0AmountRemoved = formatTokenAmount(positionSDK.amount0.quotient.toString(), token0.decimals);
  const token1AmountRemoved = formatTokenAmount(positionSDK.amount1.quotient.toString(), token1.decimals);

  return {
    signature: receipt.transactionHash,
    status: receipt.status,
    data: {
      fee: gasFee,
      baseTokenAmountRemoved: isBaseToken0 ? token0AmountRemoved : token1AmountRemoved,
      quoteTokenAmountRemoved: isBaseToken0 ? token1AmountRemoved : token0AmountRemoved,
    },
  };
}

export const removeLiquidityRoute: FastifyPluginAsync = async (fastify) => {
  fastify.post<{
    Body: RemoveLiquidityRequestType;
    Reply: RemoveLiquidityResponseType;
  }>(
    '/remove-liquidity',
    {
      schema: {
        description: 'Remove liquidity from an Aerodrome Slipstream position',
        tags: ['/connector/aerodrome'],
        body: RemoveLiquidityRequest,
        response: { 200: RemoveLiquidityResponse },
      },
    },
    async (request) => {
      try {
        const { network, walletAddress, positionAddress, percentageToRemove } = request.body;

        if (!walletAddress) {
          throw httpErrors.badRequest('Wallet address is required');
        }

        return await removeLiquidity(network, walletAddress, positionAddress, percentageToRemove);
      } catch (e: any) {
        logger.error('Failed to remove liquidity:', e);
        if (e.statusCode) {
          throw e;
        }
        throw httpErrors.internalServerError('Failed to remove liquidity');
      }
    },
  );
};

export default removeLiquidityRoute;
