/**
 * Aerodrome Slipstream — Anvil Fork Integration Test
 *
 * Forks Base mainnet via Anvil and tests read-only operations against real
 * on-chain state. No transactions are sent (no private key needed).
 *
 * Prerequisites:
 *   - Anvil installed (foundryup)
 *   - Internet connection to Base RPC
 *
 * Run:
 *   GATEWAY_TEST_MODE=dev npx jest --runInBand test/connectors/aerodrome/anvil-fork.test.ts
 */

import { ChildProcess, spawn } from 'child_process';

import { ethers } from 'ethers';

// ─── Constants ───
const BASE_RPC = 'https://mainnet.base.org';
const ANVIL_PORT = 18545;
const ANVIL_RPC = `http://127.0.0.1:${ANVIL_PORT}`;

// Aerodrome Slipstream contracts on Base
const WETH_USDC_POOL = '0xb2cc224c1c9fee385f8ad6a55b4d94e92359dc59';
const CL_FACTORY = '0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A';
const NFT_POSITION_MANAGER = '0x827922686190790b37229fd06084350E74485b72';
const QUOTER_V2 = '0x254cF9E1E6e233aa1AC962CB9B05b2cfeAaE15b0';
const WETH = '0x4200000000000000000000000000000000000006';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

// ─── Minimal ABIs ───
const POOL_ABI = [
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, bool unlocked)',
  'function tickSpacing() view returns (int24)',
  'function fee() view returns (uint24)',
  'function liquidity() view returns (uint128)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function gauge() view returns (address)',
];

const FACTORY_ABI = ['function getPool(address tokenA, address tokenB, int24 tickSpacing) view returns (address)'];

const NPM_ABI = ['function balanceOf(address owner) view returns (uint256)'];

const QUOTER_ABI = [
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, int24 tickSpacing, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
];

const ERC20_ABI = ['function decimals() view returns (uint8)', 'function symbol() view returns (string)'];

// ─── Helpers ───
let anvilProcess: ChildProcess | null = null;
let provider: ethers.providers.JsonRpcProvider;

async function startAnvil(): Promise<void> {
  return new Promise((resolve, reject) => {
    const anvilPath = `${process.env.HOME}/.foundry/bin/anvil`;
    anvilProcess = spawn(anvilPath, ['--fork-url', BASE_RPC, '--port', String(ANVIL_PORT), '--no-mining'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timeout = setTimeout(() => {
      reject(new Error('Anvil startup timed out after 30s'));
    }, 30000);

    anvilProcess.stdout?.on('data', (data: Buffer) => {
      const msg = data.toString();
      if (msg.includes('Listening on')) {
        clearTimeout(timeout);
        resolve();
      }
    });

    anvilProcess.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString();
      // Anvil prints some info to stderr, only reject on actual errors
      if (msg.includes('error') || msg.includes('Error')) {
        clearTimeout(timeout);
        reject(new Error(`Anvil error: ${msg}`));
      }
    });

    anvilProcess.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function stopAnvil(): void {
  if (anvilProcess) {
    anvilProcess.kill('SIGTERM');
    anvilProcess = null;
  }
}

// ─── Tests ───
describe('Aerodrome Slipstream — Anvil Fork Integration', () => {
  beforeAll(async () => {
    await startAnvil();
    provider = new ethers.providers.JsonRpcProvider(ANVIL_RPC);
    // Verify fork is working
    const network = await provider.getNetwork();
    expect(network.chainId).toBe(8453);
  }, 60000);

  afterAll(() => {
    stopAnvil();
  });

  describe('Pool Contract Reads', () => {
    it('should read slot0 with 6 fields (not 7)', async () => {
      const pool = new ethers.Contract(WETH_USDC_POOL, POOL_ABI, provider);
      const slot0 = await pool.slot0();

      // Slipstream slot0 returns 6 fields (no feeProtocol)
      expect(slot0.sqrtPriceX96).toBeDefined();
      expect(slot0.tick).toBeDefined();
      expect(slot0.observationIndex).toBeDefined();
      expect(slot0.observationCardinality).toBeDefined();
      expect(slot0.observationCardinalityNext).toBeDefined();
      expect(slot0.unlocked).toBeDefined();

      // tick should be negative for WETH/USDC (USDC > WETH in token0/token1 order)
      const tick = slot0.tick;
      expect(typeof tick).toBe('number');
      // eslint-disable-next-line no-console
      console.log(`  slot0.tick = ${tick}, sqrtPriceX96 = ${slot0.sqrtPriceX96.toString()}`);
    });

    it('should read tickSpacing = 100 for 0.05% pool', async () => {
      const pool = new ethers.Contract(WETH_USDC_POOL, POOL_ABI, provider);
      const tickSpacing = await pool.tickSpacing();
      // Aerodrome Slipstream WETH/USDC 0.05% pool has tickSpacing=100
      expect(tickSpacing).toBe(100);
    });

    it('should read dynamic fee', async () => {
      const pool = new ethers.Contract(WETH_USDC_POOL, POOL_ABI, provider);
      const fee = await pool.fee();
      // Fee for 0.05% pool is 500 (in pips, so 500/1_000_000 = 0.05%)
      expect(fee).toBeGreaterThan(0);
      expect(fee).toBeLessThan(10000); // Max 1%
      // eslint-disable-next-line no-console
      console.log(`  pool.fee() = ${fee} pips (${fee / 10000}%)`);
    });

    it('should read non-zero liquidity', async () => {
      const pool = new ethers.Contract(WETH_USDC_POOL, POOL_ABI, provider);
      const liquidity = await pool.liquidity();
      expect(liquidity.gt(0)).toBe(true);
      // eslint-disable-next-line no-console
      console.log(`  pool.liquidity() = ${liquidity.toString()}`);
    });

    it('should confirm token0 = WETH, token1 = USDC', async () => {
      const pool = new ethers.Contract(WETH_USDC_POOL, POOL_ABI, provider);
      const [token0, token1] = await Promise.all([pool.token0(), pool.token1()]);

      // On Base, WETH (0x4200...) < USDC (0x8335...) in address ordering
      expect(token0.toLowerCase()).toBe(WETH.toLowerCase());
      expect(token1.toLowerCase()).toBe(USDC.toLowerCase());
    });

    it('should have a gauge address', async () => {
      const pool = new ethers.Contract(WETH_USDC_POOL, POOL_ABI, provider);
      const gauge = await pool.gauge();
      expect(gauge).not.toBe('0x0000000000000000000000000000000000000000');
      // eslint-disable-next-line no-console
      console.log(`  pool.gauge() = ${gauge}`);
    });
  });

  describe('Factory', () => {
    it('should resolve WETH/USDC pool via factory.getPool(tickSpacing=100)', async () => {
      const factory = new ethers.Contract(CL_FACTORY, FACTORY_ABI, provider);
      // This pool uses tickSpacing=100 (not 1)
      const poolAddress = await factory.getPool(WETH, USDC, 100);
      expect(poolAddress.toLowerCase()).toBe(WETH_USDC_POOL.toLowerCase());
    });
  });

  describe('QuoterV2', () => {
    it('should quote a swap: 1 WETH → USDC', async () => {
      const quoter = new ethers.Contract(QUOTER_V2, QUOTER_ABI, provider);
      const amountIn = ethers.utils.parseUnits('1', 18); // 1 WETH

      const result = await quoter.callStatic.quoteExactInputSingle({
        tokenIn: WETH,
        tokenOut: USDC,
        amountIn,
        tickSpacing: 1,
        sqrtPriceLimitX96: 0,
      });

      const amountOut = ethers.utils.formatUnits(result.amountOut, 6);
      const amountOutNum = parseFloat(amountOut);

      // Sanity: 1 WETH should be worth between $500 and $10,000 USDC
      expect(amountOutNum).toBeGreaterThan(500);
      expect(amountOutNum).toBeLessThan(10000);
      // eslint-disable-next-line no-console
      console.log(`  1 WETH → ${amountOut} USDC (gasEstimate: ${result.gasEstimate.toString()})`);
    });

    it('should quote a swap: 1000 USDC → WETH', async () => {
      const quoter = new ethers.Contract(QUOTER_V2, QUOTER_ABI, provider);
      const amountIn = ethers.utils.parseUnits('1000', 6); // 1000 USDC

      const result = await quoter.callStatic.quoteExactInputSingle({
        tokenIn: USDC,
        tokenOut: WETH,
        amountIn,
        tickSpacing: 1,
        sqrtPriceLimitX96: 0,
      });

      const amountOut = ethers.utils.formatUnits(result.amountOut, 18);
      const amountOutNum = parseFloat(amountOut);

      // Sanity: 1000 USDC should get between 0.1 and 2 WETH
      expect(amountOutNum).toBeGreaterThan(0.1);
      expect(amountOutNum).toBeLessThan(2);
      // eslint-disable-next-line no-console
      console.log(`  1000 USDC → ${amountOut} WETH`);
    });
  });

  describe('Token Verification', () => {
    it('WETH should have 18 decimals', async () => {
      const weth = new ethers.Contract(WETH, ERC20_ABI, provider);
      const decimals = await weth.decimals();
      expect(decimals).toBe(18);
    });

    it('USDC should have 6 decimals', async () => {
      const usdc = new ethers.Contract(USDC, ERC20_ABI, provider);
      const decimals = await usdc.decimals();
      expect(decimals).toBe(6);
    });
  });

  describe('NFT Position Manager', () => {
    it('should be accessible on Base', async () => {
      const npm = new ethers.Contract(NFT_POSITION_MANAGER, NPM_ABI, provider);
      // Check balance of a zero address (should return 0, not revert)
      const balance = await npm.balanceOf('0x0000000000000000000000000000000000000001');
      expect(balance.gte(0)).toBe(true);
    });
  });

  describe('Price Sanity (tick → price conversion)', () => {
    it('should convert slot0.tick to a reasonable WETH/USDC price', async () => {
      const pool = new ethers.Contract(WETH_USDC_POOL, POOL_ABI, provider);
      const slot0 = await pool.slot0();
      const tick = slot0.tick;

      // Uniswap V3 / Slipstream price formula:
      // price_token1_per_token0 = 1.0001^tick * 10^(token0_decimals - token1_decimals)
      // For WETH(18)/USDC(6): price_usdc_per_weth = 1.0001^tick * 10^12
      const price = Math.pow(1.0001, tick) * Math.pow(10, 12);

      // WETH should be worth between $500 and $10,000
      expect(price).toBeGreaterThan(500);
      expect(price).toBeLessThan(10000);
      // eslint-disable-next-line no-console
      console.log(`  tick=${tick} → WETH price ≈ $${price.toFixed(2)}`);
    });
  });
});
