import { Static } from '@sinclair/typebox';
import { BigNumber } from 'ethers';
import { FastifyPluginAsync } from 'fastify';
import { v4 as uuidv4 } from 'uuid';

import { Ethereum } from '../../../chains/ethereum/ethereum';
import { QuoteSwapRequestType } from '../../../schemas/router-schema';
import { httpErrors } from '../../../services/error-handler';
import { logger } from '../../../services/logger';
import { quoteCache } from '../../../services/quote-cache';
import { sanitizeErrorMessage } from '../../../services/sanitize';
import { ZeroX } from '../0x';
import { ZeroXConfig } from '../0x.config';
import { ZeroXQuoteSwapRequest, ZeroXQuoteSwapResponse } from '../schemas';

const BUY_SEARCH_MAX_DOUBLINGS = 12;
const BUY_SEARCH_MAX_ADJUSTMENTS = 4;
const BUY_ADJUSTMENT_BUFFER_BPS = 10;
const BUY_ACCEPTABLE_OVERSHOOT_BPS = 10;
const INDICATIVE_CACHE_TTL_MS = 1500;

const indicativeQuoteCache = new Map<string, { expiresAt: number; response: Static<typeof ZeroXQuoteSwapResponse> }>();
const inFlightIndicativeQuotes = new Map<string, Promise<Static<typeof ZeroXQuoteSwapResponse>>>();

async function getExactInputResponse(
  zeroX: ZeroX,
  indicativePrice: boolean,
  sellToken: string,
  buyToken: string,
  sellAmount: string,
  walletAddress: string,
  slippagePct: number,
): Promise<any> {
  const requestParams = {
    sellToken,
    buyToken,
    sellAmount,
    takerAddress: walletAddress,
    slippagePercentage: slippagePct / 100,
    skipValidation: indicativePrice,
  };

  if (indicativePrice) {
    return zeroX.getPrice(requestParams);
  }

  return zeroX.getQuote(requestParams);
}

async function getBuySideResponse(
  zeroX: ZeroX,
  indicativePrice: boolean,
  baseTokenAddress: string,
  quoteTokenAddress: string,
  amount: number,
  baseDecimals: number,
  walletAddress: string,
  slippagePct: number,
): Promise<any> {
  const targetBuyAmount = BigNumber.from(zeroX.parseTokenAmount(amount, baseDecimals));

  // Estimate the quote token spend by valuing the same base size on the sell side first.
  const sellSideEstimate = await getExactInputResponse(
    zeroX,
    true,
    baseTokenAddress,
    quoteTokenAddress,
    targetBuyAmount.toString(),
    walletAddress,
    slippagePct,
  );

  let currentSellAmount = BigNumber.from(sellSideEstimate.buyAmount || '0');
  if (currentSellAmount.lte(0)) {
    currentSellAmount = BigNumber.from(1);
  }

  let currentResponse = await getExactInputResponse(
    zeroX,
    indicativePrice,
    quoteTokenAddress,
    baseTokenAddress,
    currentSellAmount.toString(),
    walletAddress,
    slippagePct,
  );
  let currentBuyAmount = BigNumber.from(currentResponse.buyAmount);

  let doublings = 0;
  while (currentBuyAmount.lt(targetBuyAmount)) {
    currentSellAmount = currentSellAmount.mul(2);
    currentResponse = await getExactInputResponse(
      zeroX,
      indicativePrice,
      quoteTokenAddress,
      baseTokenAddress,
      currentSellAmount.toString(),
      walletAddress,
      slippagePct,
    );
    currentBuyAmount = BigNumber.from(currentResponse.buyAmount);
    doublings += 1;
    if (doublings >= BUY_SEARCH_MAX_DOUBLINGS) {
      throw new Error(`0x could not source enough liquidity to buy ${amount} base tokens.`);
    }
  }

  let bestResponse = currentResponse;
  let bestSellAmount = currentSellAmount;

  for (let step = 0; step < BUY_SEARCH_MAX_ADJUSTMENTS; step += 1) {
    const overshootAmount = currentBuyAmount.gte(targetBuyAmount)
      ? currentBuyAmount.sub(targetBuyAmount)
      : BigNumber.from(0);
    const acceptableOvershoot = targetBuyAmount.mul(BUY_ACCEPTABLE_OVERSHOOT_BPS).div(10000);
    if (overshootAmount.gte(0) && overshootAmount.lte(acceptableOvershoot)) {
      return currentResponse;
    }

    let adjustedSellAmount = currentSellAmount.mul(targetBuyAmount).div(currentBuyAmount);

    if (currentBuyAmount.lt(targetBuyAmount)) {
      adjustedSellAmount = adjustedSellAmount.mul(10000 + BUY_ADJUSTMENT_BUFFER_BPS).div(10000);
    }

    if (adjustedSellAmount.lte(0)) {
      adjustedSellAmount = BigNumber.from(1);
    }

    if (adjustedSellAmount.eq(currentSellAmount)) {
      adjustedSellAmount = currentBuyAmount.lt(targetBuyAmount)
        ? currentSellAmount.add(1)
        : currentSellAmount.gt(1)
          ? currentSellAmount.sub(1)
          : currentSellAmount;
    }

    if (adjustedSellAmount.lte(0)) {
      break;
    }

    const adjustedResponse = await getExactInputResponse(
      zeroX,
      indicativePrice,
      quoteTokenAddress,
      baseTokenAddress,
      adjustedSellAmount.toString(),
      walletAddress,
      slippagePct,
    );
    const adjustedBuyAmount = BigNumber.from(adjustedResponse.buyAmount);

    if (adjustedBuyAmount.gte(targetBuyAmount) && adjustedSellAmount.lt(bestSellAmount)) {
      bestResponse = adjustedResponse;
      bestSellAmount = adjustedSellAmount;
    }

    currentSellAmount = adjustedSellAmount;
    currentResponse = adjustedResponse;
    currentBuyAmount = adjustedBuyAmount;
  }

  return bestResponse;
}

async function quoteSwap(
  network: string,
  baseToken: string,
  quoteToken: string,
  amount: number,
  side: 'BUY' | 'SELL',
  slippagePct: number = ZeroXConfig.config.slippagePct,
  indicativePrice: boolean = true,
  takerAddress?: string,
): Promise<Static<typeof ZeroXQuoteSwapResponse>> {
  const ethereum = await Ethereum.getInstance(network);
  const zeroX = await ZeroX.getInstance(network);

  // Resolve token symbols/addresses to token objects from local token list
  const baseTokenInfo = await ethereum.getToken(baseToken);
  const quoteTokenInfo = await ethereum.getToken(quoteToken);

  if (!baseTokenInfo || !quoteTokenInfo) {
    throw httpErrors.badRequest(sanitizeErrorMessage('Token not found: {}', !baseTokenInfo ? baseToken : quoteToken));
  }

  // Determine input/output based on side
  const sellToken = side === 'SELL' ? baseTokenInfo.address : quoteTokenInfo.address;
  const buyToken = side === 'SELL' ? quoteTokenInfo.address : baseTokenInfo.address;

  // Hummingbot router semantics always express `amount` in base token units.
  const tokenAmount = zeroX.parseTokenAmount(amount, baseTokenInfo.decimals);

  // Use provided taker address or example
  const walletAddress = takerAddress || (await Ethereum.getWalletAddressExample());

  logger.info(
    `Getting ${indicativePrice ? 'indicative price' : 'firm quote'} for ${amount} ${baseToken} ${side === 'SELL' ? '->' : '<-'} ${quoteToken}`,
  );

  // Get quote or price from 0x API based on indicativePrice flag
  let apiResponse: any;
  if (indicativePrice) {
    if (side === 'SELL') {
      apiResponse = await getExactInputResponse(
        zeroX,
        true,
        sellToken,
        buyToken,
        tokenAmount,
        walletAddress,
        slippagePct,
      );
    } else {
      apiResponse = await getBuySideResponse(
        zeroX,
        true,
        baseTokenInfo.address,
        quoteTokenInfo.address,
        amount,
        baseTokenInfo.decimals,
        walletAddress,
        slippagePct,
      );
    }
  } else {
    if (side === 'SELL') {
      apiResponse = await getExactInputResponse(
        zeroX,
        false,
        sellToken,
        buyToken,
        tokenAmount,
        walletAddress,
        slippagePct,
      );
    } else {
      apiResponse = await getBuySideResponse(
        zeroX,
        false,
        baseTokenInfo.address,
        quoteTokenInfo.address,
        amount,
        baseTokenInfo.decimals,
        walletAddress,
        slippagePct,
      );
    }
  }

  // Parse amounts
  const sellDecimals = side === 'SELL' ? baseTokenInfo.decimals : quoteTokenInfo.decimals;
  const buyDecimals = side === 'SELL' ? quoteTokenInfo.decimals : baseTokenInfo.decimals;

  const estimatedAmountIn = parseFloat(zeroX.formatTokenAmount(apiResponse.sellAmount, sellDecimals));
  const estimatedAmountOut = parseFloat(zeroX.formatTokenAmount(apiResponse.buyAmount, buyDecimals));

  // Calculate min/max amounts based on slippage
  const minAmountOut = side === 'SELL' ? estimatedAmountOut * (1 - slippagePct / 100) : amount;
  const maxAmountIn = side === 'BUY' ? estimatedAmountIn * (1 + slippagePct / 100) : amount;

  // Calculate price based on side
  const price = side === 'SELL' ? estimatedAmountOut / estimatedAmountIn : estimatedAmountIn / amount;

  // Parse price impact
  const priceImpactPct = apiResponse.estimatedPriceImpact ? parseFloat(apiResponse.estimatedPriceImpact) * 100 : 0;

  // Generate quote ID and cache only for firm quotes
  let quoteId: string;
  let expirationTime: number | undefined;
  const now = Date.now();

  if (!indicativePrice) {
    // Only generate quote ID and cache for firm quotes
    quoteId = uuidv4();
    expirationTime = now + 30000; // 30 seconds TTL

    // Store the quote in global cache for later execution
    quoteCache.set(quoteId, apiResponse, {
      network,
      baseToken,
      quoteToken,
      amount,
      side,
      slippagePct,
      sellToken,
      buyToken,
      baseTokenInfo,
      quoteTokenInfo,
      walletAddress,
    });
  } else {
    // For indicative prices, use a placeholder quote ID
    quoteId = 'indicative-price';
  }

  // Format gas estimate
  const gasEstimate = apiResponse.estimatedGas || apiResponse.gas || '300000';

  return {
    quoteId,
    tokenIn: sellToken,
    tokenOut: buyToken,
    amountIn: side === 'SELL' ? amount : estimatedAmountIn,
    amountOut: side === 'SELL' ? estimatedAmountOut : amount,
    price,
    priceImpactPct,
    minAmountOut,
    maxAmountIn,
    gasEstimate,
    ...(expirationTime && { expirationTime }),
    // 0x-specific fields (only available for firm quotes)
    sources: apiResponse.sources,
    allowanceTarget: apiResponse.allowanceTarget,
    to: apiResponse.to,
    data: apiResponse.data,
    value: apiResponse.value,
  };
}

export { quoteSwap };

function getIndicativeQuoteCacheKey(
  network: string,
  baseToken: string,
  quoteToken: string,
  amount: number,
  side: 'BUY' | 'SELL',
  slippagePct: number,
  takerAddress?: string,
): string {
  return JSON.stringify({
    network,
    baseToken,
    quoteToken,
    amount,
    side,
    slippagePct,
    takerAddress: takerAddress || '',
  });
}

export const quoteSwapRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get<{
    Querystring: QuoteSwapRequestType;
    Reply: Static<typeof ZeroXQuoteSwapResponse>;
  }>(
    '/quote-swap',
    {
      schema: {
        description:
          'Get a swap quote from 0x. Use indicativePrice=true for price discovery only, or false/undefined for executable quotes',
        tags: ['/connector/0x'],
        querystring: ZeroXQuoteSwapRequest,
        response: { 200: ZeroXQuoteSwapResponse },
      },
    },
    async (request) => {
      try {
        const { network, baseToken, quoteToken, amount, side, slippagePct, indicativePrice, takerAddress } =
          request.query as typeof ZeroXQuoteSwapRequest._type;
        const useIndicativePrice = indicativePrice ?? true;
        if (useIndicativePrice) {
          const cacheKey = getIndicativeQuoteCacheKey(
            network,
            baseToken,
            quoteToken,
            amount,
            side as 'BUY' | 'SELL',
            slippagePct ?? ZeroXConfig.config.slippagePct,
            takerAddress,
          );
          const now = Date.now();
          const cached = indicativeQuoteCache.get(cacheKey);
          if (cached && cached.expiresAt > now) {
            return cached.response;
          }

          const inFlight = inFlightIndicativeQuotes.get(cacheKey);
          if (inFlight) {
            return await inFlight;
          }

          const quotePromise = quoteSwap(
            network,
            baseToken,
            quoteToken,
            amount,
            side as 'BUY' | 'SELL',
            slippagePct,
            useIndicativePrice,
            takerAddress,
          )
            .then((response) => {
              indicativeQuoteCache.set(cacheKey, {
                expiresAt: Date.now() + INDICATIVE_CACHE_TTL_MS,
                response,
              });
              return response;
            })
            .finally(() => {
              inFlightIndicativeQuotes.delete(cacheKey);
            });

          inFlightIndicativeQuotes.set(cacheKey, quotePromise);
          return await quotePromise;
        }

        return await quoteSwap(
          network,
          baseToken,
          quoteToken,
          amount,
          side as 'BUY' | 'SELL',
          slippagePct,
          useIndicativePrice,
          takerAddress,
        );
      } catch (e: any) {
        if (e.statusCode) throw e;
        logger.error('Error getting 0x quote:', e.message || e);

        // Handle specific error cases
        if (e.message?.includes('0x API key not configured')) {
          throw httpErrors.badRequest(e.message);
        }
        if (e.message?.includes('0x API Error')) {
          throw httpErrors.badRequest(e.message);
        }

        // Return the actual error message instead of generic one
        throw httpErrors.internalServerError(e.message || 'Failed to get quote');
      }
    },
  );
};

// Export quote cache for use in execute-quote
export { quoteCache };

export default quoteSwapRoute;
