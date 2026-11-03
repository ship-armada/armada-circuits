#!/usr/bin/env bash
set -euo pipefail

# Compile all Armada circuit shapes.
# Outputs: build/<N>x<M>/{main_<N>x<M>.r1cs, main_<N>x<M>_js/...wasm, main_<N>x<M>.sym}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
BUILD_DIR="$ROOT/build"
SRC_DIR="$ROOT/src"

CIRCOM_BIN="${CIRCOM_BIN:-circom}"

# Circuits come from circuits.json (via the compiled registry CLI).
# Pass circuit ids to compile only those, e.g. `npm run compile -- 2x2 8x4`.
REGISTRY_CLI="$ROOT/dist/src/registry-cli.js"
if [ ! -f "$REGISTRY_CLI" ]; then
  echo "Missing $REGISTRY_CLI — run 'npm run build' (npm ci runs it automatically)." >&2
  exit 1
fi
CIRCUITS="$(node "$REGISTRY_CLI" list "$@")"
COUNT="$(printf '%s\n' "$CIRCUITS" | wc -l | tr -d ' ')"

echo "Compiling Armada circuits..."
echo "Source: $SRC_DIR"
echo "Build:  $BUILD_DIR"
echo "Circuits: $COUNT"

mkdir -p "$BUILD_DIR"

while IFS=$'\t' read -r id entry _power; do
  outdir="$BUILD_DIR/$id"
  base="$(basename "$entry" .circom)"

  echo "  Compiling $id..."
  mkdir -p "$outdir"
  "$CIRCOM_BIN" "$ROOT/$entry" \
    --r1cs --wasm --sym \
    -o "$outdir" \
    --O1

  echo "    → $outdir/$base.r1cs"
done <<< "$CIRCUITS"

echo "Done. Compiled $COUNT circuits."
