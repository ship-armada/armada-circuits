#!/usr/bin/env bash
set -euo pipefail

# Acceptance probe: after a full compile, each owned shape has both a
# constraint file (.r1cs) and a wasm witness calculator.
# Emits one stdout_json object; judges nothing itself.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
cd "$ROOT"

# Uses the repo's own circom2 (installed by npm ci), not a global "circom"
# on PATH.
export CIRCOM_BIN="$ROOT/node_modules/.bin/circom2"
bash scripts/compile.sh >&2

OWNED_SHAPES=(1x1_owned 1x2_owned 1x3_owned)
count=0
for shape in "${OWNED_SHAPES[@]}"; do
  r1cs="build/${shape}/main_${shape}.r1cs"
  wasm="build/${shape}/main_${shape}_js/main_${shape}.wasm"
  if [ -f "$r1cs" ] && [ -f "$wasm" ]; then
    count=$((count + 1))
  fi
done

printf '{"owned_shapes_with_r1cs_and_wasm": %d}\n' "$count"
