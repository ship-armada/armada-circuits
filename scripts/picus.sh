#!/usr/bin/env bash
set -euo pipefail

# Check the nullifier disclosure circuit for under-constrained signals with Picus (Veridise).
#
# Picus cannot finish on the whole circuit: cvc5 does not terminate on the scalar
# multiplications inside circomlib's EdDSAPoseidonVerifier (Picus's own test suite lists
# EscalarMulAny, SegmentMulFix and WindowMulFix as timeouts). So the circuit is checked in
# pieces, as the Picus README recommends for large circuits:
#
#   poseidon2/3/5  the three Poseidon instances           weak safety  → expect safe
#   wiring         the circuit with hashes and verifier   strong safety → expect safe
#                  replaced by free inputs
#   control_minimal an output that no constraint uses      weak safety  → expect unsafe
#
# The control proves that this Picus setup reports a real under-constrained signal.
# EdDSAPoseidonVerifier stays a trusted circomlib component, as it is for Transact.circom.
#
# Needs Docker. Builds the Picus image from a pinned commit on first use.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
CIRCOM_BIN="${CIRCOM_BIN:-circom}"
PICUS_COMMIT="138b151"
PICUS_IMAGE="picus:$PICUS_COMMIT"
OUT="$ROOT/build/picus"

if ! docker image inspect "$PICUS_IMAGE" >/dev/null 2>&1; then
  echo "Building $PICUS_IMAGE..."
  docker build -t "$PICUS_IMAGE" "https://github.com/Veridise/Picus.git#$PICUS_COMMIT"
fi

mkdir -p "$OUT"

# Picus exit codes: 8 = properly constrained, 9 = under-constrained, 0 = unknown.
check() {
  local name="$1" expected="$2"; shift 2
  "$CIRCOM_BIN" "$ROOT/tests/picus/$name.circom" --r1cs --sym -o "$OUT" --O0 >/dev/null
  local code=0
  docker run --rm --memory=8g -v "$OUT:/w" "$PICUS_IMAGE" \
    ./run-picus --solver cvc5 --timeout 600000 "$@" "/w/$name.r1cs" >"$OUT/$name.log" 2>&1 || code=$?
  if [ "$code" -eq "$expected" ]; then
    echo "  ok    $name (exit $code)"
  else
    echo "  FAIL  $name: expected exit $expected, got $code (see $OUT/$name.log)"
    return 1
  fi
}

echo "Running Picus (cvc5)..."
status=0
check control_minimal 9 || status=1
check poseidon2 8 || status=1
check poseidon3 8 || status=1
check poseidon5 8 || status=1
check wiring 8 --strong || status=1
exit "$status"
