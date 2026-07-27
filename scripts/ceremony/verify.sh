#!/usr/bin/env bash
# Verify the ceremony state for one shape or all shapes. Read-only.
#
# Usage:
#   verify.sh <shape|--all> [--full]
#
# Checks per shape:
#   1. Manifest integrity: sequential contribution indices, attestation
#      files present, no leftover TODO URLs.
#   2. Local r1cs matches the manifest checksum.
#   3. Latest zkey (downloaded from its manifest URL into a local cache if
#      not present) matches its recorded sha256.
#   4. `snarkjs zkey verify` — cryptographic check of the ENTIRE
#      contribution chain against the r1cs and the Hermez ptau.
#   5. Finalized shapes: beacon fields recorded; with --full, the final
#      zkey is recomputed from the last contribution + recorded beacon and
#      the checksum compared (full reproducibility proof).

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

TARGET="${1:?usage: verify.sh <shape|--all> [--full]}"
FULL="${2:-}"

need_cmd jq
need_cmd curl
require_manifest
check_ptau

if [ "$TARGET" = "--all" ]; then
  CHECK_SHAPES=($(jq -r '.shapes | keys[]' "$MANIFEST"))
else
  CHECK_SHAPES=("$TARGET")
fi

CACHE_DIR="$CEREMONY_DIR/.cache"
mkdir -p "$CACHE_DIR"

FAILURES=0

# fetch_zkey <url> <expected-sha> -> echoes local path
fetch_zkey() {
  local url="$1" want="$2"
  local dest="$CACHE_DIR/$(echo -n "$url" | shasum -a 256 | awk '{print $1}').zkey"
  if [ ! -f "$dest" ]; then
    log "    downloading: $url"
    curl -fSL --retry 3 -o "$dest.tmp" "$url" || die "download failed: $url"
    mv "$dest.tmp" "$dest"
  fi
  local got
  got="$(sha256 "$dest")"
  if [ "$got" != "$want" ]; then
    rm -f "$dest"
    die "zkey checksum mismatch for $url (got $got, want $want)"
  fi
  echo "$dest"
}

for shape in "${CHECK_SHAPES[@]}"; do
  log "── $shape ──────────────────────────────"
  jq -e --arg s "$shape" '.shapes | has($s)' "$MANIFEST" >/dev/null \
    || { log "    FAIL: not in manifest"; FAILURES=$((FAILURES+1)); continue; }

  STATUS="$(shape_status "$shape")"
  LATEST="$(shape_latest_index "$shape")"
  log "    status=$STATUS contributions=$((LATEST + 1)) (incl. setup)"

  # 1. Manifest integrity
  jq -e --arg s "$shape" \
    '.shapes[$s].contributions | map(.index) == [range(0; length)]' "$MANIFEST" >/dev/null \
    || { log "    FAIL: non-sequential contribution indices"; FAILURES=$((FAILURES+1)); continue; }

  ATT_OK=1
  while read -r att; do
    [ "$att" = "null" ] && continue
    [ -f "$CEREMONY_DIR/$att" ] || { log "    FAIL: missing attestation $att"; ATT_OK=0; }
  done < <(jq -r --arg s "$shape" '.shapes[$s].contributions[] | select(.index >= 1) | .attestation' "$MANIFEST")
  [ "$ATT_OK" = 1 ] || { FAILURES=$((FAILURES+1)); continue; }

  TODOS="$(jq --arg s "$shape" '[.shapes[$s].contributions[] | select(.zkeyUrl == "TODO")] | length' "$MANIFEST")"
  [ "$TODOS" = "0" ] || log "    WARN: $TODOS contribution(s) still have zkeyUrl=TODO"

  # 1b. Checksum EVERY contribution zkey reachable via URL (cached after
  # first download). A tampered checksum anywhere in the chain fails here.
  while IFS=$'\t' read -r _idx url sha; do
    case "$url" in ""|null|TODO) continue ;; esac
    fetch_zkey "$url" "$sha" >/dev/null
  done < <(jq -r --arg s "$shape" \
    '.shapes[$s].contributions[] | [.index, (.zkeyUrl // ""), .zkeySha256] | @tsv' "$MANIFEST")
  log "    contribution checksums: OK"

  # 2. r1cs checksum
  R1CS="$(r1cs_for "$shape")"
  if [ -f "$R1CS" ]; then
    R1CS_SHA="$(sha256 "$R1CS")"
    TRACKED="$(mget --arg s "$shape" '.shapes[$s].r1csSha256')"
    [ "$R1CS_SHA" = "$TRACKED" ] || { log "    FAIL: r1cs checksum mismatch"; FAILURES=$((FAILURES+1)); continue; }
  else
    log "    WARN: no local r1cs for $shape (skipping r1cs checksum + chain verify)"
    continue
  fi

  # 3. Latest zkey present + checksum
  if [ "$STATUS" = "finalized" ]; then
    LATEST_ZKEY="$CEREMONY_DIR/$shape/final.zkey"
    WANT_SHA="$(mget --arg s "$shape" '.shapes[$s].final.zkeySha256')"
    LATEST_URL="$(mget --arg s "$shape" '.shapes[$s].final.zkeyUrl // ""')"
  else
    LATEST_PAD="$(printf '%04d' "$LATEST")"
    LATEST_ZKEY="$CEREMONY_DIR/$shape/$LATEST_PAD.zkey"
    WANT_SHA="$(jq -r --arg s "$shape" --argjson i "$LATEST" \
      '.shapes[$s].contributions[] | select(.index==$i) | .zkeySha256' "$MANIFEST")"
    LATEST_URL="$(jq -r --arg s "$shape" --argjson i "$LATEST" \
      '.shapes[$s].contributions[] | select(.index==$i) | .zkeyUrl // ""' "$MANIFEST")"
  fi

  if [ -f "$LATEST_ZKEY" ]; then
    [ "$(sha256 "$LATEST_ZKEY")" = "$WANT_SHA" ] \
      || { log "    FAIL: latest zkey checksum mismatch"; FAILURES=$((FAILURES+1)); continue; }
    CHECK_ZKEY="$LATEST_ZKEY"
  elif [ -n "$LATEST_URL" ] && [ "$LATEST_URL" != "null" ] && [ "$LATEST_URL" != "TODO" ]; then
    CHECK_ZKEY="$(fetch_zkey "$LATEST_URL" "$WANT_SHA")"
  else
    log "    WARN: latest zkey not available locally and no URL — skipping chain verify"
    continue
  fi

  # 4. Cryptographic chain verification
  log "    snarkjs zkey verify (full contribution chain)..."
  if snarkjs zkey verify "$R1CS" "$PTAU_FILE" "$CHECK_ZKEY" >/dev/null 2>&1; then
    log "    chain verify: OK"
  else
    log "    FAIL: snarkjs zkey verify rejected the chain"
    FAILURES=$((FAILURES+1)); continue
  fi

  # 5. Finalized: beacon recorded (+ optional full recompute)
  if [ "$STATUS" = "finalized" ]; then
    BH="$(mget '.beacon.blockHash')"
    [ "$BH" != "null" ] && [ -n "$BH" ] || { log "    FAIL: finalized but no beacon blockHash recorded"; FAILURES=$((FAILURES+1)); continue; }
    log "    beacon: block $(mget '.beacon.blockHeight') hash $BH"

    if [ "$FULL" = "--full" ]; then
      PREV_URL="$(jq -r --arg s "$shape" --argjson i "$LATEST" \
        '.shapes[$s].contributions[] | select(.index==$i) | .zkeyUrl // ""' "$MANIFEST")"
      PREV_SHA="$(jq -r --arg s "$shape" --argjson i "$LATEST" \
        '.shapes[$s].contributions[] | select(.index==$i) | .zkeySha256' "$MANIFEST")"
      PREV_ZKEY="$(fetch_zkey "$PREV_URL" "$PREV_SHA")"
      RECOMPUTED="$CACHE_DIR/recomputed-final-$shape.zkey"
      log "    recomputing beacon application (--full)..."
      snarkjs zkey beacon "$PREV_ZKEY" "$RECOMPUTED" "${BH#0x}" 10 >/dev/null 2>&1
      GOT="$(sha256 "$RECOMPUTED")"
      [ "$GOT" = "$WANT_SHA" ] \
        || { log "    FAIL: beacon recompute mismatch ($GOT vs $WANT_SHA)"; FAILURES=$((FAILURES+1)); continue; }
      log "    beacon recompute: OK (final zkey fully reproducible)"
    fi
  fi

  log "    $shape: OK"
done

log ""
if [ "$FAILURES" -gt 0 ]; then
  die "$FAILURES shape(s) failed verification"
fi
log "All checked shapes passed."
