# Armada Cryptographic Primitives

All parameters below are **confirmed** from live reference vector capture (2026-06-30).

## Curve

- **Curve**: BN254 / alt_bn128
- **Scalar field prime**: `21888242871839275222246405745257275088548364400416034343698204186575808495617`
- **Base field prime**: `21888242871839275222246405745257275088696311157297823662689037894645226208583`

## Poseidon Hash

Used for commitments, nullifiers, NPK derivation, and Merkle tree hashing.

- **Variant**: Poseidon over BN254 scalar field
- **Implementation target**: `circomlib` Poseidon template (standard BN254 parameters)
- **Width (t)**: 3 (for 2-input hashes) — confirmed from NPK derivation and Merkle node hashing
- **Alpha**: 5 (standard for BN254)

All Poseidon invocations in the circuit use 2-input Poseidon (t=3, absorbing 2 field elements per call).

## Merkle Tree

- **Depth**: 16 (**confirmed**: 16 path elements per Merkle proof in captured vector)
- **Arity**: 2 (binary)
- **Leaf**: commitment hash
- **Node hash**: `Poseidon(leftChild, rightChild)`
- **Path indexing**: packed bigint, little-endian bit vector, 0 = left, 1 = right
- **Root history**: contract accepts roots from a recent history window

**Confirmed from capture**: `indices` field = packed bigint encoding the binary path (e.g. `0x0e` = leaf at position 14).

## Notes & Commitments

A note contains:

- `npk` — note public key (derived from owner)
- `token` — token data `{ tokenType, tokenAddress, tokenSubID }`
- `value` — amount (uint120)

**NPK derivation** (confirmed):
```
masterPublicKey = Poseidon(spendingPublicKey[0], spendingPublicKey[1], nullifyingKey)
npk = Poseidon(masterPublicKey, random)
```

**Token hash** (confirmed):
```
tokenHash = hash(tokenType, tokenAddress, tokenSubID)
```
For ERC20: `tokenType=0`, `tokenSubID=0`, `tokenAddress` is the ERC20 contract address.

**Commitment** (confirmed):
```
commitment = Poseidon(npk, tokenHash, value)
```

**Shield fee**: 50 basis points (0.5%). The shielded value = `inputValue - shieldFee`.

## Nullifiers

**Confirmed**:
```
nullifier = Poseidon(nullifyingKey, leafIndex)
```

- `nullifyingKey` = `Poseidon(viewingPrivateKey)` — derived from the note owner's viewing key.
- `leafIndex` is the position of the commitment in the Merkle tree.

## EdDSA / BabyJubJub

- **Curve**: BabyJubJub (twisted Edwards curve over BN254)
- **Scheme**: EdDSA
- **Signature**: `(R, S)` where `R` is a curve point and `S` is a scalar
- **Hash for challenge**: Poseidon

The circuit verifies an EdDSA signature over `boundParamsHash` using the spending public key.

**Confirmed from capture**: spending public key is a BabyJubJub point `[x, y]`.

## Addresses

Shielded addresses are encoded in a `0zk...` format. The circuit receives the raw public-key material (spending public key, nullifying key), not the encoded string.

## Bound Parameters Hash

**Confirmed**:
```
boundParamsHash = uint256(keccak256(abi.encode(boundParams))) % SNARK_SCALAR_FIELD
```

BoundParams struct fields (confirmed):
| Field | Type | Description |
|-------|------|-------------|
| `treeNumber` | uint16 | Merkle tree number |
| `minGasPrice` | uint72 | Min gas price (0 for private transfers) |
| `unshield` | uint8 | Unshield type enum (0 = NONE) |
| `chainID` | uint64 | Chain ID |
| `adaptContract` | address | Adapter contract (zero address = no adapt) |
| `adaptParams` | bytes32 | Adapter parameters |
| `commitmentCiphertext` | array | Encrypted output commitment data |

The circuit constrains the same hash over the private `boundParams` witness.

## Adapt Parameters

For cross-contract operations:
```
adaptParams = hash(npk, encryptedBundle, shieldKey)
```

When no adapt is used: `adaptContract = address(0)`, `adaptParams = bytes32(0)`.

## Public Input Layout

**Confirmed** from captured vector (1x2 transfer):

```
[0]  merkleRoot         — PoseidonMerkle root containing input notes
[1]  boundParamsHash    — keccak256(abi.encode(boundParams)) % p
[2]  nullifier[0]       — Poseidon(nullifyingKey, leafIndex)
[3]  commitment[0]      — Poseidon(npk, tokenHash, value)  [recipient output]
[4]  commitment[1]      — Poseidon(npk, tokenHash, value)  [change output]
```

Total public inputs: `2 + N + M` where N = nullifiers, M = commitments.
