import { Token } from '@uniswap/sdk-core';
import { Contract } from 'ethers';

import { Ethereum, TokenInfo } from '../../chains/ethereum/ethereum';
import { logger } from '../../services/logger';

import slipstreamNpmAbi from './abi/slipstreamNonfungiblePositionManager.json';
import { AerodromeConfig } from './aerodrome.config';
import { getAerodromeContracts } from './aerodrome.contracts';

// Minimal ABI for CLFactory
const CL_FACTORY_ABI = [
  {
    inputs: [
      { internalType: 'address', name: 'tokenA', type: 'address' },
      { internalType: 'address', name: 'tokenB', type: 'address' },
      { internalType: 'int24', name: 'tickSpacing', type: 'int24' },
    ],
    name: 'getPool',
    outputs: [{ internalType: 'address', name: 'pool', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
];

// Minimal ABI for CLGauge
const CL_GAUGE_ABI = [
  {
    inputs: [{ internalType: 'uint256', name: 'tokenId', type: 'uint256' }],
    name: 'deposit',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'uint256', name: 'tokenId', type: 'uint256' }],
    name: 'withdraw',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'uint256', name: 'tokenId', type: 'uint256' }],
    name: 'getReward',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'uint256', name: 'tokenId', type: 'uint256' }],
    name: 'earned',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'uint256', name: 'tokenId', type: 'uint256' }],
    name: 'stakedContains',
    outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'address', name: 'depositor', type: 'address' }],
    name: 'stakedLength',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'address', name: 'depositor', type: 'address' },
      { internalType: 'uint256', name: 'index', type: 'uint256' },
    ],
    name: 'stakedByIndex',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
];

// Minimal ABI for pool.gauge()
const POOL_GAUGE_ABI = [
  {
    inputs: [],
    name: 'gauge',
    outputs: [{ internalType: 'address', name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
];

export class Aerodrome {
  private static _instances: { [name: string]: Aerodrome };

  private ethereum: Ethereum;
  public config: AerodromeConfig.RootConfig;
  private _ready: boolean = false;
  private networkName: string;
  private chainId: number;

  // Contracts initialized in init()
  private nftManager: Contract;
  private factory: Contract;

  private constructor(network: string) {
    this.networkName = network;
    this.config = AerodromeConfig.config;
  }

  public static async getInstance(network: string): Promise<Aerodrome> {
    if (Aerodrome._instances === undefined) {
      Aerodrome._instances = {};
    }
    if (!(network in Aerodrome._instances)) {
      Aerodrome._instances[network] = new Aerodrome(network);
      await Aerodrome._instances[network].init();
    }
    return Aerodrome._instances[network];
  }

  public async init(): Promise<void> {
    try {
      this.ethereum = await Ethereum.getInstance(this.networkName);
      this.chainId = this.ethereum.chainId;

      const contracts = getAerodromeContracts(this.networkName);

      // NFT Position Manager (Slipstream ABI — has tickSpacing in positions())
      this.nftManager = new Contract(contracts.nftPositionManager, slipstreamNpmAbi, this.ethereum.provider);

      // CLFactory
      this.factory = new Contract(contracts.clFactory, CL_FACTORY_ABI, this.ethereum.provider);

      if (!this.ethereum.ready()) {
        await this.ethereum.init();
      }

      this._ready = true;
      logger.info(`Aerodrome connector initialized for network: ${this.networkName}`);
    } catch (error) {
      logger.error(`Error initializing Aerodrome: ${(error as Error).message}`);
      throw error;
    }
  }

  public ready(): boolean {
    return this._ready;
  }

  /**
   * Create a Uniswap SDK Token object from token info
   * (reuses @uniswap/sdk-core Token — compatible with SlipstreamPool)
   */
  public getToken(tokenInfo: TokenInfo): Token {
    return new Token(this.chainId, tokenInfo.address, tokenInfo.decimals, tokenInfo.symbol, tokenInfo.name);
  }

  /**
   * Get token by symbol or address from local token list
   */
  public async getTokenBySymbol(symbolOrAddress: string): Promise<Token | null> {
    const tokenInfo = await this.ethereum.getToken(symbolOrAddress);
    return tokenInfo ? this.getToken(tokenInfo) : null;
  }

  /**
   * Look up gauge address from pool contract (pool.gauge())
   * Simpler than voter.gauges() — directly reads from pool
   */
  public async getGaugeAddress(poolAddress: string): Promise<string> {
    const pool = new Contract(poolAddress, POOL_GAUGE_ABI, this.ethereum.provider);
    return await pool.gauge();
  }

  /**
   * Create a CLGauge contract instance for staking operations
   */
  public getGaugeContract(gaugeAddress: string): Contract {
    return new Contract(gaugeAddress, CL_GAUGE_ABI, this.ethereum.provider);
  }

  /**
   * Get the NFT Position Manager contract
   */
  public getNftManager(): Contract {
    return this.nftManager;
  }

  /**
   * Get the CLFactory contract
   */
  public getFactory(): Contract {
    return this.factory;
  }

  /**
   * Get the Ethereum instance
   */
  public getEthereum(): Ethereum {
    return this.ethereum;
  }

  /**
   * Get the chain ID
   */
  public getChainId(): number {
    return this.chainId;
  }

  /**
   * Get the network name
   */
  public getNetworkName(): string {
    return this.networkName;
  }

  /**
   * Get contract addresses for the current network
   */
  public getContracts() {
    return getAerodromeContracts(this.networkName);
  }
}
