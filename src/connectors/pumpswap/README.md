# PumpSwap connector (pump.fun AMM)

**A-layer of the no-route SELL fallback (2026-06-30).** Lets the meme-sniper bot
sell straight into a known PumpSwap pool, bypassing the Jupiter router. Forensic
(quants-lab `L3_NOROUTE_CAUSE_2026-06-30`) showed Jupiter "no-route"/429 on sells
is ~100% a client-side routing/index failure while the pool is ALIVE and others
keep selling on-chain. Pairs with the bot B-layer (`deploy/meme-sniper`, default
**OFF**: `pumpswap_fallback_enabled`).

> ⚠ This is an **execution fix (减亏 / loss-reduction)**, not alpha. It removes the
> no-route realized-loss term; μ_G<0 and the 7.87pp taker spread floor are
> unchanged. It does not make the strategy profitable — only stops leaving SOL
> stuck when Jupiter can't route a sell.

## What it does

- Wraps the official `@pump-fun/pump-swap-sdk` (web3.js v1 — same stack as the gateway).
- `OnlinePumpAmmSdk` fetches live pool state; `PumpAmmSdk` builds swap instructions
  (incl. WSOL wrap/unwrap → user receives native SOL on SELL).
- Signing / simulate / send / confirm all reuse the shared `Solana` chain class, so
  confirmation semantics, phantom-sell guards and the response shape are **identical**
  to the raydium/AMM path. The response is exactly what the bot already parses
  (`{signature, status, data:{amountOut, …}}`).

## Endpoints (`/connectors/pumpswap/amm/*`)

| Method | Route | Purpose |
|---|---|---|
| POST | `/execute-swap` | SELL (token→SOL) / BUY (SOL→token) into an explicit `poolAddress`. The bot calls this. |
| GET | `/quote-swap` | Price/amountOut estimate (validation/debug). |
| GET | `/pool-info` | Pool reserves / price / fee. |

`poolAddress` is **required** (no symbol→pool lookup). The bot already records the
canonical pump pool at graduation (`pos.token.pool_address`). `baseToken` must match
the pool's base mint or the request is rejected (safe — the bot then re-raises the
original Jupiter error to its normal handler).

## Deploy

This connector is **image-baked** (TypeScript compiled into the gateway image) —
a gateway image rebuild + restart is required; a bot restart alone does nothing.

1. **Rebuild + push the gateway image** (multiarch, amd64 for the VPS):
   `make release-multiarch` (or the repo's gateway build target) → push `firenirva/gateway`.
2. **Host-mount config** (`pumpswap.yml`, slippage) — copy to the **gateway**
   container's mounted `conf/connectors/` on the host (NOT the bot's conf dir) and
   restart the gateway container. Template: `src/templates/connectors/pumpswap.yml`;
   deploy copy: `deploy/meme-sniper/gateway/conf/connectors/pumpswap.yml`.
3. **Enable the bot fallback** only after the gateway is confirmed serving the route:
   set `pumpswap_fallback_enabled: true` in the bot config (`is_updatable`).

## Gray validation (before enabling live)

1. Gateway up with the route: `GET /connectors/pumpswap/amm/pool-info?poolAddress=<known-pool>` returns reserves.
2. On a known "Jupiter no-route but others selling on-chain" mint, `quote-swap` returns a
   sane SOL amountOut; then a **tiny** `execute-swap` SELL confirms on-chain.
3. After enabling: watch `sell_pumpswap_fallback_attempt/ok/fail` latency events and the
   `*_rug_no_route` terminal rate (target → ~0); confirm no double-sell (phantom guard).

## Known hardening TODO (not blockers)

- `execute-swap` SELL uses the caller's `amount`; if the bot's tracked token_amount
  float-drifts above the on-chain ATA balance the tx fails (same risk as the Jupiter
  path). Could clamp to the on-chain base ATA balance for extra robustness.
- BUY direction is implemented for completeness but **unused** by the bot and unverified
  on-chain; only SELL is the supported fallback path.
