#!/usr/bin/env bash
# Contributor: add a Phase 2 contribution to one circuit shape.
#
# Usage:
#   contribute.sh <shape> <name> [prev-zkey]
#
#   <shape>       e.g. 1x2 — must exist in the manifest and be open
#   <name>        contributor name/handle (recorded on-chain in the zkey
#                 transcript via snarkjs --name)
#   [prev-zkey]   path or https URL of the previous zkey in the chain.
#                 Defaults to the highest-index *.zkey already present in
#                 ceremony/<shape>/ (e.g. downloaded from the manifest URL).
#
# Entropy: /dev/urandom is always mixed in. Additional personal entropy is
# taken from $CEREMONY_ENTROPY, or interactively if a TTY is present.
# Entropy is NEVER logged, saved, or committed. Delete it from your shell
# history/environment after the run (`unset CEREMONY_ENTROPY`).
#
# Outputs:
#   ceremony/<shape>/NNNN.zkey          — your contribution (self-host this)
#   ceremony/<shape>/NNNN-<name>.md     — attestation file to commit in your PR
#   manifest.json                       — updated with your contribution entry
#
# After the run: upload NNNN.zkey somewhere durable (S3/IPFS/your hosting),
# fill in zkeyUrl in the attestation + manifest, then open a PR. See
# docs/CEREMONY.md.

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

SHAPE="${1:?usage: contribute.sh <shape> <name> [prev-zkey]}"
NAME="${2:?usage: contribute.sh <shape> <name> [prev-zkey]}"
PREV_ARG="${3:-}"

need_cmd jq
need_cmd curl
require_manifest
check_ptau

# ── Shape checks ─────────────────────────────────────────────
jq -e --arg s "$SHAPE" '.shapes | has($s)' "$MANIFEST" >/dev/null \
  || die "shape '$SHAPE' not in manifest"
[ "$(shape_status "$SHAPE")" = "open" ] || die "shape '$SHAPE' is not open for contributions"
[[ "$NAME" =~ ^[A-Za-z0-9._-]+$ ]] || die "name may only contain [A-Za-z0-9._-]"

R1CS="$(r1cs_for "$SHAPE")"
[ -f "$R1CS" ] || die "missing $R1CS — run npm run compile (and check r1csSha256 in the manifest)"

# Contributor-side guard: r1cs must match the manifest checksum.
R1CS_SHA="$(sha256 "$R1CS")"
TRACKED_R1CS="$(mget --arg s "$SHAPE" '.shapes[$s].r1csSha256')"
[ "$R1CS_SHA" = "$TRACKED_R1CS" ] || die "r1cs checksum mismatch vs manifest ($R1CS_SHA vs $TRACKED_R1CS)"

PREV_INDEX="$(shape_latest_index "$SHAPE")"
NEXT_INDEX=$((PREV_INDEX + 1))
NEXT_PAD="$(printf '%04d' "$NEXT_INDEX")"

# ── Locate previous zkey ─────────────────────────────────────
WORK_PREV=""
if [ -n "$PREV_ARG" ]; then
  case "$PREV_ARG" in
    http://*|https://*)
      WORK_PREV="$(mktemp -u)/prev.zkey"; mkdir -p "$(dirname "$WORK_PREV")"
      log "downloading previous zkey: $PREV_ARG"
      curl -fSL --retry 3 -o "$WORK_PREV" "$PREV_ARG" ;;
    *) WORK_PREV="$PREV_ARG" ;;
  esac
else
  PREV_PAD="$(printf '%04d' "$PREV_INDEX")"
  WORK_PREV="$(zkey_for "$SHAPE" "$PREV_PAD")"
fi
[ -f "$WORK_PREV" ] || die "previous zkey not found: $WORK_PREV"

# Verify previous zkey against manifest checksum.
EXPECTED_PREV_SHA="$(jq -r --arg s "$SHAPE" --argjson i "$PREV_INDEX" \
  '.shapes[$s].contributions[] | select(.index==$i) | .zkeySha256' "$MANIFEST")"
ACTUAL_PREV_SHA="$(sha256 "$WORK_PREV")"
[ "$ACTUAL_PREV_SHA" = "$EXPECTED_PREV_SHA" ] \
  || die "previous zkey checksum mismatch vs manifest contribution #$PREV_INDEX"

# ── Entropy (never logged) ───────────────────────────────────
URANDOM_ENTROPY="$(head -c 64 /dev/urandom | base64)"
PERSONAL_ENTROPY="${CEREMONY_ENTROPY:-}"
if [ -z "$PERSONAL_ENTROPY" ] && [ -t 0 ]; then
  echo "Type a long random string (personal entropy, input hidden), then Enter:"
  read -rs PERSONAL_ENTROPY
  echo ""
fi
ENTROPY="${URANDOM_ENTROPY}|${PERSONAL_ENTROPY}|$(date -u +%s%N)"
unset URANDOM_ENTROPY PERSONAL_ENTROPY

OUT_ZKEY="$(zkey_for "$SHAPE" "$NEXT_PAD")"
mkdir -p "$CEREMONY_DIR/$SHAPE"

log "contributing to $SHAPE as '$NAME' (contribution #$NEXT_INDEX)..."
CONTRIB_LOG="$(mktemp)"
printf '%s\n' "$ENTROPY" | snarkjs zkey contribute "$WORK_PREV" "$OUT_ZKEY" \
  --name="$NAME" -v 2>&1 | tee "$CONTRIB_LOG"
unset ENTROPY

CONTRIB_HASH="$(grep -A1 'Contribution Hash' "$CONTRIB_LOG" | tail -1 | tr -d ' \t')"
rm -f "$CONTRIB_LOG"
[ -n "$CONTRIB_HASH" ] || die "could not extract contribution hash from snarkjs output"

log "verifying contribution chain (snarkjs zkey verify)..."
snarkjs zkey verify "$R1CS" "$PTAU_FILE" "$OUT_ZKEY" >/dev/null \
  || die "zkey verify FAILED — contribution is invalid"

ZKEY_SHA="$(sha256 "$OUT_ZKEY")"
TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# ── Attestation file ─────────────────────────────────────────
ATTESTATION="$CEREMONY_DIR/$SHAPE/${NEXT_PAD}-${NAME}.md"
cat > "$ATTESTATION" <<EOF
# Contribution #${NEXT_INDEX} — ${SHAPE} — ${NAME}

- **Shape:** ${SHAPE}
- **Contribution index:** ${NEXT_INDEX}
- **Name (snarkjs --name):** ${NAME}
- **Date (UTC):** ${TIMESTAMP}
- **zkey sha256:** \`${ZKEY_SHA}\`
- **zkey URL:** TODO — paste a durable download URL before opening your PR
- **Contribution hash (from snarkjs transcript):**
  \`${CONTRIB_HASH}\`

## Attestation

I ran \`scripts/ceremony/contribute.sh\` on my own machine with entropy I do
not control jointly with any other participant. I have destroyed the entropy
used and did not retain any copy of it.

Signed: ${NAME}

<!-- Optional: add a GPG/Keybase signature of this file's contents. -->
EOF

# ── Manifest update ──────────────────────────────────────────
tmp="$(mktemp)"
jq --arg s "$SHAPE" \
   --argjson i "$NEXT_INDEX" \
   --arg name "$NAME" \
   --arg sha "$ZKEY_SHA" \
   --arg chash "$CONTRIB_HASH" \
   --arg att "${ATTESTATION#"$CEREMONY_DIR"/}" \
   --arg ts "$TIMESTAMP" \
   '.shapes[$s].contributions += [{
      index: $i,
      type: "contribution",
      name: $name,
      zkeySha256: $sha,
      zkeyUrl: "TODO",
      contributionHash: $chash,
      attestation: $att,
      timestamp: $ts
    }]' "$MANIFEST" > "$tmp"
mv "$tmp" "$MANIFEST"

log ""
log "Contribution #$NEXT_INDEX complete."
log "  zkey:            $OUT_ZKEY"
log "  zkey sha256:     $ZKEY_SHA"
log "  contribution:    $CONTRIB_HASH"
log "  attestation:     $ATTESTATION"
log ""
log "Next steps:"
log "  1. Upload $OUT_ZKEY to durable storage (S3/IPFS/your hosting)."
log "  2. Replace 'TODO' zkeyUrl in $ATTESTATION and $MANIFEST."
log "  3. Open a PR with the attestation + manifest changes. See docs/CEREMONY.md."
log "  4. Destroy any shell traces of entropy: unset CEREMONY_ENTROPY; clear history if pasted."
