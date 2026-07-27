#!/usr/bin/env bash
# End-to-end dry run of the ceremony tooling on the smallest shape (1x1),
# using a tiny throwaway ptau. Proves the full flow works without touching
# the real ceremony/ state:
#
#   init → 2 contributions → finalize (mock beacon) → verify --full
#   → negative test (tampered manifest must FAIL verification)
#
# Everything happens in a temp dir; nothing is committed.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "[test] workspace: $TMP"

# ── Tiny throwaway ptau (power 15 covers 1x1's ~20.3k constraints) ──
export PTAU_POWER=15
export PTAU_FILE="$TMP/pot15_test.ptau"
echo "[test] generating throwaway ptau (power $PTAU_POWER)..."
echo "test-only-entropy-$(date +%s%N)" | (cd "$ROOT" && npx --no-install snarkjs powersoftau new bn128 "$PTAU_POWER" "$TMP/pot0.ptau") >/dev/null 2>&1
echo "test-only-contribution-$(date +%s%N)" | (cd "$ROOT" && npx --no-install snarkjs powersoftau contribute "$TMP/pot0.ptau" "$TMP/pot1.ptau" --name="test") >/dev/null 2>&1
(cd "$ROOT" && npx --no-install snarkjs powersoftau prepare phase2 "$TMP/pot1.ptau" "$PTAU_FILE") >/dev/null 2>&1
export PTAU_SHA256="$(shasum -a 256 "$PTAU_FILE" | awk '{print $1}')"

# ── Isolated ceremony state, single shape ────────────────────
export CEREMONY_DIR="$TMP/ceremony"
export CEREMONY_SHAPES="1x1"
mkdir -p "$CEREMONY_DIR"

step() { echo ""; echo "[test] ══ $* ══"; }

step "init"
"$SCRIPT_DIR/init.sh" --announce-height 99999999

step "contribution 1 (alice)"
CEREMONY_ENTROPY="alice-test-entropy-not-secret" "$SCRIPT_DIR/contribute.sh" 1x1 alice

step "contribution 2 (bob)"
CEREMONY_ENTROPY="bob-test-entropy-not-secret" "$SCRIPT_DIR/contribute.sh" 1x1 bob

# Point manifest URLs at local files (exercises the download+hash path).
echo "[test] filling zkeyUrl values with file:// URLs"
tmp="$(mktemp)"
jq --arg d "$CEREMONY_DIR" '
  .shapes["1x1"].contributions |= map(
    if .index == 0 then .zkeyUrl = "\($d)/1x1/0000.zkey"
    else .zkeyUrl = "\($d)/1x1/\(.index | tostring | ("000" + .) | .[-4:]).zkey"
    end | .zkeyUrl = "file://" + .zkeyUrl
  )' "$CEREMONY_DIR/manifest.json" > "$tmp"
mv "$tmp" "$CEREMONY_DIR/manifest.json"

step "finalize (mock beacon)"
CEREMONY_BEACON_HASH="000000000000000000000000000000000000000000000000000000000000beef" \
CEREMONY_BEACON_HEIGHT=99999999 \
  "$SCRIPT_DIR/finalize.sh" 1x1

[ -f "$CEREMONY_DIR/1x1/final.zkey" ] || { echo "[test] FAIL: no final.zkey"; exit 1; }
[ -f "$CEREMONY_DIR/1x1/vkey.json" ]  || { echo "[test] FAIL: no vkey.json"; exit 1; }
[ "$(jq -r '.shapes["1x1"].status' "$CEREMONY_DIR/manifest.json")" = "finalized" ] \
  || { echo "[test] FAIL: shape not finalized in manifest"; exit 1; }

step "verify --full (incl. beacon recompute)"
"$SCRIPT_DIR/verify.sh" 1x1 --full

step "negative test: tampered manifest must fail"
cp "$CEREMONY_DIR/manifest.json" "$TMP/manifest.good.json"
tmp="$(mktemp)"
jq '.shapes["1x1"].contributions[1].zkeySha256 = "deadbeef"' "$CEREMONY_DIR/manifest.json" > "$tmp"
mv "$tmp" "$CEREMONY_DIR/manifest.json"
if "$SCRIPT_DIR/verify.sh" 1x1 >/dev/null 2>&1; then
  echo "[test] FAIL: verify accepted a tampered manifest"
  exit 1
fi
echo "[test] tampered manifest correctly rejected"
cp "$TMP/manifest.good.json" "$CEREMONY_DIR/manifest.json"

echo ""
echo "[test] ALL PASS — ceremony tooling works end-to-end"
