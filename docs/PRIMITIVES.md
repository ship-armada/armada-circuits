# Armada Cryptographic Primitives

This document specifies the exact cryptographic primitives the circuits rely on. Values marked **TBD** must be verified against the current reference implementation before circuit implementation begins.

## Curve

- **Curve**: BN254 / alt_bn128
- **Scalar field prime**: `21888242871839275222246405745257275088548364400416034343698204186575808495617`
- **Base field prime**: `21888242871839275222246405745257275088696311157297823662689037894645226208583`

## Poseidon Hash

Used for commitments, nullifiers, and Merkle tree hashing.

- **Variant**: Poseidon over BN254 scalar field
- **Width (t)**: **TBD** — likely 3 or 5
- **Full rounds**: **TBD**
- **Partial rounds**: **TBD**
- **Alpha**: 5 (standard for BN254)
- **Round constants**: **TBD** — must match the reference tree implementation

The `circomlib` Poseidon template is the implementation target once parameters are confirmed.

## Merkle Tree

- **Depth**: 16
- **Arity**: 2 (binary)
- **Leaf hash**: Poseidon(commitment)
- **Node hash**: Poseidon(leftChild, rightChild)
- **Path indexing**: little-endian bit vector, 0 = left, 1 = right
- **Root history**: contract accepts roots from a recent history window

## Notes & Commitments

A note contains at minimum:

- `npk` — note public key (derived from owner)
- `token` — token identifier (ERC20 address hashed or encoded)
- `value` — amount
- `randomness` / `blinding` — uniqueness factor

Commitment:

```
commitment = Poseidon(npk, token, value, randomness)
```

Exact field count and order are **TBD**.

## Nullifiers

```
nullifier = Poseidon(nullifyingKey, leafIndex)
```

- `nullifyingKey` is derived from the note spending key.
- `leafIndex` is the position of the commitment in the Merkle tree.

## EdDSA / BabyJubJub

- **Curve**: BabyJubJub (twisted Edwards curve over BN254)
- **Scheme**: EdDSA
- **Signature**: `(R, S)` where `R` is a curve point and `S` is a scalar
- **Hash for challenge**: Poseidon (reference-dependent, **TBD**)

The circuit verifies an EdDSA signature over a transaction hash that commits to the public inputs and output commitments.

## Addresses

Armada addresses are encoded in a `0zk...` format. The circuit receives the raw public-key material, not the encoded string.

## Bound Parameters Hash

The contract computes:

```
boundParamsHash = uint256(keccak256(abi.encode(boundParams))) % SNARK_SCALAR_FIELD
```

The circuit must constrain the same hash over the private `boundParams` witness.

## Adapt Parameters

For cross-contract operations:

```
adaptParams = hash(npk, encryptedBundle, shieldKey)
```

The exact hash function and field packing are **TBD**.
