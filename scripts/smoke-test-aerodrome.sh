#!/bin/bash
# ─────────────────────────────────────────────────────────────────
# Aerodrome Slipstream CLMM — Live Smoke Test on Base
#
# Prerequisites:
#   1. Gateway running: pnpm start --dev
#   2. Wallet imported with ETH + USDC on Base
#
# Usage:
#   # Phase 1 — Read-only (no wallet needed):
#   bash scripts/smoke-test-aerodrome.sh readonly
#
#   # Phase 2 — Full test with swap (needs wallet):
#   bash scripts/smoke-test-aerodrome.sh full <walletAddress>
# ─────────────────────────────────────────────────────────────────

set -euo pipefail

GW="http://localhost:15888"
POOL="0xb2cc224c1c9fee385f8ad6a55b4d94e92359dc59"
MODE="${1:-readonly}"
WALLET="${2:-}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass=0
fail=0

check() {
  local name="$1"
  local url="$2"
  local method="${3:-GET}"
  local body="${4:-}"

  echo -n "  $name ... "

  local tmpfile
  tmpfile=$(mktemp)

  if [ "$method" = "GET" ]; then
    code=$(curl -s -o "$tmpfile" -w "%{http_code}" "$url")
  else
    code=$(curl -s -o "$tmpfile" -w "%{http_code}" -X POST "$url" -H "Content-Type: application/json" -d "$body")
  fi

  body_resp=$(cat "$tmpfile")
  rm -f "$tmpfile"

  if [ "$code" = "200" ]; then
    echo -e "${GREEN}✓${NC} (HTTP $code)"
    ((pass++))
    # Print key fields
    echo "$body_resp" | python3 -m json.tool 2>/dev/null | head -15
    echo ""
  else
    echo -e "${RED}✗${NC} (HTTP $code)"
    ((fail++))
    echo "$body_resp" | python3 -m json.tool 2>/dev/null | head -10
    echo ""
  fi
}

echo ""
echo "═══════════════════════════════════════════════════════"
echo " Aerodrome Slipstream CLMM — Live Smoke Test"
echo " Pool: WETH/USDC 0.05% on Base"
echo " Mode: $MODE"
echo "═══════════════════════════════════════════════════════"
echo ""

# ── Phase 1: Read-only endpoints ──
echo -e "${YELLOW}Phase 1: Read-only endpoints${NC}"
echo "───────────────────────────────────────────────────────"

check "GET /config/connectors (aerodrome listed)" \
  "$GW/config/connectors"

check "GET /connectors/aerodrome/clmm/pool-info" \
  "$GW/connectors/aerodrome/clmm/pool-info?network=base&poolAddress=$POOL&baseToken=WETH&quoteToken=USDC"

check "GET /connectors/aerodrome/clmm/quote-swap (SELL 0.001 WETH)" \
  "$GW/connectors/aerodrome/clmm/quote-swap?network=base&poolAddress=$POOL&baseToken=WETH&quoteToken=USDC&amount=0.001&side=SELL"

check "GET /connectors/aerodrome/clmm/quote-swap (BUY 5 USDC)" \
  "$GW/connectors/aerodrome/clmm/quote-swap?network=base&poolAddress=$POOL&baseToken=WETH&quoteToken=USDC&amount=5&side=BUY"

# ── Phase 2: Wallet-dependent endpoints ──
if [ "$MODE" = "full" ] && [ -n "$WALLET" ]; then
  echo ""
  echo -e "${YELLOW}Phase 2: Wallet-dependent endpoints${NC}"
  echo "───────────────────────────────────────────────────────"

  check "GET /chains/ethereum/balances" \
    "$GW/chains/ethereum/balances?network=base&address=$WALLET"

  check "GET /connectors/aerodrome/clmm/positions-owned" \
    "$GW/connectors/aerodrome/clmm/positions-owned?network=base&walletAddress=$WALLET&poolAddress=$POOL&baseToken=WETH&quoteToken=USDC"

  # Small swap: sell 0.001 WETH (~$2) for USDC
  echo ""
  echo -e "${YELLOW}Phase 3: Execute small swap (0.001 WETH → USDC)${NC}"
  echo "───────────────────────────────────────────────────────"
  echo -e "  ${RED}WARNING: This sends a REAL transaction on Base mainnet!${NC}"
  read -p "  Continue? (y/N) " confirm
  if [ "$confirm" = "y" ] || [ "$confirm" = "Y" ]; then
    check "POST /connectors/aerodrome/clmm/execute-swap" \
      "$GW/connectors/aerodrome/clmm/execute-swap" \
      "POST" \
      "{\"network\":\"base\",\"walletAddress\":\"$WALLET\",\"baseToken\":\"WETH\",\"quoteToken\":\"USDC\",\"amount\":0.001,\"side\":\"SELL\",\"poolAddress\":\"$POOL\",\"slippagePct\":2}"
  else
    echo "  Skipped."
  fi

elif [ "$MODE" = "full" ]; then
  echo ""
  echo -e "${RED}ERROR: Wallet address required for full mode${NC}"
  echo "  Usage: bash scripts/smoke-test-aerodrome.sh full <walletAddress>"
fi

# ── Summary ──
echo ""
echo "═══════════════════════════════════════════════════════"
echo -e " Results: ${GREEN}$pass passed${NC}, ${RED}$fail failed${NC}"
echo "═══════════════════════════════════════════════════════"
echo ""

[ $fail -eq 0 ] && exit 0 || exit 1
