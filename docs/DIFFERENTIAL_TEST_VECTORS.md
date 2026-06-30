# Differential Test Vectors

This document tracks concrete inputs and outputs captured from the live reference implementation. The captured vectors verify that Armada's independent circuits produce identical public signals and accepted proofs for the same valid operations.

## Methodology

1. Run the capture script against a local Anvil deployment.
2. For each operation (shield, transfer), record:
   - Private witness values (note preimages, Merkle paths, keys)
   - Public inputs passed to the verifier
   - Proof (Groth16 `a`, `b`, `c`)
   - Transaction metadata (nullifiers, commitments, merkleRoot, boundParams)
3. Store vectors as JSON fixtures under `tests/fixtures/`.
4. Once Armada circuits exist, replay each vector through the new prover and assert:
   - Public inputs match exactly.
   - On-chain verification succeeds.

## Captured Operations

### Shield (shape 0x1)

**Status**: ✅ Captured (2026-06-30)

**File**: `tests/fixtures/generated/shield.json`

Captured fields:
- `shieldPrivateKey`, `masterPublicKey`, `random`, `npk`
- `tokenAddress`, `tokenHash`, `value`
- `commitment` (tree leaf hash)
- `merkleTreeNumber`, `merkleLeafIndex`
- `merkleRootAfter` (root after insertion)
- Full `shieldRequestStruct` (preimage + ciphertext)
- On-chain `txHash`

### Simple Transfer (shape 1x2)

**Status**: ✅ Captured (2026-06-30)

**File**: `tests/fixtures/generated/transfer-1x2.json`

Captured fields:
- **Inputs** (1 UTXO):
  - `notePublicKey`, `tokenHash`, `value`, `random`
  - `treeNumber`, `leafIndex`, `nullifier`
  - `merkleProof`: `{ leaf, elements[16], indices, root }`
- **Keys**: `nullifyingKey`, `spendingPublicKey [x, y]`
- **Outputs** (2 notes: recipient + change):
  - `notePublicKey`, `tokenAddress`, `tokenHash`, `value`, `random`
  - `recipientAddress`
- **Transaction struct**: `merkleRoot`, `nullifiers[]`, `commitments[]`, `boundParams`, `unshieldPreimage`, `proof`
- **Public signals**: `[merkleRoot, boundParamsHash, nullifier[0], commitment[0], commitment[1]]`
- **Bound params hash**: computed via `keccak256(abi.encode(boundParams)) % SNARK_SCALAR_FIELD`

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

- `scripts/capture/capture-reference-vectors.ts` (runs from armada-poc repo root)

```bash
cd /Users/andrewburger/armada/armada-poc
npm run chains                              # start Anvil
source config/local.env && npm run setup    # deploy contracts
npx hardhat run scripts/capture/capture-reference-vectors.ts --network hub
```

## Privacy Notice

Captured vectors contain no real user data when generated in a local Anvil environment. Do not capture vectors from mainnet or Sepolia without explicit consent and scrubbing.
