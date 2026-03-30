import { Contract } from '@ethersproject/contracts';
import { Percent } from '@uniswap/sdk-core';
import { Position, NonfungiblePositionManager } from '@uniswap/v3-sdk';
import { BigNumber } from 'ethers';
import { FastifyPluginAsync } from 'fastify';
import JSBI from 'jsbi';

import { Ethereum } from '../../../chains/ethereum/ethereum';
import { AddLiquidityResponseType, AddLiquidityResponse } from '../../../schemas/clmm-schema';
import { httpErrors } from '../../../services/error-handler';
import { logger } from '../../../services/logger';
import { Aerodrome } from '../aerodrome';
import { AerodromeConfig } from '../aerodrome.config';
import {
  getSlot0,
  getDynamicFee,
  getPoolLiquidity,
  formatTokenAmount,
  estimateGasWithFallback,
} from '../aerodrome.utils';
import { AerodromeClmmAddLiquidityRequest } from '../schemas';
import { SlipstreamPool } from '../slipstream-sdk';

const CLMM_ADD_LIQUIDITY_GAS_LIMIT = 600000;

export async function addLiquidity(
  network: string,
  walletAddress: string,
  positionAddress: string,
  baseTokenAmount: number,
  quoteTokenAmount: number,
  slippagePct: number = AerodromeConfig.config.slippagePct,
): Promise<AddLiquidityResponseType> {
  if (!positionAddress || (baseTokenAmount === undefined && quoteTokenAmount === undefined)) {
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
  const positionDetails = await nftManager.positions(positionAddress);

  const token0 = await aerodrome.getTokenBySymbol(positionDetails.token0);
  const token1 = await aerodrome.getTokenBySymbol(positionDetails.token1);
  const tickLower = positionDetails.tickLower;
  const tickUpper = positionDetails.tickUpper;
  const tickSpacing = positionDetails.tickSpacing;

  const isBaseToken0 =
    token0.symbol === 'WETH' ||
    (token1.symbol !== 'WETH' && token0.address.toLowerCase() < token1.address.toLowerCase());

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

  // Calculate amounts
  const baseTokenObj = isBaseToken0 ? token0 : token1;
  const quoteTokenObj = isBaseToken0 ? token1 : token0;

  const baseAmountRaw = JSBI.BigInt(Math.floor(baseTokenAmount * Math.pow(10, baseTokenObj.decimals)).toString());
  const quoteAmountRaw = JSBI.BigInt(Math.floor(quoteTokenAmount * Math.pow(10, quoteTokenObj.decimals)).toString());

  const amount0 = isBaseToken0 ? baseAmountRaw : quoteAmountRaw;
  const amount1 = isBaseToken0 ? quoteAmountRaw : baseAmountRaw;

  const position = Position.fromAmounts({
    pool,
    tickLower,
    tickUpper,
    amount0,
    amount1,
    useFullPrecision: true,
  });

  const slippageTolerance = new Percent(Math.floor(slippagePct * 100), 10000);

  const { calldata, value } = NonfungiblePositionManager.addCallParameters(position, {
    tokenId: positionAddress,
    slippageTolerance,
    deadline: Math.floor(Date.now() / 1000) + 60 * 20,
  });

  // Check allowances
  for (const [token, amountRaw] of [
    [token0, amount0],
    [token1, amount1],
  ] as const) {
    const rawBN = BigNumber.from(amountRaw.toString());
    if (!rawBN.isZero()) {
      const tokenContract = ethereum.getContract(token.address, wallet);
      const allowance = await ethereum.getERC20Allowance(
        tokenContract,
        wallet,
        contracts.nftPositionManager,
        token.decimals,
      );
      if (BigNumber.from(allowance.value).lt(rawBN)) {
        throw httpErrors.badRequest(
          `Insufficient ${token.symbol} allowance for Position Manager (${contracts.nftPositionManager})`,
        );
      }
    }
  }

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

  const addGas = await estimateGasWithFallback(
    () => nftManagerWithSigner.estimateGas.multicall([calldata], { value: BigNumber.from(value.toString()) }),
    CLMM_ADD_LIQUIDITY_GAS_LIMIT,
    'addLiquidity/multicall',
  );
  const txParams = await ethereum.prepareGasOptions(undefined, addGas);
  txParams.value = BigNumber.from(value.toString());

  const tx = await nftManagerWithSigner.multicall([calldata], txParams);
  const receipt = await ethereum.handleTransactionExecution(tx);

  const gasFee = formatTokenAmount(receipt.gasUsed.mul(receipt.effectiveGasPrice).toString(), 18);

  const token0AmountAdded = formatTokenAmount(position.amount0.quotient.toString(), token0.decimals);
  const token1AmountAdded = formatTokenAmount(position.amount1.quotient.toString(), token1.decimals);

  return {
    signature: receipt.transactionHash,
    status: receipt.status,
    data: {
      fee: gasFee,
      baseTokenAmountAdded: isBaseToken0 ? token0AmountAdded : token1AmountAdded,
      quoteTokenAmountAdded: isBaseToken0 ? token1AmountAdded : token0AmountAdded,
    },
  };
}

export const addLiquidityRoute: FastifyPluginAsync = async (fastify) => {
  const walletAddressExample = await Ethereum.getWalletAddressExample();

  fastify.post<{
    Body: typeof AerodromeClmmAddLiquidityRequest.static;
    Reply: AddLiquidityResponseType;
  }>(
    '/add-liquidity',
    {
      schema: {
        description: 'Add liquidity to an existing Aerodrome Slipstream position',
        tags: ['/connector/aerodrome'],
        body: {
          ...AerodromeClmmAddLiquidityRequest,
          properties: {
            ...AerodromeClmmAddLiquidityRequest.properties,
            walletAddress: { type: 'string', examples: [walletAddressExample] },
          },
        },
        response: { 200: AddLiquidityResponse },
      },
    },
    async (request) => {
      try {
        const { network, walletAddress, positionAddress, baseTokenAmount, quoteTokenAmount, slippagePct } =
          request.body;

        if (!walletAddress) {
          throw httpErrors.badRequest('Wallet address is required');
        }

        return await addLiquidity(
          network,
          walletAddress,
          positionAddress,
          baseTokenAmount,
          quoteTokenAmount,
          slippagePct,
        );
      } catch (e: any) {
        logger.error('Failed to add liquidity:', e);
        if (e.statusCode) {
          throw e;
        }
        throw httpErrors.internalServerError('Failed to add liquidity');
      }
    },
  );
};

export default addLiquidityRoute;
