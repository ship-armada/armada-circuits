# Differential Test Vectors

This document captures concrete inputs and outputs from the current reference implementation. The captured vectors will be used to verify that the new Armada circuits produce identical public signals and accepted proofs for the same valid operations.

## Methodology

1. Run the SDK in a controlled local environment (Anvil chains + deployed contracts).
2. For each operation (shield, transfer, unshield, adapt), record:
   - Private witness values (where extractable)
   - Public inputs passed to the verifier
   - Proof (`pi_a`, `pi_b`, `pi_c`)
   - Transaction metadata (nullifiers, commitments, merkleRoot, boundParams)
3. Store vectors as JSON fixtures under `tests/fixtures/`.
4. Once Armada circuits exist, replay each vector through the new prover and assert:
   - Public inputs match exactly.
   - On-chain verification succeeds.

## Captured Operations

### Shield (shape 1x2)

**Status**: Not captured yet.

Fields to capture:
- `merkleRoot`
- `boundParams`
- `boundParamsHash`
- `commitments[2]`
- `npk`, `token`, `value`, `randomness` for each output

### Simple Transfer (shape 2x2)

**Status**: Not captured yet.

Fields to capture:
- `merkleRoot`
- `boundParams`
- `nullifiers[2]`
- `commitments[2]`
- Input note Merkle paths and leaf indices
- Output note preimages
- EdDSA signature components

### Adapt / Lend (shape 1x1)

**Status**: Not captured yet.

Fields to capture:
- `merkleRoot`
- `adaptParams`
- `nullifier[1]`
- `commitment[1]`
- Input note preimage and Merkle path
- Output note preimage

## Capture Scripts

Add helper scripts under `scripts/capture/`:
- `capture-shield.ts`
- `capture-transfer.ts`
- `capture-adapt.ts`

These should use the SDK's testing-mode path (which bypasses on-chain proof verification) to generate proofs without requiring real value at risk.

## Privacy Notice

Captured vectors contain no real user data when generated in a local Anvil environment. Do not capture vectors from mainnet or Sepolia without explicit consent and scrubbing.
