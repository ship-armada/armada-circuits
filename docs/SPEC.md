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
| (1,2) | Transfer with change | Spend 1 note, create 2 outputs (recipient + change). Shields need no proof (see Resolved Questions). |
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

### 2b. Input Note Distinctness

All `leavesIndices` within one proof must be pairwise distinct (`IsEqual` constrained to 0 for every pair). This prevents the same note from being passed as multiple inputs and its value counted multiple times toward `sumIn`. The contract additionally rejects duplicate nullifiers when marking them spent (defense in depth).

### 3. Ownership / Spend Authorization

One EdDSA signature over BabyJubJub, made with the spending key, authorizes the whole transaction. It signs `Poseidon(merkleRoot, boundParamsHash, ...nullifiers, ...commitmentsOut)`, so it binds every public input. All input notes must belong to that key: each input's `npk` is derived from `masterPublicKey = Poseidon(spendingPublicKey, nullifyingKey)`.

### 4. Value Conservation

All inputs and outputs of one proof share a single `token`, and:

```
sum(valueIn) == sum(valueOut)
```

There is no separate fee term: a broadcaster fee is paid as an ordinary output note, and an unshield is one of the output commitments whose preimage the contract checks. Every value is range-checked to 120 bits, so the equality holds over the integers, not just mod p.

### 5. Output Commitment Formation

Each output commitment must satisfy:

```
commitment = Poseidon(npk, token, value)
```

The note's randomness enters through `npk = Poseidon(masterPublicKey, random)`, not the commitment hash.

Exact field ordering and width are defined in `PRIMITIVES.md`.

### 6. Bound Parameters Binding

The contract hashes `boundParams` and passes it as public input `[1]`. The circuit does not recompute this hash; it binds it through the spend signature (section 3), which covers `boundParamsHash`. This prevents a malicious relayer or contract from altering fees, token, adapter address, or other operation metadata after the proof is generated.

## Adapt / Cross-Contract Binding

For cross-contract operations (e.g., shielded lend/redeem), the circuit additionally constrains:

```
adaptParamsHash = hash(npk, encryptedBundle, shieldKey)
```

The adapter contract supplies `adaptParams` and the circuit proves the output commitment was created for the exact npk and encrypted bundle the user intended.

## Resolved Questions (from live capture, 2026-06-30)

- [x] **Poseidon width**: 2-input Poseidon (t=3) for NPK, nullifier and Merkle nodes; 3-input Poseidon for the master public key and note commitments; `Poseidon(2 + N + M)` for the signed message hash.
- [x] **boundParams**: Includes `adaptContract` and `adaptParams` as direct fields within the struct (not just the hash).
- [x] **Shield operations**: Do NOT require a ZK proof. Shield creates a commitment directly from the plaintext preimage. The shield fee is deducted (50 bps) and the remaining value is committed.
- [x] **Merkle leaf ordering**: Path indices are a packed bigint (little-endian binary). Bit 0 = left, bit 1 = right, starting from the leaf.
- [x] **Output commitments**: All outputs are real commitments (recipient + change). No dummy/zero-valued commitments needed — the circuit shape (N,M) determines the count.
- [x] **Value range**: Values are `uint120` (confirmed from `CommitmentPreimage.value` type in Solidity).

## Captured Reference Vectors

Vectors are stored in `tests/fixtures/generated/`:

| File | Operation | Shape | Description |
|------|-----------|-------|-------------|
| `shield.json` | Shield | (0,1) | Single ERC20 shield with full note preimage |
| `transfer-1x2.json` | Transfer | (1,2) | Spend 1 UTXO, create 2 outputs (recipient + change) |
| `capture-summary.json` | — | — | Parameter summary from the capture run |
