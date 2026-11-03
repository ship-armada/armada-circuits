# Armada Circuits

Custom zero-knowledge circuits for the Armada privacy pool.

## Status

**Circuits implemented and tested; production trusted setup pending.**

All 19 circuit shapes compile. UNSAFE single-contributor dev keys (`v0.1.0-dev`) are published for testnet use only. Differential tests replay SDK-captured vectors (1x1, 1x2, 2x2, 3x2 and an unshield 2x2), and negative tests cover input-note distinctness and EdDSA signature malleability.

### Milestones
- [x] Phase 0: Specification & Design
- [x] Phase 1: Reference vector capture (shield + transfer-1x2)
- [x] Phase 2: Circuit implementation — `Transact.circom`
- [x] Phase 2b: Dev trusted setup + differential test against captured vectors
- [x] Phase 3: All 19 circuit shapes compiled; dev keys published (`v0.1.0-dev`, UNSAFE)
- [ ] Phase 4: External circuit audit + circuit freeze
- [ ] Phase 5: Public multi-party trusted-setup ceremony (production keys)

## Architecture

- `src/lib/` — reusable Circom primitives (MerkleTreeProof)
- `src/operations/` — operation-specific circuits parameterized by `(N, M)`
- `src/main/` — entry points (one per circuit shape)
- `docs/` — formal specifications and test vectors
- `circuits.json` — the circuit registry: every circuit, its entry point, public-input count, ptau power and whether it is in the ceremony. Compile, dev setup and the ceremony tooling all read it.
- `scripts/` — deterministic compilation and trusted-setup helpers
- `tool/` — ceremony tooling (TypeScript, compiled to `dist/` by `npm ci` / `npm run build`)
- `tests/` — differential and negative tests

## Dependencies

- **circomlib** (GPL-3.0) — Poseidon, EdDSA, BabyJubJub, comparators primitives
- **circom** compiler v2.2.3 (GPL-3.0 build tool)
- **snarkjs** v0.7.6 (GPL-3.0 build tool)
- **circomspect** v0.9.0 (static analysis, run by `npm test`; `cargo install circomspect --version 0.9.0 --locked`). Any finding not listed with a reason in `scripts/circomspect-accepted.json` fails the run.

## Proving System

- **Curve**: BN254
- **Protocol**: Groth16
- **Hash**: Poseidon
- **Tree**: binary Merkle tree, depth 16
- **Authorization**: EdDSA over BabyJubJub

## Circuit Shapes

| Nullifiers | Commitments | Operation |
|------------|-------------|-----------|
| 1 | 2 | Transfer with change |
| 1 | 1 | Cross-contract adapt (lend/redeem) |
| 2 | 2 | Simple transfer |
| 2 | 3 | Transfer with change |
| N | 1 | Consolidation unshield |
| 8 | 4 | Medium consolidation / multi-recipient |

See `docs/SPEC.md` for the full matrix and public-input layout.

## Build

```bash
npm ci              # install dependencies and build the tooling (Node >= 22)
npm run compile     # compile every circuit in circuits.json (or: npm run compile -- 2x2 8x4)
npm run setup:dev   # generate dev ptau + zkey (unsafe — testing only; also takes circuit ids)
npm run test        # static analysis, tooling unit tests, differential + negative tests
                    # (circuit tests need compile + setup:dev for 1x1 1x2 2x2 3x2)
```

## Trusted-setup ceremony

Production keys will come from a public multi-party ceremony, run with the
tooling in `tool/` (not started yet; the full contributor guide comes with it).
Contributors need Node >= 22 and a logged-in GitHub CLI (`gh` >= 2.48):

```bash
npm run ceremony -- doctor        # check this machine; runs a practice contribution
npm run ceremony -- status        # who holds the turn, and your contributions
npm run ceremony -- contribute    # claim the turn and contribute (add --wait to wait for it)
npm run ceremony -- verify --mine # confirm your contribution is in every circuit
```

Bring-your-own-tool contributions: `contribute --download-only`, contribute with
any compatible implementation, then `submit <turn.json> <zkey-dir>`.

Every contribution PR gets a read-only `contribution-check` (GitHub Actions,
`pull_request_target`, no secrets). Coordinators then run
`npm run coordinator -- accept <pr>`, which merges only if that check passed for
the PR's current head (`--reverify` re-checks locally instead) and copies the
zkeys to the official release.

Coordinator commands (`npm run coordinator -- help`): `init`, `add-circuit`,
`announce`, `accept`, `finalize` (after the window: participant policy check,
the committed drand round as the beacon, full verify, verifying keys) and
`release` (all artifacts, `SHA256SUMS` optionally signed with an SSH key, and
`TRANSCRIPT.md`). Commands that change the manifest write `ceremony/manifest.json`
for a reviewed PR.

How the ceremony's verifying keys get into armada-poc, and how to check the
registered keys are the ceremony's: `docs/ARMADA_POC_HANDOFF.md`.

## Security

This repo contains production-intent circuit sources. All changes require review, differential testing against reference test vectors, and formal/static analysis before any artifact is used on mainnet.
