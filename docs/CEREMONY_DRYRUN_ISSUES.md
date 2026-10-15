# Ceremony Contributor Dry-Run — Issues Found (2026-08-25)

> **Resolution (2026-10-14):** P0 — repo is public. P1 — fixed in `verify.sh`
> (jq sentinel for null URLs). P2 — fixed (local-preferred, per-shape failure
> isolation, `GH_TOKEN` auth). P3 — naming-convention lint added to `verify.sh`;
> stale test contribution state removed in the ceremony reset. P4 — fixed
> (`init.sh` refuses `--announce-height` while any shape lacks a published
> 0000.zkey URL). The dry-run contribution was dropped in the reset; all 19
> base zkeys are published on the `v1.0.0-ceremony` release.

Method: followed `docs/CEREMONY.md` step by step as a contributor against the
`v1.0.0-ceremony-test` run, made a real contribution (#1 on 1x2, handle
`coax1d`, sha256 `99cb1c14…9883e79`, uploaded as release asset
`1x2-0001-coax1d.zkey`), then ran the verify paths. Chain cryptography is
sound — `snarkjs zkey verify` passes on the full chain including my
contribution. All issues below are process/tooling, not crypto.

## P0 — Repo is private: external contributors cannot participate at all

`ship-armada/armada-circuits` is **PRIVATE**. Every contributor step breaks:
`git clone` 404, release-asset downloads 404 (unauthenticated `curl` gets a
9-byte "Not Found" body), and outsiders can't open PRs. A public ceremony on
a private repo is impossible.

**Fix:** make the repo public before announcing, or host zkeys externally +
accept contributions by another channel. (Public repo is the design intent —
nothing sensitive in it; zkeys/ptau are gitignored.)

## P1 — `verify.sh` TSV misalignment bug: `zkeyUrl: null` kills `verify --all`

Shape **1x1's coordinator entry has `"zkeyUrl": null`**. In `verify.sh` the
checksum loop builds TSV via jq and reads it with `IFS=$'\t' read -r _idx url
sha`. Tab is IFS-whitespace, so consecutive tabs collapse: the line
`0\t\t<sha256>` parses as `url=<sha256>`. `fetch_zkey` then curl's the sha256
as a URL → fails → `die`. **`npm run ceremony:verify -- --all` aborts on the
first shape (1x1)**, before checking anything else.

Repro: `npm run ceremony:verify -- --all` → `ERROR: download failed:
cf6f8a32…` (that's a sha256, not a URL).

**Fix:** map empty URLs to a sentinel in jq (`.zkeyUrl // "NONE"`) instead of
relying on empty TSV fields, or iterate contributions with `jq -c` and parse
per-field. Also make init write `"TODO"` (or omit the key) instead of `null`
for consistency — the manifest currently mixes `null`, `"TODO"`, and real
URLs.

## P2 — `verify.sh` always re-downloads URL'd zkeys and hard-dies on failure

- Step 1b downloads **every** contribution zkey that has a URL, even when the
  identical file already exists locally in `ceremony/<shape>/NNNN.zkey`
  (checked: step 3 prefers local, step 1b doesn't). Any single unreachable
  URL (404, offline, expired host) `die`s the entire run — all shapes, all
  other checks.
- Plain `curl` with no auth: no `GH_TOKEN`/header support for private or
  rate-limited hosts.

**Fix:** prefer local `ceremony/<shape>/NNNN.zkey` when its sha256 matches
the manifest; only download what's missing. On download failure, mark that
shape FAIL and continue other shapes. Optionally support `gh release download`
or `Authorization: token $GH_TOKEN` for private assets.

## P3 — Stale/untracked release assets confuse the chain

The `v1.0.0-ceremony-test` release already contained **`1x2-0001.zkey`** from
the Aug 3 test run, but the manifest has no contribution #1 for 1x2 (it only
had the coordinator setup). A contributor can't tell which 0001 is canonical,
and a naive re-upload would clobber it (I uploaded mine as
`1x2-0001-coax1d.zkey` to avoid this).

**Fix:** enforce a naming convention (`<shape>-<NNNN>-<handle>.zkey`) in
docs + a lint in `verify.sh` that warns on release assets with no manifest
entry (or vice versa).

## P4 — 1x1 coordinator zkey has no URL at all

Manifest entry for 1x1 setup: `zkeyUrl: null` (others have URLs). A
contributor picking 1x1 per the docs ("note the latest contribution's
zkeyUrl… download the previous zkey") is blocked even with a public repo.
(Works locally only because `ceremony/1x1/0000.zkey` happens to be on disk
from the init run — external machines won't have it.)

**Fix:** `init.sh` should require/verify that all 19 `0000.zkey` URLs are
filled before the ceremony is announced (fail init's final step otherwise).

## What worked well (no action)

- `contribute.sh` guards: shape open check, r1cs sha256 must match manifest
  (protects circuit drift — verified it matches the post-uniqueness-fix
  circuits), previous-zkey checksum validation, entropy handling (urandom +
  hidden prompt, never logged), attestation + manifest entry generation.
- Chain cryptography: full `snarkjs zkey verify` passes with the new
  contribution (proved via file:// URL workaround).
- `fetch-ptau.sh`: idempotent, pinned sha256 verified.
- Docs are accurate about the flow; the gaps are tooling robustness + repo
  visibility.

## State left behind

- `ceremony/manifest.json` + `ceremony/1x2/0001-coax1d.md` — my test
  contribution (per docs, these are the PR artifacts; not yet committed).
- `ceremony/1x2/0001.zkey` (local) + release asset `1x2-0001-coax1d.zkey`.
- Nothing else modified; `/tmp` scratch files can be discarded.
