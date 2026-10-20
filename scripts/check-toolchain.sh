#!/usr/bin/env bash
set -euo pipefail

# Acceptance probe: node_modules is a real folder, not
# a symlink, and the repo's own circom2 (installed by npm ci) runs.
# Emits one stdout_json object; judges nothing itself.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
cd "$ROOT"

if [ -L node_modules ]; then
  node_modules_is_symlink=true
else
  node_modules_is_symlink=false
fi

circom2_runs=false
if node_modules/.bin/circom2 --version >/dev/null 2>&1; then
  circom2_runs=true
fi

printf '{"node_modules_is_symlink": %s, "circom2_runs": %s}\n' \
  "$node_modules_is_symlink" "$circom2_runs"
