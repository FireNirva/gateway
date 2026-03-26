/**
 * Aerodrome Slipstream contract addresses on Base
 *
 * Aerodrome has two deployments: "original" and "gauge caps" (newer).
 * Existing pools (like WETH/USDC) were created by the original factory.
 * Both NftManagers can manage positions on pools from either factory.
 *
 * Default: original deployment (where most existing pools live).
 *
 * Sources:
 * - https://github.com/aerodrome-finance/slipstream
 * - BaseScan verified contracts
 */

export interface AerodromeContractAddresses {
  // Core Slipstream contracts
  clFactory: string;
  nftPositionManager: string;
  swapRouter: string;
  quoterV2: string;

  // Gauge contracts
  gaugeFactory: string;

  // Protocol-wide
  voter: string;
  aeroToken: string;
}

export interface AerodromeNetworkContracts {
  [network: string]: AerodromeContractAddresses;
}

// Original deployment — most existing pools use this factory
const originalDeployment: AerodromeContractAddresses = {
  clFactory: '0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A',
  nftPositionManager: '0x827922686190790b37229fd06084350E74485b72',
  swapRouter: '0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5',
  quoterV2: '0x254cF9E1E6e233aa1AC962CB9B05b2cfeAaE15b0',
  gaugeFactory: '0xD30677bd8dd15132F251Cb54CbDA552d2A05Fb08',
  voter: '0x16613524e02ad97eDfeF371bC883F2F5d6C480A5',
  aeroToken: '0x940181a94A35A4569E4529A3CDfB74e38FD98631',
};

// Gauge caps deployment — newer pools with emission caps + redistributor
export const gaugeCapDeployment: AerodromeContractAddresses = {
  clFactory: '0xaDe65c38CD4849aDBA595a4323a8C7DdfE89716a',
  nftPositionManager: '0xa990C6a764b73BF43cee5Bb40339c3322FB9D55F',
  swapRouter: '0xcbBb8035cAc7D4B3Ca7aBb74cF7BdF900215Ce0D',
  quoterV2: '0x3d4C22254F86f64B7eC90ab8F7aeC1FBFD271c6C',
  gaugeFactory: '0xB630227a79707D517320b6c0f885806389dFcbB3',
  voter: '0x16613524e02ad97eDfeF371bC883F2F5d6C480A5',
  aeroToken: '0x940181a94A35A4569E4529A3CDfB74e38FD98631',
};

export const contractAddresses: AerodromeNetworkContracts = {
  base: originalDeployment,
};

export function getAerodromeContracts(network: string): AerodromeContractAddresses {
  const contracts = contractAddresses[network];
  if (!contracts) {
    throw new Error(`Aerodrome contracts not configured for network: ${network}`);
  }
  return contracts;
}
