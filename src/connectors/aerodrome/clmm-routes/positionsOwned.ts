import { Type } from '@sinclair/typebox';
import { Position, tickToPrice } from '@uniswap/v3-sdk';
import { FastifyPluginAsync, FastifyInstance } from 'fastify';
import JSBI from 'jsbi';

import { Ethereum } from '../../../chains/ethereum/ethereum';
import { PositionInfo, PositionInfoSchema } from '../../../schemas/clmm-schema';
import { logger } from '../../../services/logger';
import { Aerodrome } from '../aerodrome';
import { getSlot0, getDynamicFee, getPoolLiquidity, formatTokenAmount } from '../aerodrome.utils';
import { SlipstreamPool } from '../slipstream-sdk';

const PositionsOwnedRequest = Type.Object({
  network: Type.Optional(Type.String({ examples: ['base'], default: 'base' })),
  walletAddress: Type.String({ examples: ['<ethereum-wallet-address>'] }),
});

const PositionsOwnedResponse = Type.Array(PositionInfoSchema);

export async function getPositionsOwned(
  fastify: FastifyInstance,
  network: string,
  walletAddress?: string,
): Promise<PositionInfo[]> {
  const aerodrome = await Aerodrome.getInstance(network);
  const nftManager = aerodrome.getNftManager();

  if (!walletAddress) {
    throw fastify.httpErrors.badRequest('Wallet address is required');
  }

  const balanceOf = await nftManager.balanceOf(walletAddress);
  const numPositions = balanceOf.toNumber();

  if (numPositions === 0) {
    return [];
  }

  const positions: PositionInfo[] = [];
  for (let i = 0; i < numPositions; i++) {
    try {
      const tokenId = await nftManager.tokenOfOwnerByIndex(walletAddress, i);
      const positionDetails = await nftManager.positions(tokenId);

      // Skip positions with no liquidity
      if (positionDetails.liquidity.eq(0)) {
        continue;
      }

      const token0Address = positionDetails.token0;
      const token1Address = positionDetails.token1;

      const token0 = await aerodrome.getTokenBySymbol(token0Address);
      const token1 = await aerodrome.getTokenBySymbol(token1Address);

      const tickLower = positionDetails.tickLower;
      const tickUpper = positionDetails.tickUpper;
      const liquidity = positionDetails.liquidity;
      const tickSpacing = positionDetails.tickSpacing;

      const feeAmount0 = formatTokenAmount(positionDetails.tokensOwed0.toString(), token0.decimals);
      const feeAmount1 = formatTokenAmount(positionDetails.tokensOwed1.toString(), token1.decimals);

      // Find pool address
      const factory = aerodrome.getFactory();
      const poolAddress = await factory.getPool(token0Address, token1Address, tickSpacing);

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

      const lowerPrice = tickToPrice(token0, token1, tickLower).toSignificant(6);
      const upperPrice = tickToPrice(token0, token1, tickUpper).toSignificant(6);
      const price = pool.token0Price.toSignificant(6);

      const position = new Position({
        pool,
        tickLower,
        tickUpper,
        liquidity: liquidity.toString(),
      });

      const token0Amount = formatTokenAmount(position.amount0.quotient.toString(), token0.decimals);
      const token1Amount = formatTokenAmount(position.amount1.quotient.toString(), token1.decimals);

      const isBaseToken0 =
        token0.symbol === 'WETH' ||
        (token1.symbol !== 'WETH' && token0.address.toLowerCase() < token1.address.toLowerCase());

      const [baseTokenAddress, quoteTokenAddress] = isBaseToken0
        ? [token0.address, token1.address]
        : [token1.address, token0.address];

      const [baseTokenAmount, quoteTokenAmount] = isBaseToken0
        ? [token0Amount, token1Amount]
        : [token1Amount, token0Amount];

      const [baseFeeAmount, quoteFeeAmount] = isBaseToken0 ? [feeAmount0, feeAmount1] : [feeAmount1, feeAmount0];

      positions.push({
        address: tokenId.toString(),
        poolAddress,
        baseTokenAddress,
        quoteTokenAddress,
        baseTokenAmount,
        quoteTokenAmount,
        baseFeeAmount,
        quoteFeeAmount,
        lowerBinId: tickLower,
        upperBinId: tickUpper,
        lowerPrice: parseFloat(lowerPrice),
        upperPrice: parseFloat(upperPrice),
        price: parseFloat(price),
      });
    } catch (err) {
      logger.warn(`Error fetching position ${i} for wallet ${walletAddress}: ${(err as Error).message}`);
    }
  }

  return positions;
}

export const positionsOwnedRoute: FastifyPluginAsync = async (fastify) => {
  const walletAddressExample = await Ethereum.getWalletAddressExample();

  fastify.get<{
    Querystring: typeof PositionsOwnedRequest.static;
    Reply: typeof PositionsOwnedResponse.static;
  }>(
    '/positions-owned',
    {
      schema: {
        description: 'Get all Aerodrome Slipstream positions owned by a wallet',
        tags: ['/connector/aerodrome'],
        querystring: {
          ...PositionsOwnedRequest,
          properties: {
            ...PositionsOwnedRequest.properties,
            walletAddress: { type: 'string', examples: [walletAddressExample] },
          },
        },
        response: { 200: PositionsOwnedResponse },
      },
    },
    async (request) => {
      try {
        const { walletAddress } = request.query;
        const network = request.query.network;
        return await getPositionsOwned(fastify, network, walletAddress);
      } catch (e) {
        logger.error(e);
        if (e.statusCode) {
          throw e;
        }
        throw fastify.httpErrors.internalServerError('Failed to fetch positions');
      }
    },
  );
};

export default positionsOwnedRoute;
