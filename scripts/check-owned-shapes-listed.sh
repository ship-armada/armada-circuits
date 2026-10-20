#!/usr/bin/env bash
set -euo pipefail

# Acceptance probe: scripts/compile.sh lists the three
# owned shapes, and each shape's entry file exists.
# Emits one stdout_json object; judges nothing itself.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
cd "$ROOT"

OWNED_SHAPES=(1x1_owned 1x2_owned 1x3_owned)

listed=0
entry_present=0
for shape in "${OWNED_SHAPES[@]}"; do
  if grep -qE ",${shape}\"" scripts/compile.sh; then
    listed=$((listed + 1))
  fi
  if [ -f "src/main/main_${shape}.circom" ]; then
    entry_present=$((entry_present + 1))
  fi
done

printf '{"owned_shapes_listed": %d, "owned_entry_files_present": %d}\n' \
  "$listed" "$entry_present"
