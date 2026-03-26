import { Contract, BigNumber, utils } from 'ethers';
import { FastifyPluginAsync } from 'fastify';

import { Ethereum } from '../../../chains/ethereum/ethereum';
import { ExecuteSwapRequestType, SwapExecuteResponseType, SwapExecuteResponse } from '../../../schemas/router-schema';
import { httpErrors } from '../../../services/error-handler';
import { logger } from '../../../services/logger';
import { Aerodrome } from '../aerodrome';
import { AerodromeConfig } from '../aerodrome.config';
import { getTickSpacing, formatTokenAmount } from '../aerodrome.utils';
import { SLIPSTREAM_SWAP_INTERFACE } from '../slipstream-sdk';

import { getAerodromeClmmQuote } from './quoteSwap';

const CLMM_SWAP_GAS_LIMIT = 350000;

export async function executeClmmSwap(
  walletAddress: string,
  network: string,
  baseToken: string,
  quoteToken: string,
  amount: number,
  side: 'BUY' | 'SELL',
  poolAddress: string,
  slippagePct: number = AerodromeConfig.config.slippagePct,
): Promise<SwapExecuteResponseType> {
  const aerodrome = await Aerodrome.getInstance(network);
  const ethereum = await Ethereum.getInstance(network);

  const baseTokenObj = await aerodrome.getTokenBySymbol(baseToken);
  const quoteTokenObj = await aerodrome.getTokenBySymbol(quoteToken);

  if (!baseTokenObj || !quoteTokenObj) {
    throw httpErrors.badRequest('Token not found');
  }

  const wallet = await ethereum.getWallet(walletAddress);
  if (!wallet) {
    throw httpErrors.badRequest('Wallet not found');
  }

  // Get quote
  const { quote } = await getAerodromeClmmQuote(network, poolAddress, baseToken, quoteToken, amount, side, slippagePct);

  const exactIn = side === 'SELL';
  const [inputToken, outputToken] = exactIn ? [baseTokenObj, quoteTokenObj] : [quoteTokenObj, baseTokenObj];

  const amountIn = utils.parseUnits(amount.toFixed(inputToken.decimals), inputToken.decimals);
  const amountOutMinimum = utils.parseUnits(quote.minAmountOut.toFixed(outputToken.decimals), outputToken.decimals);

  const contracts = aerodrome.getContracts();
  const tickSpacing = await getTickSpacing(poolAddress, network);

  // Check allowance
  const tokenContract = ethereum.getContract(inputToken.address, wallet);
  const allowance = await ethereum.getERC20Allowance(tokenContract, wallet, contracts.swapRouter, inputToken.decimals);
  if (BigNumber.from(allowance.value).lt(amountIn)) {
    throw httpErrors.badRequest(
      `Insufficient ${inputToken.symbol} allowance for Swap Router (${contracts.swapRouter})`,
    );
  }

  // Build swap calldata using Slipstream swap interface (tickSpacing instead of fee)
  const deadline = Math.floor(Date.now() / 1000) + 60 * 20;

  const swapCalldata = SLIPSTREAM_SWAP_INTERFACE.encodeFunctionData('exactInputSingle', [
    {
      tokenIn: inputToken.address,
      tokenOut: outputToken.address,
      tickSpacing,
      recipient: walletAddress,
      deadline,
      amountIn,
      amountOutMinimum,
      sqrtPriceLimitX96: 0,
    },
  ]);

  const swapRouter = new Contract(
    contracts.swapRouter,
    ['function multicall(bytes[] data) external payable returns (bytes[] results)'],
    wallet,
  );

  const txParams = await ethereum.prepareGasOptions(undefined, CLMM_SWAP_GAS_LIMIT);
  txParams.value = BigNumber.from(0);

  const tx = await swapRouter.multicall([swapCalldata], txParams);
  const receipt = await ethereum.handleTransactionExecution(tx);

  const gasFee = formatTokenAmount(receipt.gasUsed.mul(receipt.effectiveGasPrice).toString(), 18);

  return {
    signature: receipt.transactionHash,
    status: receipt.status,
    data: {
      tokenIn: inputToken.address,
      tokenOut: outputToken.address,
      amountIn: amount,
      amountOut: quote.amountOut,
      fee: gasFee,
      baseTokenBalanceChange: exactIn ? -amount : quote.amountOut,
      quoteTokenBalanceChange: exactIn ? quote.amountOut : -amount,
    },
  };
}

export const executeSwapRoute: FastifyPluginAsync = async (fastify) => {
  const walletAddressExample = await Ethereum.getWalletAddressExample();

  fastify.post<{
    Body: ExecuteSwapRequestType;
    Reply: SwapExecuteResponseType;
  }>(
    '/execute-swap',
    {
      schema: {
        description: 'Execute a swap on Aerodrome Slipstream',
        tags: ['/connector/aerodrome'],
        body: {
          type: 'object',
          properties: {
            network: { type: 'string', default: 'base' },
            walletAddress: { type: 'string', examples: [walletAddressExample] },
            baseToken: { type: 'string', examples: ['WETH'] },
            quoteToken: { type: 'string', examples: ['USDC'] },
            amount: { type: 'number', examples: [0.001] },
            side: { type: 'string', enum: ['BUY', 'SELL'] },
            poolAddress: { type: 'string', examples: ['0xb2cc224c1c9fee385f8ad6a55b4d94e92359dc59'] },
            slippagePct: { type: 'number', examples: [2] },
          },
        },
        response: { 200: SwapExecuteResponse },
      },
    },
    async (request) => {
      try {
        const { network, walletAddress, baseToken, quoteToken, amount, side, poolAddress, slippagePct } =
          request.body as any;

        if (!walletAddress) {
          throw httpErrors.badRequest('Wallet address is required');
        }

        return await executeClmmSwap(
          walletAddress,
          network,
          baseToken,
          quoteToken,
          amount,
          side,
          poolAddress,
          slippagePct,
        );
      } catch (e: any) {
        logger.error('Failed to execute swap:', e);
        if (e.statusCode) {
          throw e;
        }
        throw httpErrors.internalServerError('Failed to execute swap');
      }
    },
  );
};

export default executeSwapRoute;
