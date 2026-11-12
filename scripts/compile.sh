#!/usr/bin/env bash
set -euo pipefail

# Compile all Armada circuit shapes.
# Outputs: build/<N>x<M>/{main_<N>x<M>.r1cs, main_<N>x<M>_js/...wasm, main_<N>x<M>.sym}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
BUILD_DIR="$ROOT/build"
SRC_DIR="$ROOT/src"

CIRCOM_BIN="${CIRCOM_BIN:-circom}"

# Must match the pinned ptau's power (scripts/ceremony/lib.sh PTAU_POWER=17,
# scripts/setup-dev.sh POT_POWER=17): 2^17 constraints is the ceremony's
# hard ceiling. Owned shapes that exceed it are reported below rather than
# silently built past a setup the ceremony can't actually cover.
OWNED_HARD_LIMIT_CONSTRAINTS=131072
OVER_LIMIT_REPORT="$BUILD_DIR/owned_shapes_over_limit.json"

# All circuit shapes (must match VerifierModule key set).
# Each entry is "N,M" or "N,M,name" when the shape's name is not "NxM"
# (the owned shapes compile TransactOwned(N,M) under an "_owned" suffixed name).
SHAPES=(
  "1,1" "1,2" "2,2" "2,3" "8,4"
  "2,1" "3,1" "4,1" "5,1" "6,1" "7,1" "8,1"
  "3,2" "4,2" "5,2" "6,2"
  "1,3" "3,3" "4,3"
  "1,1,1x1_owned" "1,2,1x2_owned" "1,3,1x3_owned" "1,4,1x4_owned"
  "2,1,2x1_owned" "2,2,2x2_owned" "2,3,2x3_owned" "2,4,2x4_owned"
  "3,1,3x1_owned" "3,2,3x2_owned" "3,3,3x3_owned" "3,4,3x4_owned"
  "4,1,4x1_owned" "4,2,4x2_owned" "4,3,4x3_owned" "4,4,4x4_owned"
  "5,1,5x1_owned" "5,2,5x2_owned" "5,3,5x3_owned" "5,4,5x4_owned"
  "6,1,6x1_owned" "6,2,6x2_owned" "6,3,6x3_owned" "6,4,6x4_owned"
  "7,1,7x1_owned" "7,2,7x2_owned" "7,3,7x3_owned" "7,4,7x4_owned"
  "8,1,8x1_owned" "8,2,8x2_owned" "8,3,8x3_owned" "8,4,8x4_owned"
)

echo "Compiling Armada circuits..."
echo "Source: $SRC_DIR"
echo "Build:  $BUILD_DIR"
echo "Shapes: ${#SHAPES[@]} total"

mkdir -p "$BUILD_DIR"

over_limit_entries=()

for shape in "${SHAPES[@]}"; do
  IFS=',' read -r n m name_override <<< "$shape"
  shape_name="${name_override:-${n}x${m}}"
  outdir="$BUILD_DIR/$shape_name"
  main_file="$SRC_DIR/main/main_${shape_name}.circom"

  if [ ! -f "$main_file" ]; then
    echo "  SKIP $shape_name (no entry point at $main_file)"
    continue
  fi

  echo "  Compiling $shape_name..."
  mkdir -p "$outdir"
  compile_output="$("$CIRCOM_BIN" "$main_file" \
    --r1cs --wasm --sym \
    -o "$outdir" \
    --O1 | tee /dev/stderr)"

  echo "    → $outdir/main_${shape_name}.r1cs"

  case "$shape_name" in
  *_owned)
    nonlinear="$(grep -oE '^non-linear constraints: [0-9]+' <<< "$compile_output" | grep -oE '[0-9]+')"
    linear="$(grep -oE '^linear constraints: [0-9]+' <<< "$compile_output" | grep -oE '[0-9]+')"
    total_constraints=$((nonlinear + linear))
    if [ "$total_constraints" -gt "$OWNED_HARD_LIMIT_CONSTRAINTS" ]; then
      echo "    OVER LIMIT: $shape_name has $total_constraints constraints (> $OWNED_HARD_LIMIT_CONSTRAINTS)"
      over_limit_entries+=("{\"shape\":\"$shape_name\",\"constraints\":$total_constraints}")
    fi
    ;;
  esac
done

{
  printf '['
  for i in "${!over_limit_entries[@]}"; do
    [ "$i" -gt 0 ] && printf ','
    printf '%s' "${over_limit_entries[$i]}"
  done
  printf ']\n'
} > "$OVER_LIMIT_REPORT"

echo "Done. Compiled ${#SHAPES[@]} shapes."
