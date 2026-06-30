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

  const DEFAULT_SLIPPAGE_PCT = 10;

  // Resolve slippagePct defensively. This runs at MODULE LOAD (imported by app.ts
  // + getConnectors), and the 'pumpswap' namespace may be ABSENT from a live host
  // conf/root.yml — yml is host-mounted and new template namespaces are NOT merged
  // into an existing conf/root.yml (ConfigManagerV2 only copies the template root.yml
  // when conf/root.yml is missing). Without this guard, get() throws notFound at
  // import and crashes the ENTIRE gateway boot — which would also kill the working
  // Jupiter sell path (every position unsellable). Degrade to a safe default so a
  // missing namespace localizes to pumpswap only. Deploy-ops must still SCP an
  // updated root.yml + pumpswap.yml; this is belt-and-suspenders.
  const loadSlippagePct = (): number => {
    try {
      const v = ConfigManagerV2.getInstance().get('pumpswap.slippagePct');
      return typeof v === 'number' && isFinite(v) ? v : DEFAULT_SLIPPAGE_PCT;
    } catch {
      return DEFAULT_SLIPPAGE_PCT;
    }
  };

  export const config: RootConfig = {
    slippagePct: loadSlippagePct(),

    availableNetworks: [
      {
        chain,
        networks: networks,
      },
    ],
  };
}
