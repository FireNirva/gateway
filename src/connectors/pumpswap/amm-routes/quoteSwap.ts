import { sellBaseInput, buyQuoteInput } from '@pump-fun/pump-swap-sdk';
import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import Decimal from 'decimal.js';
import { FastifyPluginAsync } from 'fastify';

import { Solana } from '../../../chains/solana/solana';
import { getSolanaChainConfig } from '../../../chains/solana/solana.config';
import { QuoteSwapResponse, QuoteSwapResponseType } from '../../../schemas/amm-schema';
import { httpErrors } from '../../../services/error-handler';
import { logger } from '../../../services/logger';
import { PumpSwap } from '../pumpswap';
import { PumpSwapConfig } from '../pumpswap.config';
import { PumpSwapAmmQuoteSwapRequest, PumpSwapAmmQuoteSwapRequestType } from '../schemas';

const SOL_NATIVE_MINT = 'So11111111111111111111111111111111111111112';
const QUOTE_DECIMALS = 9; // WSOL

export async function quoteSwap(
  network: string,
  poolAddress: string,
  baseToken: string,
  _quoteToken: string,
  amount: number,
  side: 'BUY' | 'SELL',
  slippagePct: number = PumpSwapConfig.config.slippagePct,
): Promise<QuoteSwapResponseType> {
  const solana = await Solana.getInstance(network);
  const pumpswap = await PumpSwap.getInstance(network);
  const poolKey = pumpswap.assertValidPool(poolAddress);

  // A quote needs only reserves/config — derive state against any user; the ATA
  // ownership is irrelevant to the constant-product math. Prefer the configured
  // default wallet, else fall back to the system address.
  const defaultWallet = getSolanaChainConfig().defaultWallet;
  let quoteUser: PublicKey;
  try {
    quoteUser = defaultWallet ? new PublicKey(defaultWallet) : PublicKey.default;
  } catch {
    quoteUser = PublicKey.default;
  }

  const swapState = await pumpswap.onlineSdk.swapSolanaState(poolKey, quoteUser);
  const baseMint = swapState.baseMint.toBase58();
  const baseDecimals = swapState.baseMintAccount.decimals;

  if (baseToken !== baseMint) {
    const resolved = await solana.getToken(baseToken);
    if (!resolved || resolved.address !== baseMint) {
      throw httpErrors.badRequest(`baseToken ${baseToken} does not match pool base mint ${baseMint}`);
    }
  }

  const common = {
    slippage: slippagePct,
    baseReserve: swapState.poolBaseAmount,
    quoteReserve: swapState.poolQuoteAmount,
    globalConfig: swapState.globalConfig,
    baseMintAccount: swapState.baseMintAccount,
    baseMint: swapState.baseMint,
    coinCreator: swapState.pool.coinCreator,
    creator: swapState.pool.creator,
    feeConfig: swapState.feeConfig,
  };

  let amountIn: number;
  let amountOut: number;
  let minAmountOut: number;
  let maxAmountIn: number;
  let tokenIn: string;
  let tokenOut: string;

  if (side === 'SELL') {
    const baseBN = new BN(new Decimal(amount).mul(new Decimal(10).pow(baseDecimals)).toFixed(0));
    const r = sellBaseInput({ base: baseBN, ...common });
    amountIn = amount;
    amountOut = new Decimal(r.uiQuote.toString()).div(new Decimal(10).pow(QUOTE_DECIMALS)).toNumber();
    minAmountOut = new Decimal(r.minQuote.toString()).div(new Decimal(10).pow(QUOTE_DECIMALS)).toNumber();
    maxAmountIn = amount;
    tokenIn = baseMint;
    tokenOut = SOL_NATIVE_MINT;
  } else {
    const quoteBN = new BN(new Decimal(amount).mul(new Decimal(10).pow(QUOTE_DECIMALS)).toFixed(0));
    const r = buyQuoteInput({ quote: quoteBN, ...common });
    amountIn = amount;
    amountOut = new Decimal(r.base.toString()).div(new Decimal(10).pow(baseDecimals)).toNumber();
    minAmountOut = amountOut; // exact-quote-in: output is the estimate
    maxAmountIn = new Decimal(r.maxQuote.toString()).div(new Decimal(10).pow(QUOTE_DECIMALS)).toNumber();
    tokenIn = SOL_NATIVE_MINT;
    tokenOut = baseMint;
  }

  const price = side === 'SELL' ? amountOut / amountIn : amountIn / amountOut;

  return {
    poolAddress,
    tokenIn,
    tokenOut,
    amountIn,
    amountOut,
    price,
    slippagePct,
    minAmountOut,
    maxAmountIn,
    priceImpactPct: 0, // not computed by the SDK low-level quote
  };
}

export const quoteSwapRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get<{
    Querystring: PumpSwapAmmQuoteSwapRequestType;
    Reply: QuoteSwapResponseType;
  }>(
    '/quote-swap',
    {
      schema: {
        description: 'Get a swap quote for a PumpSwap (pump.fun) AMM pool',
        tags: ['/connector/pumpswap'],
        querystring: PumpSwapAmmQuoteSwapRequest,
        response: { 200: QuoteSwapResponse },
      },
    },
    async (request) => {
      try {
        const { network, poolAddress, baseToken, quoteToken, amount, side, slippagePct } = request.query;
        if (!poolAddress || !baseToken || !amount || !side) {
          throw httpErrors.badRequest('poolAddress, baseToken, amount and side are required');
        }
        return await quoteSwap(
          network ?? 'mainnet-beta',
          poolAddress,
          baseToken,
          quoteToken ?? SOL_NATIVE_MINT,
          amount,
          side as 'BUY' | 'SELL',
          slippagePct ?? PumpSwapConfig.config.slippagePct,
        );
      } catch (e) {
        logger.error(e);
        if (e.statusCode) throw e;
        throw httpErrors.internalServerError('PumpSwap quote failed');
      }
    },
  );
};

export default quoteSwapRoute;
