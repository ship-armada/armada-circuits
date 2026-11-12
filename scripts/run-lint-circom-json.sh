#!/usr/bin/env bash
set -uo pipefail

# Acceptance probe: the new owned circuits pass the
# repo's circom lint (circomspect). Scoped to the files this change adds,
# to prove the new circuits pass the repo's lint without flagging
# src/lib/merkle.circom's one pre-existing, unrelated circomspect warning,
# which predates this change and which scripts/compile.sh's own
# "lint:circom" npm script already tolerates via its trailing `|| true`.
# Emits one stdout_json object; judges nothing itself.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
cd "$ROOT" || exit 1

OWNED_FILES=("src/operations/TransactOwned.circom" src/main/main_*_owned.circom)

mkdir -p build
SARIF="build/run-lint-circom-owned.sarif"
rm -f "$SARIF"

circomspect -l WARNING -s "$SARIF" "${OWNED_FILES[@]}" >/dev/null 2>&1
lint_exit=$?

# circomspect exits 1 when it reports a finding — that is data for this
# probe to report, not a script failure. Any other exit code is a real
# tool failure (e.g. a parse error) and must propagate.
if [ "$lint_exit" -ne 0 ] && [ "$lint_exit" -ne 1 ]; then
  echo "circomspect exited with unexpected code $lint_exit" >&2
  exit 1
fi

if [ ! -f "$SARIF" ]; then
  echo "circomspect did not write a SARIF file at $SARIF" >&2
  exit 1
fi

findings="$(node -e "
  const fs = require('fs');
  const sarif = JSON.parse(fs.readFileSync(process.argv[1], 'utf-8'));
  const count = (sarif.runs || []).reduce(
    (n, run) => n + (run.results || []).length,
    0,
  );
  console.log(count);
" "$ROOT/$SARIF")"

if ! [[ "$findings" =~ ^[0-9]+$ ]]; then
  echo "could not parse a finding count from $SARIF" >&2
  exit 1
fi

printf '{"findings": %d}\n' "$findings"
