import { getAvailableSolanaNetworks } from '../../chains/solana/solana.utils';
import { AvailableNetworks } from '../../services/base';
import { ConfigManagerV2 } from '../../services/config-manager-v2';

export namespace PumpSwapConfig {
  // PumpSwap is the pump.fun post-graduation constant-product AMM
  // (program pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA), Solana only.
  export const chain = 'solana';
  export const networks = getAvailableSolanaNetworks();
  export type Network = string;

  // Only AMM (constant-product) trading is supported.
  export const tradingTypes = ['amm'] as const;

  export interface RootConfig {
    // Default slippage percentage for swaps (e.g. 10 = 10%).
    slippagePct: number;

    // Available networks
    availableNetworks: Array<AvailableNetworks>;
  }

  export const config: RootConfig = {
    slippagePct: ConfigManagerV2.getInstance().get('pumpswap.slippagePct'),

    availableNetworks: [
      {
        chain,
        networks: networks,
      },
    ],
  };
}
