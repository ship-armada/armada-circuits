#!/usr/bin/env bash
set -euo pipefail

# Run circuit tests and static analysis.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"

cd "$ROOT"

echo "Running static analysis..."
npm run lint:circom

echo "Running tests..."
# Each test needs build/<shape>/ artifacts from
# `npm run compile && npm run setup:dev`, and exits non-zero on failure.
TESTS=(
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
