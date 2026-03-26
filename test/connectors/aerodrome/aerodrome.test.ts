import { AerodromeConfig } from '../../../src/connectors/aerodrome/aerodrome.config';
import { getAerodromeContracts } from '../../../src/connectors/aerodrome/aerodrome.contracts';

jest.mock('../../../src/services/config-manager-v2', () => ({
  ConfigManagerV2: {
    getInstance: jest.fn().mockReturnValue({
      get: jest.fn().mockImplementation((key: string) => {
        const config: Record<string, any> = {
          'aerodrome.slippagePct': 2,
          'aerodrome.stakeInGauge': true,
          'aerodrome.autoClaimRewards': true,
        };
        return config[key];
      }),
    }),
  },
}));

describe('AerodromeConfig', () => {
  it('should have correct chain and network settings', () => {
    expect(AerodromeConfig.chain).toBe('ethereum');
    expect(AerodromeConfig.networks).toContain('base');
    expect(AerodromeConfig.tradingTypes).toContain('clmm');
  });

  it('should read config values', () => {
    expect(AerodromeConfig.config.slippagePct).toBe(2);
    expect(AerodromeConfig.config.stakeInGauge).toBe(true);
    expect(AerodromeConfig.config.autoClaimRewards).toBe(true);
  });
});

describe('AerodromeContracts', () => {
  it('should return contracts for base network', () => {
    const contracts = getAerodromeContracts('base');
    expect(contracts).toBeDefined();
    expect(contracts.clFactory).toBe('0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A');
    expect(contracts.nftPositionManager).toBe('0x827922686190790b37229fd06084350E74485b72');
    expect(contracts.swapRouter).toBe('0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5');
    expect(contracts.quoterV2).toBe('0x254cF9E1E6e233aa1AC962CB9B05b2cfeAaE15b0');
    expect(contracts.aeroToken).toBe('0x940181a94A35A4569E4529A3CDfB74e38FD98631');
    expect(contracts.voter).toBe('0x16613524e02ad97eDfeF371bC883F2F5d6C480A5');
  });

  it('should throw for unsupported network', () => {
    expect(() => getAerodromeContracts('mainnet')).toThrow();
  });
});
