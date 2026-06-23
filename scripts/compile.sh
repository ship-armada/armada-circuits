#!/usr/bin/env bash
set -euo pipefail

# Compile all Armada Circom circuits.
# Outputs: build/<N>x<M>/{circuit.r1cs,circuit.wasm,circuit.sym}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
BUILD_DIR="$ROOT/build"
SRC_DIR="$ROOT/src"

CIRCOM_BIN="${CIRCOM_BIN:-circom}"

echo "Compiling Armada circuits..."
echo "Source: $SRC_DIR"
echo "Build:  $BUILD_DIR"

mkdir -p "$BUILD_DIR"

# Placeholder: no source circuits yet. Once src/operations/Transact.circom exists,
# loop over the (N,M) shape matrix and compile each instantiation.
#
# Example:
# for shape in "1,2" "2,2" "2,3"; do
#   IFS=',' read -r n m <<< "$shape"
#   outdir="$BUILD_DIR/${n}x${m}"
#   mkdir -p "$outdir"
#   "$CIRCOM_BIN" "$SRC_DIR/operations/Transact.circom" \
#     --r1cs --wasm --sym \
#     -o "$outdir" \
#     -p "N=$n" -p "M=$m"
# done

echo "No circuits to compile yet. Add Circom sources under src/operations/."
