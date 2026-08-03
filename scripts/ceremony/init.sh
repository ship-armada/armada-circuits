#!/usr/bin/env bash
# Coordinator, one-time: initialize Phase 2 of the ceremony.
#
# For every circuit shape:
#   snarkjs groth16 setup <r1cs> <ptau> -> ceremony/<shape>/0000.zkey
#
# Also (re)generates ceremony/manifest.json — the ceremony state of record —
# recording ptau provenance, per-shape r1cs/wasm checksums, the 0000.zkey
# checksum, and the beacon rule. Safe to re-run: shapes whose 0000.zkey
# already exists are skipped (checksum re-validated).
#
# Usage:
#   init.sh [--announce-height <ethereum-block-height>]
#
#   --announce-height   pre-commit the beacon block height (must be set
#                       before the ceremony is announced publicly).

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

ANNOUNCE_HEIGHT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --announce-height) ANNOUNCE_HEIGHT="${2:?missing height}"; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done

need_cmd jq
check_ptau

mkdir -p "$CEREMONY_DIR"

BEACON_RULE="After the final public contribution is merged, each shape is finalized with a random beacon: the keccak block hash of the first Ethereum mainnet block at or after the announced height. Anyone can recompute the final zkey from the last contribution and the published block hash."

# ── Create manifest skeleton if missing ──────────────────────
if [ ! -f "$MANIFEST" ]; then
  log "creating manifest: $MANIFEST"
  jq -n \
    --arg name "armada-circuits-v1-ceremony" \
    --arg created "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg ptauSource "$PTAU_URL" \
    --arg ptauFile "${PTAU_FILE#"$ROOT"/}" \
    --arg ptauSha "$PTAU_SHA256" \
    --argjson ptauPower "$PTAU_POWER" \
    --arg beaconRule "$BEACON_RULE" \
    '{
      version: 1,
      name: $name,
      created: $created,
      ptau: {
        source: $ptauSource,
        file: $ptauFile,
        sha256: $ptauSha,
        power: $ptauPower
      },
      beacon: {
        type: "ethereum-block-hash",
        chain: "ethereum-mainnet",
        rule: $beaconRule,
        announcedHeight: null,
        blockHeight: null,
        blockHash: null
      },
      shapes: {}
    }' > "$MANIFEST"
fi

# Optionally set/update the announced beacon height.
if [ -n "$ANNOUNCE_HEIGHT" ]; then
  [[ "$ANNOUNCE_HEIGHT" =~ ^[0-9]+$ ]] || die "invalid height: $ANNOUNCE_HEIGHT"
  log "announcing beacon height: $ANNOUNCE_HEIGHT"
  tmp="$(mktemp)"
  jq --argjson h "$ANNOUNCE_HEIGHT" '.beacon.announcedHeight = $h' "$MANIFEST" > "$tmp"
  mv "$tmp" "$MANIFEST"
fi

# ── Phase 2 setup per shape ──────────────────────────────────
for shape in "${SHAPES[@]}"; do
  R1CS="$(r1cs_for "$shape")"
  WASM="$BUILD_DIR/$shape/main_${shape}_js/main_${shape}.wasm"
  ZKEY0="$(zkey_for "$shape" 0000)"

  [ -f "$R1CS" ] || { log "  SKIP $shape (no .r1cs — run npm run compile first)"; continue; }
  mkdir -p "$CEREMONY_DIR/$shape"

  if [ -f "$ZKEY0" ]; then
    log "  $shape: 0000.zkey exists, keeping"
  else
    log "  $shape: groth16 setup..."
    snarkjs groth16 setup "$R1CS" "$PTAU_FILE" "$ZKEY0"
  fi

  R1CS_SHA="$(sha256 "$R1CS")"
  ZKEY0_SHA="$(sha256 "$ZKEY0")"
  if [ -f "$WASM" ]; then WASM_SHA="$(sha256 "$WASM")"; else WASM_SHA=""; fi

  # Upsert shape entry: preserve existing contributions if the shape is
  # already tracked (re-runs are checksum re-validation, not a reset).
  tmp="$(mktemp)"
  jq --arg s "$shape" \
     --arg r1csSha "$R1CS_SHA" \
     --arg wasmSha "$WASM_SHA" \
     --arg zkey0Sha "$ZKEY0_SHA" \
     '
     .shapes[$s] as $existing |
     .shapes[$s] = {
       status: ($existing.status // "open"),
       r1csSha256: $r1csSha,
       wasmSha256: $wasmSha,
       contributions: (
         if ($existing.contributions // []) | length > 0
         then $existing.contributions
         else [{
           index: 0,
           type: "setup",
           name: "coordinator",
           zkeySha256: $zkey0Sha,
           zkeyUrl: null
         }]
         end
       ),
       final: ($existing.final // null)
     }' "$MANIFEST" > "$tmp"
  mv "$tmp" "$MANIFEST"

  # Re-validate: tracked 0000 checksum must match the file on disk.
  tracked="$(jq -r --arg s "$shape" '.shapes[$s].contributions[0].zkeySha256' "$MANIFEST")"
  [ "$tracked" = "$ZKEY0_SHA" ] || die "$shape: existing 0000.zkey does not match manifest ($ZKEY0_SHA vs $tracked)"

  log "  $shape: 0000.zkey sha256=$ZKEY0_SHA"
done

log ""
log "Init complete. Manifest: $MANIFEST"
if [ "$(mget '.beacon.announcedHeight')" = "null" ]; then
  log "NOTE: beacon height not announced yet — re-run with --announce-height <H> before the public announcement."
fi
log "Next: publish 0000.zkey files (e.g. as pre-release assets) and record zkeyUrl values in the manifest."
