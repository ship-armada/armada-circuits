#!/usr/bin/env bash
set -euo pipefail

# Acceptance probe: the existing Transact circuit and
# the non-owned main entry files are byte-identical to the base commit.
# Takes the base commit as $1 (default: origin/main); emits one
# stdout_json object and judges nothing itself.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
cd "$ROOT"

BASE_REF="$(git merge-base HEAD "${1:-origin/main}")"

FILES=("src/operations/Transact.circom")
for f in src/main/main_*.circom; do
  case "$f" in
  *_owned.circom) ;;
  *) FILES+=("$f") ;;
  esac
done

changed=0
for f in "${FILES[@]}"; do
  if ! git diff --quiet "$BASE_REF" -- "$f"; then
    changed=$((changed + 1))
  fi
done

printf '{"changed_existing_files": %d}\n' "$changed"
