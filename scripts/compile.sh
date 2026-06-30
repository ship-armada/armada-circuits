#!/usr/bin/env bash
set -euo pipefail

# Compile all Armada circuit shapes.
# Outputs: build/<N>x<M>/{main_<N>x<M>.r1cs, main_<N>x<M>_js/...wasm, main_<N>x<M>.sym}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
BUILD_DIR="$ROOT/build"
SRC_DIR="$ROOT/src"

CIRCOM_BIN="${CIRCOM_BIN:-circom}"

# All circuit shapes (must match VerifierModule key set)
SHAPES=(
  "1,1" "1,2" "2,2" "2,3" "8,4"
  "2,1" "3,1" "4,1" "5,1" "6,1" "7,1" "8,1"
  "3,2" "4,2" "5,2" "6,2"
  "1,3" "3,3" "4,3"
)

echo "Compiling Armada circuits..."
echo "Source: $SRC_DIR"
echo "Build:  $BUILD_DIR"
echo "Shapes: ${#SHAPES[@]} total"

mkdir -p "$BUILD_DIR"

for shape in "${SHAPES[@]}"; do
  IFS=',' read -r n m <<< "$shape"
  shape_name="${n}x${m}"
  outdir="$BUILD_DIR/$shape_name"
  main_file="$SRC_DIR/main/main_${shape_name}.circom"

  if [ ! -f "$main_file" ]; then
    echo "  SKIP $shape_name (no entry point at $main_file)"
    continue
  fi

  echo "  Compiling $shape_name..."
  mkdir -p "$outdir"
  "$CIRCOM_BIN" "$main_file" \
    --r1cs --wasm --sym \
    -o "$outdir" \
    --O1

  echo "    → $outdir/main_${shape_name}.r1cs"
done

echo "Done. Compiled ${#SHAPES[@]} shapes."
