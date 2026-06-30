import { OnlinePumpAmmSdk, PumpAmmSdk } from '@pump-fun/pump-swap-sdk';
import { Keypair, PublicKey, VersionedTransaction, Transaction } from '@solana/web3.js';

import { Solana } from '../../chains/solana/solana';
import { SolanaLedger } from '../../chains/solana/solana-ledger';
import { PoolInfo as AmmPoolInfo } from '../../schemas/amm-schema';
import { httpErrors } from '../../services/error-handler';
import { logger } from '../../services/logger';

import { PumpSwapConfig } from './pumpswap.config';

/**
 * PumpSwap connector — the pump.fun post-graduation constant-product AMM.
 *
 * Why this exists (2026-06-30): the meme-sniper bot's only sell path was the
 * Jupiter router. Forensic (quants-lab L3_NOROUTE_CAUSE_2026-06-30) proved that
 * "no-route"/429 on sells is ~100% a client-side Jupiter routing/index failure
 * while the PumpSwap pool is ALIVE and others keep selling on-chain. This
 * connector lets the bot sell straight into the known pool (the same path other
 * traders use), bypassing Jupiter. It is the A-layer of the fallback; the bot
 * B-layer (deploy/meme-sniper, default OFF) calls
 * POST /connectors/pumpswap/amm/execute-swap.
 *
 * Design: wraps the official @pump-fun/pump-swap-sdk (web3.js v1 — compatible
 * with this gateway's stack). OnlinePumpAmmSdk fetches on-chain pool state;
 * PumpAmmSdk (offline) builds the swap instructions (incl. WSOL wrap/unwrap).
 * Signing / simulation / send / confirmation all reuse the shared Solana chain
 * class — so confirmation, phantom-sell guards and the response shape are
 * IDENTICAL to the raydium/AMM path.
 */
export class PumpSwap {
  private static _instances: { [name: string]: PumpSwap };
  public solana: Solana;
  public onlineSdk: OnlinePumpAmmSdk;
  public offlineSdk: PumpAmmSdk;
  public config: PumpSwapConfig.RootConfig;

  private constructor() {
    this.config = PumpSwapConfig.config;
    this.solana = null;
  }

  /** Gets singleton instance of PumpSwap for a network */
  public static async getInstance(network: string): Promise<PumpSwap> {
    if (!PumpSwap._instances) {
      PumpSwap._instances = {};
    }

    if (!PumpSwap._instances[network]) {
      const instance = new PumpSwap();
      await instance.init(network);
      PumpSwap._instances[network] = instance;
    }

    return PumpSwap._instances[network];
  }

  private async init(network: string) {
    try {
      this.solana = await Solana.getInstance(network);
      // OnlinePumpAmmSdk reads pool/global/fee state from the chain connection.
      this.onlineSdk = new OnlinePumpAmmSdk(this.solana.connection);
      // PumpAmmSdk is offline — it only builds instructions (no connection,
      // no owner state; the user pubkey is passed per swap).
      this.offlineSdk = new PumpAmmSdk();
      logger.info('PumpSwap initialized (pump.fun AMM, no default wallet)');
    } catch (error) {
      logger.error('PumpSwap initialization failed:', error);
      throw error;
    }
  }

  /**
   * Prepare wallet for signing. Unlike raydium, the pump SDK is stateless w.r.t.
   * the owner (the user pubkey is passed into each swapSolanaState/instruction
   * call), so there is no SDK re-init here.
   */
  public async prepareWallet(walletAddress: string): Promise<{
    wallet: Keypair | PublicKey;
    isHardwareWallet: boolean;
  }> {
    const isHardwareWallet = await this.solana.isHardwareWallet(walletAddress);
    const wallet = isHardwareWallet
      ? await this.solana.getPublicKey(walletAddress)
      : await this.solana.getWallet(walletAddress);
    return { wallet, isHardwareWallet };
  }

  /** Sign a transaction with a hardware (Ledger) or regular keypair wallet. */
  public async signTransaction(
    transaction: VersionedTransaction | Transaction,
    walletAddress: string,
    isHardwareWallet: boolean,
    wallet: Keypair | PublicKey,
  ): Promise<VersionedTransaction | Transaction> {
    if (isHardwareWallet) {
      logger.info(`Hardware wallet detected for ${walletAddress}. Signing transaction with Ledger.`);
      const ledger = new SolanaLedger();
      return await ledger.signTransaction(walletAddress, transaction);
    }
    if (transaction instanceof VersionedTransaction) {
      transaction.sign([wallet as Keypair]);
    } else {
      (transaction as Transaction).sign(wallet as Keypair);
    }
    return transaction;
  }

  /**
   * Read-only pool info (reserves / price / fee) for a pump AMM pool.
   * Reserves use the vault token-account UI balances (already decimal-adjusted).
   */
  public async getAmmPoolInfo(poolAddress: string): Promise<AmmPoolInfo | null> {
    try {
      const poolKey = new PublicKey(poolAddress);
      const pool = await this.onlineSdk.fetchPool(poolKey);

      const [baseBal, quoteBal] = await Promise.all([
        this.solana.connection.getTokenAccountBalance(pool.poolBaseTokenAccount),
        this.solana.connection.getTokenAccountBalance(pool.poolQuoteTokenAccount),
      ]);
      const baseAmount = baseBal.value.uiAmount ?? 0;
      const quoteAmount = quoteBal.value.uiAmount ?? 0;

      // Total taker fee = LP + protocol + coin-creator fee (basis points -> pct).
      let feePct = 0;
      try {
        const gc = await this.onlineSdk.fetchGlobalConfigAccount();
        const bps =
          Number(gc.lpFeeBasisPoints) + Number(gc.protocolFeeBasisPoints) + Number(gc.coinCreatorFeeBasisPoints);
        feePct = bps / 10000;
      } catch (e) {
        logger.debug(`PumpSwap getAmmPoolInfo: could not read global config fee: ${e}`);
      }

      return {
        address: poolAddress,
        baseTokenAddress: pool.baseMint.toString(),
        quoteTokenAddress: pool.quoteMint.toString(),
        feePct,
        price: baseAmount > 0 ? quoteAmount / baseAmount : 0,
        baseTokenAmount: baseAmount,
        quoteTokenAmount: quoteAmount,
      };
    } catch (error) {
      logger.debug(`Could not decode ${poolAddress} as PumpSwap AMM pool: ${error}`);
      return null;
    }
  }

  /** Validate a pool address string, throwing a 400 on malformed input. */
  public assertValidPool(poolAddress: string): PublicKey {
    try {
      return new PublicKey(poolAddress);
    } catch {
      throw httpErrors.badRequest(`Invalid pool address: ${poolAddress}`);
    }
  }
}
