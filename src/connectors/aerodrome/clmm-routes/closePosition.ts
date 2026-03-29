import { Contract } from '@ethersproject/contracts';
import { BigNumber, utils } from 'ethers';
import { FastifyPluginAsync } from 'fastify';

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
import { formatTokenAmount } from '../aerodrome.utils';

const CLMM_CLOSE_POSITION_GAS_LIMIT = 500000;

// Standard NFT Position Manager ABI for close operations (functions + events)
const NPM_ABI = [
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, int24 tickSpacing, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
  'function decreaseLiquidity((uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline)) returns (uint256 amount0, uint256 amount1)',
  'function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max)) returns (uint256 amount0, uint256 amount1)',
  'function burn(uint256 tokenId)',
  'function multicall(bytes[] data) payable returns (bytes[] results)',
  'event Collect(uint256 indexed tokenId, address recipient, uint256 amount0, uint256 amount1)',
  'event DecreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
];

const MAX_UINT128 = BigNumber.from(2).pow(128).sub(1);

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

  const contracts = aerodrome.getContracts();
  const nftManagerAddress = contracts.nftPositionManager;

  const nftManagerContract = new Contract(nftManagerAddress, NPM_ABI, wallet);

  // Read position
  const position = await nftManagerContract.positions(positionAddress);
  const token0Address: string = position.token0;
  const token1Address: string = position.token1;
  const tickSpacingVal: number = position.tickSpacing;

  // Try to claim rewards and unstake from gauge
  try {
    const factory = aerodrome.getFactory();
    const poolAddress = await factory.getPool(token0Address, token1Address, tickSpacingVal);
    const gaugeAddress = await aerodrome.getGaugeAddress(poolAddress);

    if (gaugeAddress && gaugeAddress !== '0x0000000000000000000000000000000000000000') {
      const gauge = aerodrome.getGaugeContract(gaugeAddress);
      const gaugeWithSigner = gauge.connect(wallet);

      // Claim AERO rewards before unstaking (rewards are lost after withdraw)
      try {
        let earned;
        try {
          earned = await gaugeWithSigner.earned(positionAddress);
        } catch {
          logger.info(`earned() reverted for ${positionAddress} — skipping reward claim`);
          earned = null;
        }
        if (earned && !earned.isZero()) {
          const claimGasOptions = await ethereum.prepareGasOptions(undefined, 300000);
          const claimTx = await gaugeWithSigner.getReward(positionAddress, claimGasOptions);
          const claimReceipt = await ethereum.handleTransactionExecution(claimTx);
          if (claimReceipt && claimReceipt.status === 1) {
            logger.info(
              `Claimed ${formatTokenAmount(earned.toString(), 18)} AERO rewards before close for ${positionAddress}`,
            );
          } else {
            logger.warn(`Reward claim tx failed or timed out for ${positionAddress} — continuing with close`);
          }
        } else {
          logger.info(`No pending AERO rewards for position ${positionAddress}`);
        }
      } catch (err) {
        logger.warn(`Reward claim failed before close (continuing): ${(err as Error).message}`);
      }

      try {
        // Unstake from gauge — if not staked, it reverts and we catch it
        const withdrawTx = await gaugeWithSigner.withdraw(positionAddress);
        await ethereum.handleTransactionExecution(withdrawTx);
        logger.info(`Position ${positionAddress} unstaked from gauge ${gaugeAddress}`);
      } catch (err) {
        logger.warn(`Gauge withdraw failed (may not be staked): ${(err as Error).message}`);
      }
    }
  } catch (err) {
    logger.warn(`Gauge lookup failed: ${(err as Error).message}`);
  }

  // Re-read position after potential gauge withdrawal
  const positionDetails = await nftManagerContract.positions(positionAddress);
  const currentLiquidity: BigNumber = positionDetails.liquidity;

  if (currentLiquidity.isZero() && positionDetails.tokensOwed0.isZero() && positionDetails.tokensOwed1.isZero()) {
    throw httpErrors.badRequest('Position has already been closed or has no liquidity/fees to collect');
  }

  const token0 = await aerodrome.getTokenBySymbol(positionDetails.token0);
  const token1 = await aerodrome.getTokenBySymbol(positionDetails.token1);

  const isBaseToken0 =
    token0.symbol === 'WETH' ||
    (token1.symbol !== 'WETH' && token0.address.toLowerCase() < token1.address.toLowerCase());

  // Build multicall: decreaseLiquidity + collect + burn
  const iface = new utils.Interface(NPM_ABI);
  const deadline = Math.floor(Date.now() / 1000) + 60 * 20;

  const calldatas: string[] = [];

  // 1. decreaseLiquidity — remove all liquidity, accept any output (slippage handled by min amounts = 0)
  if (!currentLiquidity.isZero()) {
    calldatas.push(
      iface.encodeFunctionData('decreaseLiquidity', [
        {
          tokenId: positionAddress,
          liquidity: currentLiquidity,
          amount0Min: 0,
          amount1Min: 0,
          deadline,
        },
      ]),
    );
  }

  // 2. collect — collect all tokens + fees
  calldatas.push(
    iface.encodeFunctionData('collect', [
      {
        tokenId: positionAddress,
        recipient: walletAddress,
        amount0Max: MAX_UINT128,
        amount1Max: MAX_UINT128,
      },
    ]),
  );

  // 3. burn — burn the NFT
  calldatas.push(iface.encodeFunctionData('burn', [positionAddress]));

  logger.info(
    `Closing position ${positionAddress}: liquidity=${currentLiquidity.toString()}, multicall with ${calldatas.length} operations`,
  );

  const txParams = await ethereum.prepareGasOptions(undefined, CLMM_CLOSE_POSITION_GAS_LIMIT);
  txParams.value = BigNumber.from(0);

  const tx = await nftManagerContract.multicall(calldatas, txParams);
  const receipt = await ethereum.handleTransactionExecution(tx);

  const gasFee = formatTokenAmount(receipt.gasUsed.mul(receipt.effectiveGasPrice).toString(), 18);

  // Parse collected amounts from Collect event logs
  let amount0Collected = BigNumber.from(0);
  let amount1Collected = BigNumber.from(0);

  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed.name === 'Collect') {
        // Collect event: (tokenId, recipient, amount0, amount1)
        amount0Collected = BigNumber.from(parsed.args.amount0);
        amount1Collected = BigNumber.from(parsed.args.amount1);
        logger.info(`Collect event: amount0=${amount0Collected.toString()}, amount1=${amount1Collected.toString()}`);
      }
    } catch {
      // Not an event in our ABI — skip
    }
  }

  const token0AmountRemoved = formatTokenAmount(amount0Collected.toString(), token0.decimals);
  const token1AmountRemoved = formatTokenAmount(amount1Collected.toString(), token1.decimals);
  const token0FeeAmount = formatTokenAmount(positionDetails.tokensOwed0.toString(), token0.decimals);
  const token1FeeAmount = formatTokenAmount(positionDetails.tokensOwed1.toString(), token1.decimals);

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
        if (e.code === 'CALL_EXCEPTION') {
          throw httpErrors.badRequest(
            'Transaction failed. Please check that the position exists and is owned by this wallet.',
          );
        }
        throw httpErrors.internalServerError('Failed to close position');
      }
    },
  );
};

export default closePositionRoute;
