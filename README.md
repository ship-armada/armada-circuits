# Armada Circuits

Custom zero-knowledge circuits for the Armada privacy pool.

## Status

**Phase 2 — Circuit Implementation ✅ COMPILED (1x2 shape)**

Circuit sources are written and compiling. Reference vectors captured. Dev trusted setup in progress.

### Milestones
- [x] Phase 0: Specification & Design
- [x] Phase 1: Reference vector capture (shield + transfer-1x2)
- [x] Phase 2: Circuit implementation — Transact.circomp compiled (1x2 shape, ~20k constraints)
- [ ] Phase 2b: Dev trusted setup + differential test against captured vectors
- [ ] Phase 3: All circuit shapes compiled + integrated

## Architecture

- `src/lib/` — reusable Circom primitives (MerkleTreeProof)
- `src/operations/` — operation-specific circuits parameterized by `(N, M)`
- `src/main/` — entry points (one per circuit shape)
- `docs/` — formal specifications and test vectors
- `scripts/` — deterministic compilation and trusted-setup helpers
- `tests/` — differential and negative tests

## Dependencies

- **circomlib** (GPL-3.0) — Poseidon, EdDSA, BabyJubJub, comparators primitives
- **circom** compiler v2.2.3 (GPL-3.0 build tool)
- **snarkjs** v0.7.6 (GPL-3.0 build tool)

## Proving System

- **Curve**: BN254
- **Protocol**: Groth16
- **Hash**: Poseidon
- **Tree**: binary Merkle tree, depth 16
- **Authorization**: EdDSA over BabyJubJub

## Circuit Shapes

| Nullifiers | Commitments | Operation |
|------------|-------------|-----------|
| 1 | 2 | Shield |
| 1 | 1 | Cross-contract adapt (lend/redeem) |
| 2 | 2 | Simple transfer |
| 2 | 3 | Transfer with change |
| N | 1 | Consolidation unshield |
| 8 | 4 | Medium consolidation / multi-recipient |

See `docs/SPEC.md` for the full matrix and public-input layout.

## Build

```bash
npm install
npm run compile       # compile all circuit shapes
npm run setup:dev     # generate dev ptau + zkey (unsafe — testing only)
npm run test          # run differential tests
```

## Trusted Setup

The dev setup above is **single-contributor and UNSAFE** — local testing and
CI only. Production keys come from the public multi-party ceremony:

- **Runbook:** `docs/CEREMONY.md`
- **State of record:** `ceremony/manifest.json`
- Phase 1 builds on the Hermez perpetual Powers-of-Tau; Phase 2 is a
  PR-based per-shape ceremony finalized with a pre-committed Ethereum block
  hash beacon.

```bash
npm run ceremony:ptau         # fetch + hash-check the Hermez ptau
npm run ceremony:contribute -- <shape> <handle>   # add your contribution
npm run ceremony:verify -- --all                  # verify the chain
```

Until the ceremony completes and the `v1.0.0` release is cut, the only
published artifacts are the UNSAFE `v0.1.0-dev` set — **testnet only**.

## Security

This repo contains production-intent circuit sources. All changes require review, differential testing against reference test vectors, and formal/static analysis before any artifact is used on mainnet.
