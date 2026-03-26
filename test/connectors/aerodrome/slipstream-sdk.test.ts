import {
  SlipstreamPool,
  encodeSlipstreamMint,
  SLIPSTREAM_NPM_INTERFACE,
  SLIPSTREAM_SWAP_INTERFACE,
  Position,
  NonfungiblePositionManager,
  nearestUsableTick,
  TickMath,
  Token,
  JSBI,
} from '../../../src/connectors/aerodrome/slipstream-sdk';

describe('Slipstream SDK', () => {
  describe('Re-exports', () => {
    it('should re-export Position from @uniswap/v3-sdk', () => {
      expect(Position).toBeDefined();
    });

    it('should re-export NonfungiblePositionManager', () => {
      expect(NonfungiblePositionManager).toBeDefined();
    });

    it('should re-export nearestUsableTick', () => {
      expect(nearestUsableTick).toBeDefined();
      expect(typeof nearestUsableTick).toBe('function');
    });

    it('should re-export TickMath', () => {
      expect(TickMath).toBeDefined();
      expect(TickMath.getSqrtRatioAtTick).toBeDefined();
    });

    it('should re-export Token from @uniswap/sdk-core', () => {
      expect(Token).toBeDefined();
    });

    it('should re-export JSBI', () => {
      expect(JSBI).toBeDefined();
    });
  });

  describe('SlipstreamPool', () => {
    it('should extend UniV3Pool with custom tickSpacing', () => {
      const token0 = new Token(8453, '0x4200000000000000000000000000000000000006', 18, 'WETH');
      const token1 = new Token(8453, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 6, 'USDC');

      // Create SlipstreamPool with tickSpacing=1 (pool fee is a placeholder)
      const pool = new SlipstreamPool(
        token0,
        token1,
        500, // fee (placeholder — Slipstream uses tickSpacing)
        TickMath.getSqrtRatioAtTick(-202315),
        JSBI.BigInt('77841025956891277'),
        -202315,
        1, // tickSpacing override
      );

      expect(pool).toBeDefined();
      expect(pool.tickSpacing).toBe(1);
    });
  });

  describe('SLIPSTREAM_NPM_INTERFACE', () => {
    it('should have mint function', () => {
      expect(SLIPSTREAM_NPM_INTERFACE).toBeDefined();
      const mintFragment = SLIPSTREAM_NPM_INTERFACE.getFunction('mint');
      expect(mintFragment).toBeDefined();
    });

    it('should have positions function', () => {
      const positionsFragment = SLIPSTREAM_NPM_INTERFACE.getFunction('positions');
      expect(positionsFragment).toBeDefined();
    });
  });

  describe('SLIPSTREAM_SWAP_INTERFACE', () => {
    it('should have exactInputSingle function', () => {
      expect(SLIPSTREAM_SWAP_INTERFACE).toBeDefined();
      const swapFragment = SLIPSTREAM_SWAP_INTERFACE.getFunction('exactInputSingle');
      expect(swapFragment).toBeDefined();
    });
  });

  describe('encodeSlipstreamMint', () => {
    it('should encode mint calldata with 12-field struct', () => {
      const params = {
        token0: '0x4200000000000000000000000000000000000006',
        token1: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        tickSpacing: 1,
        tickLower: -202500,
        tickUpper: -202000,
        amount0Desired: '1000000000000000', // 0.001 WETH
        amount1Desired: '2200000', // 2.2 USDC
        amount0Min: '0',
        amount1Min: '0',
        recipient: '0x1234567890123456789012345678901234567890',
        deadline: Math.floor(Date.now() / 1000) + 1200,
        sqrtPriceX96: '0',
      };

      const calldata = encodeSlipstreamMint(params);
      expect(calldata).toBeDefined();
      expect(typeof calldata).toBe('string');
      expect(calldata.startsWith('0x')).toBe(true);
      // Mint function selector
      expect(calldata.length).toBeGreaterThan(10);
    });
  });
});
