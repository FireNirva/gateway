import { Contract } from '@ethersproject/contracts';
import { CurrencyAmount, Percent } from '@uniswap/sdk-core';
import { Position, nearestUsableTick } from '@uniswap/v3-sdk';
import { BigNumber } from 'ethers';
import { FastifyPluginAsync } from 'fastify';
import JSBI from 'jsbi';

const CLMM_OPEN_POSITION_GAS_LIMIT = 600000;
const CLMM_GAUGE_APPROVE_GAS_LIMIT = 100000;
const CLMM_GAUGE_DEPOSIT_GAS_LIMIT = 500000;

import { Ethereum } from '../../../chains/ethereum/ethereum';
import {
  OpenPositionRequestType,
  OpenPositionRequest,
  OpenPositionResponseType,
  OpenPositionResponse,
} from '../../../schemas/clmm-schema';
import { httpErrors } from '../../../services/error-handler';
import { logger } from '../../../services/logger';
import { sanitizeErrorMessage } from '../../../services/sanitize';
import { Aerodrome } from '../aerodrome';
import { AerodromeConfig } from '../aerodrome.config';
import {
  getAerodromePoolInfo,
  getSlot0,
  getTickSpacing,
  getDynamicFee,
  getPoolLiquidity,
  formatTokenAmount,
} from '../aerodrome.utils';
import { SlipstreamPool, encodeSlipstreamMint } from '../slipstream-sdk';

export async function openPosition(
  network: string,
  walletAddress: string,
  lowerPrice: number,
  upperPrice: number,
  poolAddress: string,
  baseTokenAmount?: number,
  quoteTokenAmount?: number,
  slippagePct: number = AerodromeConfig.config.slippagePct,
): Promise<OpenPositionResponseType> {
  if (!lowerPrice || !upperPrice || !poolAddress || (baseTokenAmount === undefined && quoteTokenAmount === undefined)) {
    throw httpErrors.badRequest('Missing required parameters');
  }

  const aerodrome = await Aerodrome.getInstance(network);
  const ethereum = await Ethereum.getInstance(network);

  const poolInfo = await getAerodromePoolInfo(poolAddress, network);
  if (!poolInfo) {
    throw httpErrors.notFound(sanitizeErrorMessage('Pool not found: {}', poolAddress));
  }

  const baseTokenObj = await aerodrome.getTokenBySymbol(poolInfo.baseTokenAddress);
  const quoteTokenObj = await aerodrome.getTokenBySymbol(poolInfo.quoteTokenAddress);

  if (!baseTokenObj || !quoteTokenObj) {
    throw httpErrors.badRequest('Token information not found for pool');
  }

  const wallet = await ethereum.getWallet(walletAddress);
  if (!wallet) {
    throw httpErrors.badRequest('Wallet not found');
  }

  // Read pool state
  const [slot0, tickSpacing, dynamicFee, liquidity] = await Promise.all([
    getSlot0(poolAddress, network),
    getTickSpacing(poolAddress, network),
    getDynamicFee(poolAddress, network),
    getPoolLiquidity(poolAddress, network),
  ]);

  const pool = new SlipstreamPool(
    baseTokenObj,
    quoteTokenObj,
    dynamicFee,
    JSBI.BigInt(slot0.sqrtPriceX96.toString()),
    JSBI.BigInt(liquidity.toString()),
    slot0.tick,
    tickSpacing,
  );

  const slippageTolerance = new Percent(Math.floor(slippagePct * 100), 10000);

  const token0 = pool.token0;
  const token1 = pool.token1;
  const isBaseToken0 = baseTokenObj.address.toLowerCase() === token0.address.toLowerCase();

  // Convert human prices to ticks
  const priceToTickWithDecimals = (humanPrice: number): number => {
    const rawPrice = humanPrice * Math.pow(10, token1.decimals - token0.decimals);
    return Math.floor(Math.log(rawPrice) / Math.log(1.0001));
  };

  let lowerTick = priceToTickWithDecimals(lowerPrice);
  let upperTick = priceToTickWithDecimals(upperPrice);

  lowerTick = nearestUsableTick(lowerTick, tickSpacing);
  upperTick = nearestUsableTick(upperTick, tickSpacing);

  if (lowerTick >= upperTick) {
    throw httpErrors.badRequest('Lower price must be less than upper price');
  }

  // Calculate token amounts — map base/quote to token0/token1
  let amount0Raw = JSBI.BigInt(0);
  let amount1Raw = JSBI.BigInt(0);

  if (baseTokenAmount !== undefined) {
    const raw = JSBI.BigInt(Math.floor(baseTokenAmount * Math.pow(10, baseTokenObj.decimals)).toString());
    if (isBaseToken0) {
      amount0Raw = raw;
    } else {
      amount1Raw = raw;
    }
  }

  if (quoteTokenAmount !== undefined) {
    const raw = JSBI.BigInt(Math.floor(quoteTokenAmount * Math.pow(10, quoteTokenObj.decimals)).toString());
    if (isBaseToken0) {
      amount1Raw = raw;
    } else {
      amount0Raw = raw;
    }
  }

  // Use the appropriate Position constructor:
  // - Both amounts provided: fromAmounts (max position fitting both)
  // - Only amount0: fromAmount0 (compute matching amount1 from price)
  // - Only amount1: fromAmount1 (compute matching amount0 from price)
  const has0 = JSBI.greaterThan(amount0Raw, JSBI.BigInt(0));
  const has1 = JSBI.greaterThan(amount1Raw, JSBI.BigInt(0));

  let position: Position;
  if (has0 && has1) {
    position = Position.fromAmounts({
      pool,
      tickLower: lowerTick,
      tickUpper: upperTick,
      amount0: amount0Raw,
      amount1: amount1Raw,
      useFullPrecision: true,
    });
  } else if (has0) {
    position = Position.fromAmount0({
      pool,
      tickLower: lowerTick,
      tickUpper: upperTick,
      amount0: amount0Raw,
      useFullPrecision: true,
    });
  } else {
    position = Position.fromAmount1({
      pool,
      tickLower: lowerTick,
      tickUpper: upperTick,
      amount1: amount1Raw,
    });
  }

  logger.info('Creating Aerodrome position:');
  logger.info(`  Token0: ${token0.symbol}, Token1: ${token1.symbol}`);
  logger.info(`  TickSpacing: ${tickSpacing}, DynamicFee: ${dynamicFee}`);
  logger.info(`  Tick range: [${lowerTick}, ${upperTick}]`);
  logger.info(`  Amount0: ${position.amount0.toSignificant(18)}, Amount1: ${position.amount1.toSignificant(18)}`);

  // Check token balances and allowances before submitting the transaction
  const contracts = aerodrome.getContracts();
  const nftManagerAddress = contracts.nftPositionManager;

  for (const [token, mintAmount] of [
    [token0, position.mintAmounts.amount0],
    [token1, position.mintAmounts.amount1],
  ] as const) {
    if (JSBI.greaterThan(mintAmount, JSBI.BigInt(0))) {
      const requiredAmount = BigNumber.from(mintAmount.toString());
      const requiredHuman = formatTokenAmount(requiredAmount.toString(), token.decimals);

      // Check balance first
      const tokenContract = ethereum.getContract(token.address, wallet);
      const balanceRaw = await tokenContract.balanceOf(wallet.address);
      if (BigNumber.from(balanceRaw).lt(requiredAmount)) {
        const balanceHuman = formatTokenAmount(balanceRaw.toString(), token.decimals);
        throw httpErrors.badRequest(
          `Insufficient ${token.symbol} balance: have ${balanceHuman}, need ${requiredHuman}. [INSUFFICIENT_BALANCE]`,
        );
      }

      // Then check allowance
      const allowance = await ethereum.getERC20Allowance(tokenContract, wallet, nftManagerAddress, token.decimals);
      const currentAllowance = BigNumber.from(allowance.value);
      if (currentAllowance.lt(requiredAmount)) {
        throw httpErrors.badRequest(
          `Insufficient ${token.symbol} allowance. Please approve at least ${requiredHuman} ${token.symbol} (${token.address}) for the Position Manager (${nftManagerAddress})`,
        );
      }
    }
  }

  // Build Slipstream mint calldata (12-field struct with sqrtPriceX96=0)
  const deadline = Math.floor(Date.now() / 1000) + 60 * 20;
  const slippageMultiplier = new Percent(1).subtract(slippageTolerance);

  const calldata = encodeSlipstreamMint({
    token0: token0.address,
    token1: token1.address,
    tickSpacing,
    tickLower: lowerTick,
    tickUpper: upperTick,
    amount0Desired: position.mintAmounts.amount0.toString(),
    amount1Desired: position.mintAmounts.amount1.toString(),
    amount0Min: position.amount0.multiply(slippageMultiplier).quotient.toString(),
    amount1Min: position.amount1.multiply(slippageMultiplier).quotient.toString(),
    recipient: walletAddress,
    deadline,
  });

  // Send transaction via multicall
  const nftManagerWithSigner = new Contract(
    nftManagerAddress,
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

  const txParams = await ethereum.prepareGasOptions(undefined, CLMM_OPEN_POSITION_GAS_LIMIT);
  txParams.value = BigNumber.from(0);
  const tx = await nftManagerWithSigner.multicall([calldata], txParams);

  const receipt = await ethereum.handleTransactionExecution(tx);

  // Extract position NFT ID from Transfer event
  let positionId = '';
  for (const log of receipt.logs) {
    if (
      log.address.toLowerCase() === nftManagerAddress.toLowerCase() &&
      log.topics[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' &&
      log.topics[1] === '0x0000000000000000000000000000000000000000000000000000000000000000'
    ) {
      positionId = BigNumber.from(log.topics[3]).toString();
      break;
    }
  }

  // Auto-stake in gauge if configured
  if (aerodrome.config.stakeInGauge && positionId) {
    try {
      const gaugeAddress = await aerodrome.getGaugeAddress(poolAddress);
      if (gaugeAddress && gaugeAddress !== '0x0000000000000000000000000000000000000000') {
        // Verify NFT ownership before approve (RPC may lag behind receipt)
        const nftOwnerContract = new Contract(
          nftManagerAddress,
          [
            {
              inputs: [{ type: 'uint256', name: 'tokenId' }],
              name: 'ownerOf',
              outputs: [{ type: 'address' }],
              stateMutability: 'view',
              type: 'function',
            },
          ],
          wallet.provider,
        );

        let nftReady = false;
        for (let attempt = 0; attempt < 5; attempt++) {
          try {
            const owner = await nftOwnerContract.ownerOf(positionId);
            if (owner.toLowerCase() === walletAddress.toLowerCase()) {
              nftReady = true;
              break;
            }
          } catch {
            // NFT not yet visible on RPC — wait and retry
          }
          await new Promise((r) => setTimeout(r, 2000));
        }

        if (!nftReady) {
          logger.warn(`NFT ${positionId} not found after 10s — skipping gauge staking`);
        } else {
          // Approve NFT to gauge
          const nftApproveContract = new Contract(
            nftManagerAddress,
            [
              {
                inputs: [{ type: 'address' }, { type: 'uint256' }],
                name: 'approve',
                outputs: [],
                stateMutability: 'nonpayable',
                type: 'function',
              },
            ],
            wallet,
          );
          // Approve NFT — try dynamic estimateGas, fallback to constant
          logger.info(`Approving NFT ${positionId} for gauge ${gaugeAddress}...`);
          let approveGasLimit: number;
          try {
            const estimated = await nftApproveContract.estimateGas.approve(gaugeAddress, positionId);
            approveGasLimit = Math.ceil(estimated.toNumber() * 1.2);
            logger.info(`Approve estimateGas: ${estimated.toNumber()}, using ${approveGasLimit} (1.2x)`);
          } catch {
            approveGasLimit = CLMM_GAUGE_APPROVE_GAS_LIMIT;
            logger.info(`Approve estimateGas failed, using fallback: ${approveGasLimit}`);
          }
          const approveGasOptions = await ethereum.prepareGasOptions(undefined, approveGasLimit);
          const approveTx = await nftApproveContract.approve(gaugeAddress, positionId, approveGasOptions);
          const approveReceipt = await ethereum.handleTransactionExecution(approveTx);
          if (!approveReceipt || approveReceipt.status !== 1) {
            logger.warn(`NFT approve failed or timed out for ${positionId} — skipping gauge staking`);
          } else {
            // Wait for RPC state propagation — load-balanced nodes may lag behind
            await new Promise((r) => setTimeout(r, 4000));

            // Verify approval before deposit
            const getApprovedContract = new Contract(
              nftManagerAddress,
              [
                {
                  inputs: [{ type: 'uint256', name: 'tokenId' }],
                  name: 'getApproved',
                  outputs: [{ type: 'address' }],
                  stateMutability: 'view',
                  type: 'function',
                },
              ],
              wallet.provider,
            );
            const approved = await getApprovedContract.getApproved(positionId);
            if (approved.toLowerCase() !== gaugeAddress.toLowerCase()) {
              logger.warn(`NFT ${positionId} approve not visible on RPC (got ${approved}) — skipping gauge staking`);
            } else {
              // Deposit into gauge — try dynamic estimateGas, fallback to constant
              const gauge = aerodrome.getGaugeContract(gaugeAddress);
              const gaugeWithSigner = gauge.connect(wallet);
              logger.info(`Depositing NFT ${positionId} into gauge...`);
              let depositGasLimit: number;
              try {
                const estimated = await gaugeWithSigner.estimateGas.deposit(positionId);
                depositGasLimit = Math.ceil(estimated.toNumber() * 1.2);
                logger.info(`Deposit estimateGas: ${estimated.toNumber()}, using ${depositGasLimit} (1.2x)`);
              } catch {
                depositGasLimit = CLMM_GAUGE_DEPOSIT_GAS_LIMIT;
                logger.info(`Deposit estimateGas failed, using fallback: ${depositGasLimit}`);
              }
              const depositGasOptions = await ethereum.prepareGasOptions(undefined, depositGasLimit);
              const depositTx = await gaugeWithSigner.deposit(positionId, depositGasOptions);
              const depositReceipt = await ethereum.handleTransactionExecution(depositTx);
              if (!depositReceipt || depositReceipt.status !== 1) {
                logger.warn(`Gauge deposit tx failed or timed out for ${positionId}`);
              } else {
                logger.info(`Position ${positionId} staked in gauge ${gaugeAddress}`);
              }
            }
          }
        }
      }
    } catch (gaugeError) {
      logger.warn(`Failed to stake in gauge (position still created): ${(gaugeError as Error).message}`);
    }
  }

  const gasFee = formatTokenAmount(receipt.gasUsed.mul(receipt.effectiveGasPrice).toString(), 18);

  const actualToken0Amount = formatTokenAmount(position.amount0.quotient.toString(), token0.decimals);
  const actualToken1Amount = formatTokenAmount(position.amount1.quotient.toString(), token1.decimals);
  const baseAmountUsed = isBaseToken0 ? actualToken0Amount : actualToken1Amount;
  const quoteAmountUsed = isBaseToken0 ? actualToken1Amount : actualToken0Amount;

  return {
    signature: receipt.transactionHash,
    status: receipt.status,
    data: {
      fee: gasFee,
      positionAddress: positionId,
      positionRent: 0,
      baseTokenAmountAdded: baseAmountUsed,
      quoteTokenAmountAdded: quoteAmountUsed,
    },
  };
}

export const openPositionRoute: FastifyPluginAsync = async (fastify) => {
  const walletAddressExample = await Ethereum.getWalletAddressExample();

  fastify.post<{
    Body: OpenPositionRequestType;
    Reply: OpenPositionResponseType;
  }>(
    '/open-position',
    {
      schema: {
        description: 'Open a new liquidity position in an Aerodrome Slipstream pool (auto-stakes in gauge)',
        tags: ['/connector/aerodrome'],
        body: {
          ...OpenPositionRequest,
          properties: {
            ...OpenPositionRequest.properties,
            network: { type: 'string', default: 'base' },
            walletAddress: { type: 'string', examples: [walletAddressExample] },
            lowerPrice: { type: 'number', examples: [2000] },
            upperPrice: { type: 'number', examples: [4000] },
            poolAddress: { type: 'string', examples: ['0xb2cc224c1c9fee385f8ad6a55b4d94e92359dc59'] },
            baseTokenAmount: { type: 'number', examples: [0.001] },
            quoteTokenAmount: { type: 'number', examples: [3] },
            slippagePct: { type: 'number', examples: [2] },
          },
        },
        response: { 200: OpenPositionResponse },
      },
    },
    async (request) => {
      try {
        const {
          network,
          walletAddress,
          lowerPrice,
          upperPrice,
          poolAddress,
          baseTokenAmount,
          quoteTokenAmount,
          slippagePct,
        } = request.body;

        if (!walletAddress) {
          throw httpErrors.badRequest('Wallet address is required');
        }

        return await openPosition(
          network,
          walletAddress,
          lowerPrice,
          upperPrice,
          poolAddress,
          baseTokenAmount,
          quoteTokenAmount,
          slippagePct,
        );
      } catch (e: any) {
        logger.error('Failed to open position:', e);
        if (e.statusCode) {
          throw e;
        }
        if (e.code === 'CALL_EXCEPTION') {
          throw httpErrors.badRequest(
            'Transaction failed. Please check token balances, approvals, and position parameters.',
          );
        }
        if (e.code === 'INSUFFICIENT_FUNDS' || (e.message && e.message.includes('insufficient funds'))) {
          throw httpErrors.badRequest('Insufficient funds to complete the transaction');
        }
        throw httpErrors.internalServerError('Failed to open position');
      }
    },
  );
};

export default openPositionRoute;
