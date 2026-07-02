#!/usr/bin/env bash
set -euo pipefail

# Development trusted setup.
# WARNING: This produces an UNSAFE deterministic setup suitable only for local
# testing and CI. Production artifacts require a secure multi-party ceremony.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
BUILD_DIR="$ROOT/build"
PTAU_DIR="$BUILD_DIR/ptau"

# All circuit shapes (must match compile.sh)
SHAPES=(
  "1,1" "1,2" "2,2" "2,3" "8,4"
  "2,1" "3,1" "4,1" "5,1" "6,1" "7,1" "8,1"
  "3,2" "4,2" "5,2" "6,2"
  "1,3" "3,3" "4,3"
)

echo "Running development trusted setup..."

mkdir -p "$PTAU_DIR"

# Phase 1: Powers of Tau (shared across all circuits)
# Power 17 = 2^17 = 131072 constraints max. Covers all 19 shapes.
# Largest shape (8x4) has ~92.6k constraints.
POT_POWER=17
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

# Phase 2: Per-circuit zkey generation
for shape_csv in "${SHAPES[@]}"; do
  IFS=',' read -r n m <<< "$shape_csv"
  shape="${n}x${m}"
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
