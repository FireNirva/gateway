import axios, { AxiosInstance } from 'axios';
import { BigNumber } from 'ethers';

import { Ethereum } from '../../chains/ethereum/ethereum';
import { ConfigManagerV2 } from '../../services/config-manager-v2';
import { logger } from '../../services/logger';
import { RateLimiter } from '../../services/rate-limiter';

import { ZeroXConfig } from './0x.config';

export interface ZeroXQuoteParams {
  sellToken: string;
  buyToken: string;
  sellAmount?: string;
  buyAmount?: string;
  takerAddress: string;
  slippagePercentage?: number;
  skipValidation?: boolean;
  affiliateAddress?: string;
}

export interface ZeroXPriceResponse {
  chainId: number;
  price: string;
  estimatedPriceImpact: string;
  value: string;
  gasPrice: string;
  gas: string;
  estimatedGas: string;
  protocolFee: string;
  minimumProtocolFee: string;
  buyTokenAddress: string;
  buyAmount: string;
  sellTokenAddress: string;
  sellAmount: string;
  sources: Array<{ name: string; proportion: string }>;
  allowanceTarget: string;
  sellTokenToEthRate: string;
  buyTokenToEthRate: string;
  expectedSlippage: string | null;
}

export interface ZeroXQuoteResponse extends ZeroXPriceResponse {
  guaranteedPrice: string;
  to: string;
  data: string;
  orders: any[];
  fees: {
    zeroExFee: {
      feeType: string;
      feeToken: string;
      feeAmount: string;
      billingType: string;
    };
  };
  auxiliaryChainData: any;
}

export class ZeroX {
  private static instances: Map<string, ZeroX> = new Map();
  private static limiters: Map<string, RateLimiter> = new Map();
  private static throttleUntilByNetwork: Map<string, number> = new Map();
  private client: AxiosInstance;
  private apiKey: string;
  private _slippagePct: number;
  private limiter: RateLimiter;
  private throttleBackoffMs: number;

  private constructor(
    private network: string,
    private chainId: number,
  ) {
    // Load configuration from ConfigManager
    this.apiKey = ZeroXConfig.config.apiKey;
    this._slippagePct = ZeroXConfig.config.slippagePct;

    // Check if API key is configured
    if (!this.apiKey) {
      throw new Error('0x API key not configured. Please add your API key to conf/connectors/0x.yml');
    }

    const maxConcurrent = ConfigManagerV2.getInstance().get('0x.requestRateLimit.maxConcurrent') || 1;
    const minDelay = ConfigManagerV2.getInstance().get('0x.requestRateLimit.minDelay') || 1000;
    this.throttleBackoffMs = ConfigManagerV2.getInstance().get('0x.throttleBackoffMs') || 60000;

    if (!ZeroX.limiters.has(network)) {
      ZeroX.limiters.set(
        network,
        new RateLimiter({
          maxConcurrent,
          minDelay,
          name: `0x:${network}`,
        }),
      );
    }
    this.limiter = ZeroX.limiters.get(network)!;

    const apiEndpoint = ZeroXConfig.getApiEndpoint(network);

    this.client = axios.create({
      baseURL: apiEndpoint,
      timeout: ConfigManagerV2.getInstance().get('0x.requestTimeout') || 30000,
      headers: {
        '0x-api-key': this.apiKey,
        '0x-version': 'v2',
        'Content-Type': 'application/json',
      },
    });

    // Add request/response logging if enabled
    if (ConfigManagerV2.getInstance().get('0x.enableLogging')) {
      this.client.interceptors.request.use((config) => {
        logger.debug(`0x API Request: ${config.method} ${config.url}`);
        return config;
      });

      this.client.interceptors.response.use(
        (response) => {
          logger.debug(`0x API Response: ${response.status}`);
          return response;
        },
        (error) => {
          logger.error(`0x API Error: ${error.message}`);
          return Promise.reject(error);
        },
      );
    }
  }

  public static async getInstance(network: string): Promise<ZeroX> {
    if (!ZeroX.instances.has(network)) {
      // Get chain ID from Ethereum configuration
      const ethereum = await Ethereum.getInstance(network);
      const chainId = ethereum.chainId;

      ZeroX.instances.set(network, new ZeroX(network, chainId));
    }
    return ZeroX.instances.get(network)!;
  }

  private async executeRequest<T>(requestFactory: () => Promise<T>): Promise<T> {
    this.throwIfThrottleBackoffActive();
    try {
      return await this.limiter.execute(async () => {
        this.throwIfThrottleBackoffActive();
        return await requestFactory();
      });
    } catch (error: any) {
      if (this.isThrottleError(error)) {
        this.activateThrottleBackoff(error);
      }
      throw error;
    }
  }

  private throwIfThrottleBackoffActive(): void {
    const throttleUntil = ZeroX.throttleUntilByNetwork.get(this.network) || 0;
    const remainingMs = throttleUntil - Date.now();
    if (remainingMs > 0) {
      throw new Error(`0x rate limit backoff active for ${remainingMs}ms on ${this.network}`);
    }
  }

  private isThrottleError(error: any): boolean {
    const status = error?.response?.status;
    const payload = JSON.stringify(error?.response?.data || '');
    const message = `${payload} ${error?.message || ''}`.toLowerCase();
    return status === 429 || message.includes('rate limit') || message.includes('throttle');
  }

  private activateThrottleBackoff(error: any): void {
    const retryAfterHeader = error?.response?.headers?.['retry-after'];
    const retryAfterSeconds = Number.parseInt(retryAfterHeader ?? '', 10);
    const backoffMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
      ? retryAfterSeconds * 1000
      : this.throttleBackoffMs;
    const currentThrottleUntil = ZeroX.throttleUntilByNetwork.get(this.network) || 0;
    const nextThrottleUntil = Math.max(currentThrottleUntil, Date.now() + backoffMs);
    ZeroX.throttleUntilByNetwork.set(this.network, nextThrottleUntil);
    logger.warn(`0x throttle detected on ${this.network}. Backing off for ${backoffMs}ms.`);
  }

  public async getPrice(params: ZeroXQuoteParams): Promise<ZeroXPriceResponse> {
    try {
      const queryParams: any = {
        chainId: this.chainId,
        sellToken: params.sellToken,
        buyToken: params.buyToken,
        takerAddress: params.takerAddress,
      };

      // Only one of sellAmount or buyAmount should be specified
      if (params.sellAmount) {
        queryParams.sellAmount = params.sellAmount;
      } else if (params.buyAmount) {
        queryParams.buyAmount = params.buyAmount;
      } else {
        throw new Error('Either sellAmount or buyAmount must be specified');
      }

      if (params.slippagePercentage !== undefined) {
        queryParams.slippagePercentage = params.slippagePercentage;
      }

      if (params.skipValidation !== undefined) {
        queryParams.skipValidation = params.skipValidation;
      }

      if (params.affiliateAddress) {
        queryParams.affiliateAddress = params.affiliateAddress;
      }

      const response = await this.executeRequest(() =>
        this.client.get<ZeroXPriceResponse>('/swap/permit2/price', { params: queryParams }),
      );

      return response.data;
    } catch (error: any) {
      if (error.response?.data) {
        logger.error(`0x API Error Response: ${JSON.stringify(error.response.data)}`);
        throw new Error(
          `0x API Error: ${error.response.data.reason || error.response.data.message || JSON.stringify(error.response.data)}`,
        );
      }
      throw error;
    }
  }

  public async getQuote(params: ZeroXQuoteParams): Promise<ZeroXQuoteResponse> {
    try {
      const queryParams: any = {
        chainId: this.chainId,
        sellToken: params.sellToken,
        buyToken: params.buyToken,
        takerAddress: params.takerAddress,
      };

      // Only one of sellAmount or buyAmount should be specified
      if (params.sellAmount) {
        queryParams.sellAmount = params.sellAmount;
      } else if (params.buyAmount) {
        queryParams.buyAmount = params.buyAmount;
      } else {
        throw new Error('Either sellAmount or buyAmount must be specified');
      }

      if (params.slippagePercentage !== undefined) {
        queryParams.slippagePercentage = params.slippagePercentage;
      }

      if (params.skipValidation !== undefined) {
        queryParams.skipValidation = params.skipValidation;
      }

      if (params.affiliateAddress) {
        queryParams.affiliateAddress = params.affiliateAddress;
      }

      const response = await this.executeRequest(() =>
        this.client.get<ZeroXQuoteResponse>('/swap/permit2/quote', { params: queryParams }),
      );

      return response.data;
    } catch (error: any) {
      if (error.response?.data) {
        logger.error(`0x API Error Response: ${JSON.stringify(error.response.data)}`);
        throw new Error(
          `0x API Error: ${error.response.data.reason || error.response.data.message || JSON.stringify(error.response.data)}`,
        );
      }
      throw error;
    }
  }

  public get slippagePct(): number {
    return this._slippagePct;
  }

  public get gasPriceBuffer(): number {
    // Hardcoded default for now
    return 1.2;
  }

  public formatTokenAmount(amount: string, decimals: number): string {
    const bigNumberAmount = BigNumber.from(amount);
    const divisor = BigNumber.from(10).pow(decimals);
    const beforeDecimal = bigNumberAmount.div(divisor);
    const afterDecimal = bigNumberAmount.mod(divisor);

    if (afterDecimal.isZero()) {
      return beforeDecimal.toString();
    }

    // Format with proper decimal places
    const afterDecimalStr = afterDecimal.toString().padStart(decimals, '0');
    const trimmed = afterDecimalStr.replace(/0+$/, '');

    return `${beforeDecimal}.${trimmed}`;
  }

  public parseTokenAmount(amount: number, decimals: number): string {
    // Convert a decimal amount to the token's smallest unit
    const multiplier = BigNumber.from(10).pow(decimals);
    const amountStr = amount.toFixed(decimals);
    const [whole, decimal = ''] = amountStr.split('.');
    const paddedDecimal = decimal.padEnd(decimals, '0');
    const combined = whole + paddedDecimal;
    return combined.replace(/^0+/, '') || '0';
  }
}
