#!/usr/bin/env bash
# Phase 1: fetch the public perpetual Powers of Tau (Hermez) and pin its hash.
#
# The Armada ceremony does NOT generate its own ptau. It builds on the
# Hermez perpetual Powers-of-Tau ceremony (powersOfTau28_hez_final), which
# had dozens of public contributions plus a random beacon. Any single honest
# contributor to that ceremony secures the phase-1 output.
#
# Usage:
#   fetch-ptau.sh [--verify]
#
#   --verify   additionally run `snarkjs powersoftau verify` (slow, ~tens of
#              minutes). Recommended once on the coordinator machine.

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

need_cmd curl

mkdir -p "$(dirname "$PTAU_FILE")"

if [ -f "$PTAU_FILE" ]; then
  log "ptau already present: $PTAU_FILE"
else
  log "downloading Hermez perpetual ptau (power $PTAU_POWER, ~144MB)..."
  log "  source: $PTAU_URL"
  curl -fSL --retry 3 -o "$PTAU_FILE.tmp" "$PTAU_URL"
  mv "$PTAU_FILE.tmp" "$PTAU_FILE"
fi

log "verifying pinned sha256..."
actual="$(sha256 "$PTAU_FILE")"
if [ "$actual" != "$PTAU_SHA256" ]; then
  rm -f "$PTAU_FILE"
  die "checksum mismatch: got $actual, want $PTAU_SHA256 (file deleted)"
fi
log "  sha256 OK: $actual"

if [ "${1:-}" = "--verify" ]; then
  log "running full snarkjs powersoftau verify (slow)..."
  snarkjs powersoftau verify "$PTAU_FILE"
  log "  powersoftau verify OK"
fi

log "Phase 1 ready: $PTAU_FILE"
