# Armada Circuits

Custom zero-knowledge circuits for the Armada privacy pool.

## Status

**Phase 0 — Specification & Design**

This directory contains the specification, primitive definitions, and planned implementation of Armada's independent circuit set. The circuits are authored from scratch to support Armada's shielded UTXO model and cross-chain privacy flows.

## Architecture

- `src/lib/` — reusable Circom primitives (Poseidon, Merkle proof, EdDSA, note commitment/nullifier).
- `src/operations/` — operation-specific circuits parameterized by `(nullifiers, commitments)`.
- `docs/` — formal specifications and test vectors.
- `scripts/` — deterministic compilation and trusted-setup helpers.
- `tests/` — differential and negative tests.

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
npm run compile
```

## Security

This repo contains production-intent circuit sources. All changes require review, differential testing against reference test vectors, and formal/static analysis before any artifact is used on mainnet.
