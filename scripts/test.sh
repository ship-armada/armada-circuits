#!/usr/bin/env bash
set -euo pipefail

# Run circuit tests and static analysis.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"

cd "$ROOT"

echo "Running static analysis..."
npm run lint:circom

echo "Running tests..."
# Placeholder: once tests exist, run them here.
# npx mocha tests/**/*.test.ts

echo "No tests implemented yet."
