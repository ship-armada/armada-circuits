#!/usr/bin/env bash
set -euo pipefail

# Development trusted setup.
# WARNING: This produces an UNSAFE deterministic setup suitable only for local
# testing and CI. Production artifacts require a secure multi-party ceremony.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
BUILD_DIR="$ROOT/build"
PTAU_DIR="$BUILD_DIR/ptau"

# Shapes to set up (only those with compiled .r1cs files)
SHAPES=("1x2")  # Start with 1x2; add more as entry points are created

echo "Running development trusted setup..."

mkdir -p "$PTAU_DIR"

# Phase 1: Powers of Tau (shared across all circuits)
# Power 15 = 2^15 = 32768 constraints max. Sufficient for all planned circuit shapes.
# The largest shape (8x4) is estimated at ~150k constraints — increase to 18 if needed.
POT_POWER=15
POT_FILE="$PTAU_DIR/pot${POT_POWER}_final.ptau"

if [ ! -f "$POT_FILE" ]; then
  echo "Phase 1: Powers of Tau (bn128, power ${POT_POWER})..."
  echo "armada-dev-entropy" | snarkjs powersoftau new bn128 $POT_POWER "$PTAU_DIR/pot${POT_POWER}_0000.ptau"
  echo "armada-contribution-entropy" | snarkjs powersoftau contribute "$PTAU_DIR/pot${POT_POWER}_0000.ptau" \
    "$PTAU_DIR/pot${POT_POWER}_0001.ptau" --name="dev"
  snarkjs powersoftau prepare phase2 "$PTAU_DIR/pot${POT_POWER}_0001.ptau" \
    "$POT_FILE"
  echo "  → $POT_FILE"
else
  echo "Phase 1: Using existing $POT_FILE"
fi
  echo "  → $POT_FILE"
else
  echo "Phase 1: Using existing $POT_FILE"
fi

# Phase 2: Per-circuit zkey generation
for shape in "${SHAPES[@]}"; do
  R1CS="$BUILD_DIR/$shape/main_${shape}.r1cs"
  ZKEY_DIR="$BUILD_DIR/$shape"

  if [ ! -f "$R1CS" ]; then
    echo "  SKIP $shape (no .r1cs — run compile first)"
    continue
  fi

  echo "Phase 2: $shape..."

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
done

echo "Dev setup complete."
echo "WARNING: These keys are NOT secure. Do not use on mainnet."
