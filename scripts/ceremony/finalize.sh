#!/usr/bin/env bash
# Coordinator: finalize a shape (or all shapes) with the public random
# beacon, after the last contribution is merged.
#
# Usage:
#   finalize.sh <shape|--all>
#
# Beacon: the keccak block hash of Ethereum mainnet block
# .beacon.announcedHeight from the manifest (pre-committed before the
# ceremony was announced). The first finalized shape records the resolved
# block hash in the manifest; subsequent shapes reuse it, so all shapes
# share one publicly reproducible beacon.
#
# $ETH_RPC_URL overrides the Ethereum RPC endpoint (default: public LlamaRPC).
#
# TESTING ONLY: $CEREMONY_BEACON_HASH skips the chain lookup and uses the
# given hash directly. Never set this for the real ceremony.

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

TARGET="${1:?usage: finalize.sh <shape|--all>}"

need_cmd jq
require_manifest
check_ptau

if [ "$TARGET" = "--all" ]; then
  FIN_SHAPES=($(jq -r '.shapes | to_entries[] | select(.value.status == "open") | .key' "$MANIFEST"))
else
  FIN_SHAPES=("$TARGET")
fi
[ "${#FIN_SHAPES[@]}" -gt 0 ] || die "no open shapes to finalize"

# ── Resolve beacon ───────────────────────────────────────────
BEACON_ITER_EXP=10
BLOCK_HASH="$(mget '.beacon.blockHash')"
BLOCK_HEIGHT="$(mget '.beacon.blockHeight')"

if [ -n "${CEREMONY_BEACON_HASH:-}" ]; then
  log "WARNING: CEREMONY_BEACON_HASH override set — TESTING ONLY, never for the real ceremony"
  BLOCK_HASH="$CEREMONY_BEACON_HASH"
  BLOCK_HEIGHT="${CEREMONY_BEACON_HEIGHT:-0}"
elif [ "$BLOCK_HASH" = "null" ] || [ -z "$BLOCK_HASH" ]; then
  HEIGHT="$(mget '.beacon.announcedHeight')"
  [ "$HEIGHT" != "null" ] && [ -n "$HEIGHT" ] \
    || die "no beacon announcedHeight in manifest — run init.sh --announce-height <H>"
  need_cmd cast
  RPC="${ETH_RPC_URL:-https://eth.llamarpc.com}"
  log "fetching beacon: Ethereum mainnet block $HEIGHT ($RPC)"
  BLOCK_HASH="$(cast block "$HEIGHT" --rpc-url "$RPC" --json | jq -r '.hash')"
  [ -n "$BLOCK_HASH" ] && [ "$BLOCK_HASH" != "null" ] \
    || die "could not fetch block $HEIGHT — is it produced yet?"
  BLOCK_HEIGHT="$HEIGHT"
fi

# Record the beacon in the manifest if it isn't recorded yet (first
# finalized shape wins; subsequent shapes reuse it).
if [ "$(mget '.beacon.blockHash')" = "null" ]; then
  tmp="$(mktemp)"
  jq --argjson h "$BLOCK_HEIGHT" --arg hash "$BLOCK_HASH" \
    '.beacon.blockHeight = $h | .beacon.blockHash = $hash' "$MANIFEST" > "$tmp"
  mv "$tmp" "$MANIFEST"
  log "  beacon recorded in manifest: block $BLOCK_HEIGHT hash $BLOCK_HASH"
fi

BEACON_HEX="${BLOCK_HASH#0x}"
[[ "$BEACON_HEX" =~ ^[0-9a-fA-F]{64}$ ]] || die "invalid beacon hash: $BLOCK_HASH"

# ── Finalize each shape ──────────────────────────────────────
for shape in "${FIN_SHAPES[@]}"; do
  log "── $shape ──────────────────────────────"
  [ "$(shape_status "$shape")" = "open" ] || { log "    already finalized, skipping"; continue; }

  LATEST="$(shape_latest_index "$shape")"
  [ "$LATEST" -ge 1 ] || die "$shape: no public contributions yet (only coordinator setup)"

  LATEST_PAD="$(printf '%04d' "$LATEST")"
  IN_ZKEY="$(zkey_for "$shape" "$LATEST_PAD")"
  [ -f "$IN_ZKEY" ] || die "$shape: latest zkey $IN_ZKEY not found locally — download it from its manifest zkeyUrl"

  WANT_IN_SHA="$(jq -r --arg s "$shape" --argjson i "$LATEST" \
    '.shapes[$s].contributions[] | select(.index==$i) | .zkeySha256' "$MANIFEST")"
  [ "$(sha256 "$IN_ZKEY")" = "$WANT_IN_SHA" ] || die "$shape: latest zkey checksum mismatch vs manifest"

  FINAL_ZKEY="$CEREMONY_DIR/$shape/final.zkey"
  VKEY="$CEREMONY_DIR/$shape/vkey.json"

  log "    applying beacon to contribution #$LATEST..."
  snarkjs zkey beacon "$IN_ZKEY" "$FINAL_ZKEY" "$BEACON_HEX" "$BEACON_ITER_EXP"

  log "    verifying finalized chain..."
  R1CS="$(r1cs_for "$shape")"
  snarkjs zkey verify "$R1CS" "$PTAU_FILE" "$FINAL_ZKEY" >/dev/null \
    || die "$shape: final zkey failed verification"

  log "    exporting verification key..."
  snarkjs zkey export verificationkey "$FINAL_ZKEY" "$VKEY"

  FINAL_SHA="$(sha256 "$FINAL_ZKEY")"
  VKEY_SHA="$(sha256 "$VKEY")"

  # Per-shape checksum manifest (ships with the release).
  {
    echo "$FINAL_SHA  final.zkey"
    echo "$VKEY_SHA  vkey.json"
    [ -f "$R1CS" ] && echo "$(sha256 "$R1CS")  main_${shape}.r1cs"
    WASM="$BUILD_DIR/$shape/main_${shape}_js/main_${shape}.wasm"
    [ -f "$WASM" ] && echo "$(sha256 "$WASM")  main_${shape}.wasm"
  } > "$CEREMONY_DIR/$shape/SHA256SUMS"

  tmp="$(mktemp)"
  jq --arg s "$shape" \
     --arg zsha "$FINAL_SHA" \
     --arg vsha "$VKEY_SHA" \
     --argjson iter "$BEACON_ITER_EXP" \
     --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
     '.shapes[$s].status = "finalized" |
      .shapes[$s].final = {
        zkeySha256: $zsha,
        vkeySha256: $vsha,
        zkeyUrl: null,
        beaconIterationsExp: $iter,
        finalizedAt: $ts
      }' "$MANIFEST" > "$tmp"
  mv "$tmp" "$MANIFEST"

  log "    final.zkey sha256: $FINAL_SHA"
  log "    vkey.json sha256:  $VKEY_SHA"
done

log ""
log "Finalization complete."
log "Anyone can reproduce: verify.sh <shape> --full"
log "Next: cut the production release (see docs/CEREMONY.md — 'Cutting the release')."
