#!/usr/bin/env bash
set -euo pipefail

# Development trusted setup.
# WARNING: This produces an UNSAFE deterministic setup suitable only for local
# testing and CI. Production artifacts require a secure multi-party ceremony.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
BUILD_DIR="$ROOT/build"
PTAU_DIR="$BUILD_DIR/ptau"

echo "Running development trusted setup..."

mkdir -p "$PTAU_DIR"

# Placeholder: once circuits are compiled, run snarkjs powers-of-tau and
# phase-2 contributions per circuit shape.
#
# Example:
# snarkjs powersoftau new bn128 17 "$PTAU_DIR/pot17_0000.ptau"
# snarkjs powersoftau contribute "$PTAU_DIR/pot17_0000.ptau" \
#   "$PTAU_DIR/pot17_0001.ptau" --name="dev-contribution" -v
# snarkjs powersoftau prepare phase2 "$PTAU_DIR/pot17_0001.ptau" \
#   "$PTAU_DIR/pot17_final.ptau" -v
#
# for shape in 1x2 2x2 2x3; do
#   snarkjs groth16 setup "$BUILD_DIR/$shape/circuit.r1cs" \
#     "$PTAU_DIR/pot17_final.ptau" "$BUILD_DIR/$shape/0000.zkey"
#   snarkjs zkey contribute "$BUILD_DIR/$shape/0000.zkey" \
#     "$BUILD_DIR/$shape/final.zkey" --name="dev-contribution" -v
#   snarkjs zkey export verificationkey "$BUILD_DIR/$shape/final.zkey" \
#     "$BUILD_DIR/$shape/vkey.json"
# done

echo "No compiled circuits yet. Run 'npm run compile' first."
