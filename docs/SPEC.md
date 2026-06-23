# Armada Circuit Specification

## Overview

Armada uses a shielded UTXO model. Users hold notes whose contents are hidden on chain. A note is represented by a **commitment** inserted into a Merkle tree, and spent by revealing a **nullifier** derived from the note's secret key and leaf index.

The circuits prove that a transaction:
1. Spends only notes the prover owns (valid EdDSA signature + Merkle membership).
2. Does not double-spend (nullifier is derived correctly and unique).
3. Conserves value across inputs and outputs.
4. Creates well-formed output commitments.
5. Binds the transaction to public parameters (`boundParams`) so the contract and the proof agree on token, fees, adapter intent, etc.

## Public Input Layout

On-chain verification expects public inputs in this exact order:

```
[0]  merkleRoot
[1]  boundParamsHash
[2]  nullifier[0]
...  nullifier[N-1]
[2+N] commitment[0]
...  commitment[N+M-1]
```

Total public inputs: `2 + N + M`.

This layout is enforced by the `VerifierModule` contract and must not change without a corresponding contract upgrade.

## Operation Matrix

A circuit is identified by `(nullifiers, commitments)`, abbreviated `(N,M)`.

| Shape | Operation | Notes |
|-------|-----------|-------|
| (1,1) | Cross-contract adapt | One input note unshielded, one output shielded back; `adaptParams` binds the destination. |
| (1,2) | Shield | One plaintext preimage → two output commitments (one real, one dummy for padding). |
| (2,2) | Simple transfer | Spend 2 notes, create 2 outputs (recipient + change). |
| (2,3) | Transfer with change / fee | Spend 2 notes, create 3 outputs. |
| (N,1) | Consolidation unshield | Spend N notes, create 1 change commitment. |
| (3,2)..(6,2) | Larger transfer with change | Spend more notes, 2 outputs. |
| (1,3),(3,3),(4,3) | Multi-recipient transfer | 3 outputs. |
| (8,4) | Medium consolidation / fan-out | Largest shape in the initial set. |

The contract stores one verifying key per shape. Any proof whose shape is not registered reverts with `VerifierModule: Key not set`.

## Core Constraints

### 1. Merkle Membership

For each input note, the circuit proves:

```
leaf = commitment(inputNote)
merkleRoot = MerkleProof(leaf, path, pathIndices)
```

- Tree depth: 16.
- Arity: 2.
- Hash at each level: Poseidon(2 inputs).

### 2. Nullifier Derivation

For each input note:

```
nullifier = Poseidon(nullifyingKey, leafIndex)
```

The nullifier is revealed publicly. The contract stores spent nullifiers to prevent double-spends.

### 3. Ownership / Spend Authorization

Each input note is signed with EdDSA over BabyJubJub. The public key used for verification is derived from the note owner's spending key.

### 4. Value Conservation

For each token type:

```
sum(inputValues) == sum(outputValues) + fee
```

Fees are computed outside the circuit and bound via `boundParamsHash`. The circuit proves the fee value is included consistently.

### 5. Output Commitment Formation

Each output commitment must satisfy:

```
commitment = Poseidon(npk, token, value, randomness)
```

Exact field ordering and width are defined in `PRIMITIVES.md`.

### 6. Bound Parameters Binding

The contract hashes `boundParams` and passes it as public input `[1]`. The circuit constrains the same hash over the private witness-bound parameters. This prevents a malicious relayer or contract from altering fees, token, adapter address, or other operation metadata after the proof is generated.

## Adapt / Cross-Contract Binding

For cross-contract operations (e.g., shielded lend/redeem), the circuit additionally constrains:

```
adaptParamsHash = hash(npk, encryptedBundle, shieldKey)
```

The adapter contract supplies `adaptParams` and the circuit proves the output commitment was created for the exact npk and encrypted bundle the user intended.

## Open Questions / To Verify

- [ ] Exact Poseidon width and constants for note commitment.
- [ ] Whether `boundParams` includes `adaptParams` directly or only its hash.
- [ ] Whether shield operations include a signature or only a preimage proof.
- [ ] Exact Merkle leaf ordering (left/right computed from path index bit).
- [ ] Whether output dummy commitments must be zero-valued or can be arbitrary.
- [ ] Range checks on values (e.g., 120-bit vs full field).

These will be resolved by capturing concrete witness/public-signal examples in `DIFFERENTIAL_TEST_VECTORS.md`.
