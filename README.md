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

## Security

This repo contains production-intent circuit sources. All changes require review, differential testing against reference test vectors, and formal/static analysis before any artifact is used on mainnet.
