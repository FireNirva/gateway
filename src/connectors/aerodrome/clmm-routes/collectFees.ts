import { Contract } from '@ethersproject/contracts';
import { CurrencyAmount } from '@uniswap/sdk-core';
import { NonfungiblePositionManager } from '@uniswap/v3-sdk';
import { BigNumber } from 'ethers';
import { FastifyPluginAsync } from 'fastify';

import { Ethereum } from '../../../chains/ethereum/ethereum';
import {
  CollectFeesRequestType,
  CollectFeesRequest,
  CollectFeesResponseType,
  CollectFeesResponse,
} from '../../../schemas/clmm-schema';
import { httpErrors } from '../../../services/error-handler';
import { logger } from '../../../services/logger';
import { Aerodrome } from '../aerodrome';
import { formatTokenAmount } from '../aerodrome.utils';

const CLMM_COLLECT_FEES_GAS_LIMIT = 200000;

export async function collectFees(
  network: string,
  walletAddress: string,
  positionAddress: string,
): Promise<CollectFeesResponseType> {
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

  // Fees are collectible while staked — call nftManager.collect() directly
  const position = await nftManager.positions(positionAddress);

  const token0 = await aerodrome.getTokenBySymbol(position.token0);
  const token1 = await aerodrome.getTokenBySymbol(position.token1);

  const isBaseToken0 =
    token0.symbol === 'WETH' ||
    (token1.symbol !== 'WETH' && token0.address.toLowerCase() < token1.address.toLowerCase());

  const feeAmount0 = position.tokensOwed0;
  const feeAmount1 = position.tokensOwed1;

  if (feeAmount0.eq(0) && feeAmount1.eq(0)) {
    throw httpErrors.badRequest('No fees to collect');
  }

  const expectedCurrencyOwed0 = CurrencyAmount.fromRawAmount(token0, feeAmount0.toString());
  const expectedCurrencyOwed1 = CurrencyAmount.fromRawAmount(token1, feeAmount1.toString());

  const collectParams = {
    tokenId: positionAddress,
    expectedCurrencyOwed0,
    expectedCurrencyOwed1,
    recipient: walletAddress,
  };

  const { calldata, value } = NonfungiblePositionManager.collectCallParameters(collectParams);

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

  const txParams = await ethereum.prepareGasOptions(undefined, CLMM_COLLECT_FEES_GAS_LIMIT);
  txParams.value = BigNumber.from(value.toString());

  const tx = await nftManagerWithSigner.multicall([calldata], txParams);
  const receipt = await ethereum.handleTransactionExecution(tx);

  const gasFee = formatTokenAmount(receipt.gasUsed.mul(receipt.effectiveGasPrice).toString(), 18);

  const token0FeeAmount = formatTokenAmount(feeAmount0.toString(), token0.decimals);
  const token1FeeAmount = formatTokenAmount(feeAmount1.toString(), token1.decimals);

  return {
    signature: receipt.transactionHash,
    status: receipt.status,
    data: {
      fee: gasFee,
      baseFeeAmountCollected: isBaseToken0 ? token0FeeAmount : token1FeeAmount,
      quoteFeeAmountCollected: isBaseToken0 ? token1FeeAmount : token0FeeAmount,
    },
  };
}

export const collectFeesRoute: FastifyPluginAsync = async (fastify) => {
  const walletAddressExample = await Ethereum.getWalletAddressExample();

  fastify.post<{
    Body: CollectFeesRequestType;
    Reply: CollectFeesResponseType;
  }>(
    '/collect-fees',
    {
      schema: {
        description: 'Collect trading fees from an Aerodrome Slipstream position (works while staked in gauge)',
        tags: ['/connector/aerodrome'],
        body: {
          ...CollectFeesRequest,
          properties: {
            ...CollectFeesRequest.properties,
            network: { type: 'string', default: 'base' },
            walletAddress: { type: 'string', examples: [walletAddressExample] },
            positionAddress: { type: 'string', description: 'Position NFT token ID', examples: ['1234'] },
          },
        },
        response: { 200: CollectFeesResponse },
      },
    },
    async (request) => {
      try {
        const { network, walletAddress, positionAddress } = request.body;

        if (!walletAddress) {
          throw httpErrors.badRequest('Wallet address is required');
        }

        return await collectFees(network, walletAddress, positionAddress);
      } catch (e: any) {
        logger.error('Failed to collect fees:', e);
        if (e.statusCode) {
          throw e;
        }
        throw httpErrors.internalServerError('Failed to collect fees');
      }
    },
  );
};

export default collectFeesRoute;
