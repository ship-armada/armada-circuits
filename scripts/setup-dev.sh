#!/usr/bin/env bash
set -euo pipefail

# Development trusted setup.
# WARNING: This produces an UNSAFE deterministic setup suitable only for local
# testing and CI. Production artifacts require a secure multi-party ceremony.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
BUILD_DIR="$ROOT/build"
PTAU_DIR="$BUILD_DIR/ptau"

# Circuits come from circuits.json (via the compiled registry CLI).
# Pass circuit ids to set up only those, e.g. `npm run setup:dev -- 2x2`.
REGISTRY_CLI="$ROOT/dist/src/registry-cli.js"
if [ ! -f "$REGISTRY_CLI" ]; then
  echo "Missing $REGISTRY_CLI — run 'npm run build' (npm ci runs it automatically)." >&2
  exit 1
fi
CIRCUITS="$(node "$REGISTRY_CLI" list "$@")"

echo "Running development trusted setup..."

mkdir -p "$PTAU_DIR"

# Phase 1: Powers of Tau, one file per power, shared by every circuit that
# needs it. Power 17 = 2^17 = 131072 constraints max; the largest shape (8x4)
# has ~94.2k constraints. A pre-placed build/ptau/pot<power>_final.ptau (e.g.
# the Hermez ptau, as CI does) is used as-is.
ensure_ptau() {
  local power="$1"
  local pot_file="$PTAU_DIR/pot${power}_final.ptau"
  if [ ! -f "$pot_file" ]; then
    echo "Phase 1: Powers of Tau (bn128, power ${power})..." >&2
    echo "armada-dev-entropy" | snarkjs powersoftau new bn128 "$power" "$PTAU_DIR/pot${power}_0000.ptau" >&2
    echo "armada-contribution-entropy" | snarkjs powersoftau contribute "$PTAU_DIR/pot${power}_0000.ptau" \
      "$PTAU_DIR/pot${power}_0001.ptau" --name="dev" >&2
    snarkjs powersoftau prepare phase2 "$PTAU_DIR/pot${power}_0001.ptau" \
      "$pot_file" >&2
    echo "  → $pot_file" >&2
  else
    echo "Phase 1: Using existing $pot_file" >&2
  fi
  printf '%s\n' "$pot_file"
}

# Phase 2: Per-circuit zkey generation
while IFS=$'\t' read -r id entry power; do
  ZKEY_DIR="$BUILD_DIR/$id"
  R1CS="$ZKEY_DIR/$(basename "$entry" .circom).r1cs"

  if [ ! -f "$R1CS" ]; then
    echo "  SKIP $id (no .r1cs — run compile first)"
    continue
  fi

  POT_FILE="$(ensure_ptau "$power")"
  echo "Phase 2: $id..."

  # Initial zkey (ceremony start)
  snarkjs groth16 setup "$R1CS" "$POT_FILE" "$ZKEY_DIR/0000.zkey"

  # Contribution
  echo "armada-zkey-contribution" | snarkjs zkey contribute "$ZKEY_DIR/0000.zkey" \
    "$ZKEY_DIR/final.zkey" --name="dev"

  # Export verification key
  snarkjs zkey export verificationkey "$ZKEY_DIR/final.zkey" \
    "$ZKEY_DIR/vkey.json"

  echo "  → $ZKEY_DIR/final.zkey"
  echo "  → $ZKEY_DIR/vkey.json"
done <<< "$CIRCUITS"

echo "Dev setup complete."
echo "WARNING: These keys are NOT secure. Do not use on mainnet."
