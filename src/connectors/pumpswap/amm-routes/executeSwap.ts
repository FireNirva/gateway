import { ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import BN from 'bn.js';
import Decimal from 'decimal.js';
import { FastifyPluginAsync } from 'fastify';

import { Solana } from '../../../chains/solana/solana';
import { ExecuteSwapResponse, ExecuteSwapResponseType } from '../../../schemas/amm-schema';
import { httpErrors } from '../../../services/error-handler';
import { logger } from '../../../services/logger';
import { sanitizeErrorMessage } from '../../../services/sanitize';
import { PumpSwap } from '../pumpswap';
import { PumpSwapConfig } from '../pumpswap.config';
import { PumpSwapAmmExecuteSwapRequest, PumpSwapAmmExecuteSwapRequestType } from '../schemas';

// Compute-unit ceiling for a PumpSwap swap (sell/buy + WSOL wrap/unwrap +
// optional volume-accumulator ix). Matches the raydium AMM budget; unused CU
// is free, only the priority *price* per CU is paid.
const COMPUTE_UNITS = 300000;
const SOL_NATIVE_MINT = 'So11111111111111111111111111111111111111112';

/**
 * Resolve the requested base token to a mint address and assert it matches the
 * pool's base mint. The bot always passes the graduated mint as `baseToken`;
 * pump.fun canonical pools always have the meme as base and WSOL as quote. Any
 * mismatch is rejected (safe — the bot then re-raises the original Jupiter
 * error to its normal handler instead of selling into the wrong pool).
 */
async function assertBaseMatchesPool(solana: Solana, baseToken: string, poolBaseMint: string): Promise<void> {
  if (baseToken === poolBaseMint) return;
  // Allow a symbol/alias that resolves to the same mint.
  const resolved = await solana.getToken(baseToken);
  if (resolved && resolved.address === poolBaseMint) return;
  throw httpErrors.badRequest(
    sanitizeErrorMessage('baseToken {} does not match pool base mint', `${baseToken} != ${poolBaseMint}`),
  );
}

export async function executeSwap(
  network: string,
  walletAddress: string,
  baseToken: string,
  _quoteToken: string,
  amount: number,
  side: 'BUY' | 'SELL',
  poolAddress: string,
  slippagePct: number = PumpSwapConfig.config.slippagePct,
): Promise<ExecuteSwapResponseType> {
  const solana = await Solana.getInstance(network);
  const pumpswap = await PumpSwap.getInstance(network);

  const poolKey = pumpswap.assertValidPool(poolAddress);
  const { wallet, isHardwareWallet } = await pumpswap.prepareWallet(walletAddress);
  const userPubkey = new PublicKey(walletAddress);

  // Fetch live on-chain pool state (reserves, mints, decimals, fee config) for
  // this user. swapSolanaState derives the user's base/quote token accounts.
  const swapState = await pumpswap.onlineSdk.swapSolanaState(poolKey, userPubkey);
  const baseMint = swapState.baseMint.toBase58();
  const baseDecimals = swapState.baseMintAccount.decimals;

  await assertBaseMatchesPool(solana, baseToken, baseMint);

  // Build the swap instructions via the SDK (includes WSOL wrap/unwrap so the
  // user receives native SOL on SELL). slippagePct is a percent (10 = 10%).
  let instructions;
  if (side === 'SELL') {
    // Sell exact base (the meme token) for SOL.
    const baseBN = new BN(new Decimal(amount).mul(new Decimal(10).pow(baseDecimals)).toFixed(0));
    if (baseBN.lten(0)) {
      throw httpErrors.badRequest('SELL amount resolves to zero base units');
    }
    instructions = await pumpswap.offlineSdk.sellBaseInput(swapState, baseBN, slippagePct);
  } else {
    // Buy base by spending exact SOL (quote is WSOL, 9 decimals).
    const quoteBN = new BN(new Decimal(amount).mul(new Decimal(10).pow(9)).toFixed(0));
    if (quoteBN.lten(0)) {
      throw httpErrors.badRequest('BUY amount resolves to zero quote lamports');
    }
    instructions = await pumpswap.offlineSdk.buyQuoteInput(swapState, quoteBN, slippagePct);
  }

  logger.info(`Executing ${amount} ${side} on PumpSwap pool ${poolAddress} (slippage ${slippagePct}%)`);

  // Priority fee (lamports/CU -> microLamports/CU), same conversion as raydium.
  const priorityFeeInLamports = await solana.estimateGasPrice();
  const priorityFeePerCU = Math.floor(priorityFeeInLamports * 1e6);
  const computeBudgetIxs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNITS }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeePerCU }),
  ];

  const { blockhash } = await solana.connection.getLatestBlockhash('confirmed');
  const messageV0 = new TransactionMessage({
    payerKey: userPubkey,
    recentBlockhash: blockhash,
    instructions: [...computeBudgetIxs, ...instructions],
  }).compileToV0Message();
  let transaction = new VersionedTransaction(messageV0);

  transaction = (await pumpswap.signTransaction(
    transaction,
    walletAddress,
    isHardwareWallet,
    wallet,
  )) as VersionedTransaction;

  // Simulate + send + confirm via the shared Solana chain class — identical
  // confirmation semantics and response shape to the raydium/AMM path.
  await solana.simulateWithErrorHandling(transaction);
  const { confirmed, signature, txData } = await solana.sendAndConfirmRawTransaction(transaction);

  // For balance-change extraction: SELL = base mint in, native SOL out (the
  // SDK closes the WSOL account so SOL lands natively — pass "SOL", NOT the
  // WSOL mint, which would net to zero). BUY is the mirror.
  const tokenIn = side === 'SELL' ? baseMint : 'SOL';
  const tokenOut = side === 'SELL' ? 'SOL' : baseMint;
  const result = await solana.handleConfirmation(signature, confirmed, txData, tokenIn, tokenOut, walletAddress, side);

  if (result.status === 1) {
    logger.info(
      `PumpSwap ${side} confirmed: ${result.data?.amountIn} in -> ${result.data?.amountOut} out (sig ${signature})`,
    );
  }

  return result as ExecuteSwapResponseType;
}

export const executeSwapRoute: FastifyPluginAsync = async (fastify) => {
  const walletAddressExample = await Solana.getWalletAddressExample();

  fastify.post<{
    Body: PumpSwapAmmExecuteSwapRequestType;
    Reply: ExecuteSwapResponseType;
  }>(
    '/execute-swap',
    {
      schema: {
        description: 'Execute a swap directly on a PumpSwap (pump.fun) AMM pool, bypassing the Jupiter router',
        tags: ['/connector/pumpswap'],
        body: {
          ...PumpSwapAmmExecuteSwapRequest,
          properties: {
            ...PumpSwapAmmExecuteSwapRequest.properties,
            network: { type: 'string', default: 'mainnet-beta' },
            walletAddress: { type: 'string', examples: [walletAddressExample] },
            baseToken: { type: 'string', examples: ['<token-mint-address>'] },
            quoteToken: { type: 'string', examples: ['SOL'] },
            amount: { type: 'number', examples: [1000] },
            side: { type: 'string', examples: ['SELL'] },
            poolAddress: { type: 'string', examples: ['<pumpswap-pool-address>'] },
            slippagePct: { type: 'number', examples: [PumpSwapConfig.config.slippagePct] },
          },
        },
        response: { 200: ExecuteSwapResponse },
      },
    },
    async (request) => {
      try {
        const { network, walletAddress, baseToken, quoteToken, amount, side, poolAddress, slippagePct } =
          request.body as PumpSwapAmmExecuteSwapRequestType;

        if (!poolAddress) {
          throw httpErrors.badRequest('poolAddress is required for PumpSwap (no symbol pool lookup)');
        }
        if (!walletAddress) {
          throw httpErrors.badRequest('walletAddress is required');
        }

        return await executeSwap(
          network ?? 'mainnet-beta',
          walletAddress,
          baseToken,
          quoteToken ?? SOL_NATIVE_MINT,
          amount,
          (side as 'BUY' | 'SELL') ?? 'SELL',
          poolAddress,
          slippagePct ?? PumpSwapConfig.config.slippagePct,
        );
      } catch (e) {
        logger.error(e);
        if (e.statusCode) throw e;
        throw httpErrors.internalServerError('PumpSwap swap execution failed');
      }
    },
  );
};

export default executeSwapRoute;
