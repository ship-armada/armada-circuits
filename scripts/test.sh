#!/usr/bin/env bash
set -euo pipefail

# Run circuit tests and static analysis.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"

cd "$ROOT"

echo "Running static analysis..."
if ! command -v circomspect >/dev/null 2>&1; then
  echo "circomspect not found. Install it with: cargo install circomspect --version 0.9.0 --locked" >&2
  exit 1
fi
npm run lint:circom

echo "Running tests..."
# Each test exits non-zero on failure. All but lint-circom-test.js need
# build/<shape>/ artifacts from `npm run compile && npm run setup:dev`.
TESTS=(
  "tests/lint-circom-test.js"
  "tests/diff-test.js"
  "tests/nullifier-uniqueness-test.js"
  "tests/eddsa-malleability-test.js"
)

failed=()
for t in "${TESTS[@]}"; do
  echo ""
  echo "── $t"
  if ! node "$t"; then
    failed+=("$t")
  fi
done

echo ""
if [ ${#failed[@]} -gt 0 ]; then
  echo "FAILED: ${failed[*]}"
  exit 1
fi
echo "All ${#TESTS[@]} test files passed."
