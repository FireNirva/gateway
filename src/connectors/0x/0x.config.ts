import { getAvailableEthereumNetworks } from '../../chains/ethereum/ethereum.utils';
import { ConfigManagerV2 } from '../../services/config-manager-v2';

export namespace ZeroXConfig {
  // Supported networks for 0x
  // See https://0x.org/docs/developer-resources/supported-chains
  export const chain = 'ethereum';
  // Only include networks that are supported by 0x and available in Gateway
  export const networks = getAvailableEthereumNetworks().filter((network) =>
    ['mainnet', 'arbitrum', 'avalanche', 'base', 'bsc', 'optimism', 'polygon'].includes(network),
  );
  export type Network = string;

  // Supported trading types
  export const tradingTypes = ['router'] as const;

  export interface RootConfig {
    // Global configuration
    apiKey: string;
    slippagePct: number;
  }

  export const config: RootConfig = {
    apiKey: ConfigManagerV2.getInstance().get('0x.apiKey'),
    slippagePct: ConfigManagerV2.getInstance().get('0x.slippagePct'),
  };

  export const getApiEndpoint = (network: string): string => {
    if (!ZeroXConfig.networks.includes(network)) {
      throw new Error(
        `0x API endpoint not found for network: ${network}. Supported networks: ${ZeroXConfig.networks.join(', ')}`,
      );
    }

    // 0x Swap API v2 uses a single global hostname and routes by chainId.
    return 'https://api.0x.org';
  };
}
