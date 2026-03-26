import { getAvailableEthereumNetworks } from '../../chains/ethereum/ethereum.utils';
import { AvailableNetworks } from '../../services/base';
import { ConfigManagerV2 } from '../../services/config-manager-v2';

export namespace AerodromeConfig {
  // Supported networks for Aerodrome Slipstream
  // Aerodrome is deployed exclusively on Base
  export const chain = 'ethereum';
  export const networks = getAvailableEthereumNetworks().filter((network) => ['base'].includes(network));
  export type Network = string;

  // Supported trading types — CLMM only (Slipstream)
  export const tradingTypes = ['clmm'] as const;

  export interface RootConfig {
    // Global configuration
    slippagePct: number;
    stakeInGauge: boolean;
    autoClaimRewards: boolean;

    // Available networks
    availableNetworks: Array<AvailableNetworks>;
  }

  export const config: RootConfig = {
    slippagePct: ConfigManagerV2.getInstance().get('aerodrome.slippagePct'),
    stakeInGauge: ConfigManagerV2.getInstance().get('aerodrome.stakeInGauge') ?? true,
    autoClaimRewards: ConfigManagerV2.getInstance().get('aerodrome.autoClaimRewards') ?? true,

    availableNetworks: [
      {
        chain,
        networks: networks,
      },
    ],
  };
}
