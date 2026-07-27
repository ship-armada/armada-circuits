# Armada Circuits — Public Trusted-Setup Ceremony

This document is the runbook for the **production** Groth16 trusted setup for
all 19 Armada circuit shapes. It replaces the development setup
(`scripts/setup-dev.sh`), which is **single-contributor and UNSAFE** — local
testing and CI only.

> **Why this matters (soundness, not privacy):** Groth16 zero-knowledge
> holds regardless of the setup — a compromised setup cannot deanonymize
> anyone. But a compromised setup lets its holder **forge proofs** (mint or
> drain pool funds). The ceremony's 1-of-N honesty assumption means the
> final keys are sound as long as **at least one** participant (including
> the phase-1 Hermez contributors or the random beacon) destroyed their
> toxic waste.

Tracking issue: armada-poc #406.

## Overview

| Phase | What | Trust basis |
|-------|------|-------------|
| 1 | Hermez perpetual Powers-of-Tau (`powersOfTau28_hez_final_17.ptau`) | Dozens of public contributions + beacon; we do **not** generate our own ptau |
| 2 | Per-shape multi-party ceremony (this repo, PR-based) | 1-of-N honest contributors |
| Final | Random beacon from a pre-committed Ethereum block hash | Publicly unpredictable + reproducible |

Power 17 covers the largest shape (8x4, ~92.6k constraints).

All ceremony state lives in `ceremony/manifest.json` — the single source of
truth, updated exclusively through pull requests (plus coordinator
init/finalize commits).

## For contributors

You need: Node.js ≥ 18, ~4 GB free RAM (more for the 8x4 shape), and a
machine you trust.

```bash
git clone https://github.com/ship-armada/armada-circuits.git
cd armada-circuits
npm install
npm run compile                 # builds r1cs/wasm into build/
npm run ceremony:ptau           # fetches + hash-checks the Hermez ptau
```

1. **Pick an open shape.** Check `ceremony/manifest.json` for a shape whose
   `status` is `open`, and note the latest contribution's `zkeyUrl`.
2. **Download the previous zkey** into `ceremony/<shape>/` (e.g. `0003.zkey`
   for contribution #4). The script validates it against the manifest
   checksum before touching it.
3. **Contribute:**

   ```bash
   CEREMONY_ENTROPY="$(your own long random string)" \
     npm run ceremony:contribute -- 1x2 your-github-handle
   ```

   `/dev/urandom` is always mixed in; if you omit `CEREMONY_ENTROPY` you'll
   be prompted (input hidden) when running interactively. Entropy is never
   logged or written to disk. **Destroy it afterwards**
   (`unset CEREMONY_ENTROPY`, clear any shell-history traces). Do **not**
   reuse entropy across shapes or contributions.
4. The script verifies the full chain (`snarkjs zkey verify`) and writes:
   - `ceremony/<shape>/NNNN.zkey` — your contribution
   - `ceremony/<shape>/NNNN-<handle>.md` — attestation (edit: paste your
     zkey URL, optionally add a GPG/Keybase signature)
   - a manifest entry
5. **Self-host your zkey** somewhere durable (S3, IPFS, your own hosting).
   Fill the URL into both the attestation and `manifest.json` (replace
   `TODO`).
6. **Open one PR** containing the attestation file + manifest change. Title:
   `ceremony: contribution #N for <shape> by <handle>`.

The coordinator reviews PRs strictly in chain order per shape: they
re-download your zkey, check the sha256 against your PR, re-run
`npm run ceremony:verify -- <shape>`, and only then merge. Different shapes
advance in parallel; within a shape, wait for the previous PR to merge
before contributing.

## For the coordinator

### Setup (once)

```bash
npm install && npm run compile
npm run ceremony:ptau           # add -- --verify for a full (slow) ptau audit
npm run ceremony:init -- --announce-height <H>
```

- Choose `<H>`: an Ethereum mainnet block height comfortably **after** the
  expected end of contributions (e.g. announcement date + 4 weeks). This
  pre-commitment is what makes the beacon unpredictable at announce time.
- Publish the 19 `0000.zkey` files as assets on a `v1.0.0-ceremony`
  **pre-release**, and record each `zkeyUrl` in the manifest.
- Announce: repo README badge + issue + socials. Template below.

### Reviewing contributions

For each contribution PR (one per contributor per shape):

```bash
gh pr checkout <pr>
npm run ceremony:verify -- <shape>
```

Merge only if verify passes, the attestation is complete (URL filled,
checksum matches), and the PR is next in the shape's chain.

### Finalizing

Once the announced block height `<H>` has passed and the contribution
window is closed:

```bash
npm run ceremony:finalize -- --all        # uses the recorded beacon
npm run ceremony:verify -- --all --full   # full beacon-recompute proof
```

### Cutting the release

1. Collect per-shape outputs: `ceremony/<shape>/{final.zkey,vkey.json,SHA256SUMS}`
   plus `build/<shape>/main_<shape>.r1cs` and the WASM prover files.
2. Build the release tarball exactly like `v0.1.0-dev` (same layout under
   `build/`), generate the top-level `SHA256SUMS`.
3. Publish as **`v1.0.0`** (immutable). Mark `v0.1.0-dev` clearly superseded
   in its release notes; do not delete it (Sepolia deployments still point
   at it until cutover).
4. Update the manifest with release asset URLs (`final.zkeyUrl`).
5. Follow-ups in armada-poc #406: pin artifact hashes, register ceremony
   vkeys on the mainnet VerifierModule.

### Announcement template

```markdown
# Armada Circuits Trusted-Setup Ceremony

We're running the production Groth16 ceremony for Armada's privacy-pool
circuits (19 shapes, BN254). We need independent contributors — the setup
is sound if even ONE participant is honest.

- How: run one script, open one PR. Guide: docs/CEREMONY.md
- Phase 1: Hermez perpetual Powers-of-Tau (already public)
- Beacon: block hash of Ethereum mainnet block <H> (pre-committed)
- Everything is verifiable: npm run ceremony:verify -- --all --full
```

## For verifiers (anyone, after finalization)

```bash
git clone ... && cd armada-circuits && npm install && npm run compile
npm run ceremony:ptau
npm run ceremony:verify -- --all --full
```

This checks, for every shape: manifest integrity, every attestation
present, all zkey checksums, the full cryptographic contribution chain
against the Hermez ptau, and — with `--full` — that the final zkey is
exactly `beacon(lastContribution, hash(block H))`. The block hash is
independently fetchable from any Ethereum node/explorer.

## Operational rules

- **Never** commit zkeys/ptau to git (already gitignored). They travel via
  release assets and contributor self-hosting, always with sha256 in the
  manifest.
- **Never** hardcode or reuse entropy. The dev setup's hardcoded strings
  are exactly what this ceremony replaces.
- The coordinator cannot compromise soundness alone, but CAN censor
  contributions or reorder the queue. Mitigation: all state transitions are
  public PRs; anyone can fork the ceremony and continue the chain.
- If a contributor reports a mistake (bad URL, wrong checksum), fix it with
  a new PR correcting the attestation — never rewrite merged history.
