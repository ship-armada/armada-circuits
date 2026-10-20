pragma circom 2.0.0;

/**
 * Armada TransactOwned Circuit
 *
 * A Transact variant for a note owned by a contract instead of a user
 * keypair. See Transact.circom for the base design; this file only
 * documents what differs.
 *
 * Public inputs:  [merkleRoot, boundParamsHash, nullifiers[N], commitmentsOut[M], ownerField]
 * Public outputs: npk[N], transcriptHash
 *
 * ownerField = uint256(uint160(owner)), supplied by the calling contract.
 * The on-chain verifier checks ownerField against msg.sender, so the
 * caller itself is the authorization and no EdDSA signature is needed.
 *
 * npk[i] = Poseidon(ownerField, randomIn[i]) replaces the master-public-key
 * derivation in Transact.circom. It is a circuit output so the caller can
 * read back the note public key it just proved ownership of.
 *
 * transcriptHash commits to the same (merkleRoot, boundParamsHash,
 * nullifiers, commitmentsOut) transcript that Transact.circom signs with
 * EdDSA, so the fields stay bound together without a signature.
 */

include "../../node_modules/circomlib/circuits/poseidon.circom";
include "../../node_modules/circomlib/circuits/bitify.circom";
include "../lib/merkle.circom";

template TransactOwned(N, M) {
  // ── Public inputs ──────────────────────────────────────────
  signal input merkleRoot;
  signal input boundParamsHash;
  signal input nullifiers[N];
  signal input commitmentsOut[M];
  signal input ownerField;

  // ── Public outputs ──────────────────────────────────────────
  signal output npk[N];
  signal output transcriptHash;

  // ── Private witness: token ──────────────────────────────────
  signal input token;
  signal input nullifyingKey;

  // ── Private witness: input notes (×N) ──────────────────────
  signal input randomIn[N];
  signal input valueIn[N];
  signal input pathElements[N * 16];
  signal input leavesIndices[N];

  // ── Private witness: output notes (×M) ─────────────────────
  signal input npkOut[M];
  signal input valueOut[M];

  // ════════════════════════════════════════════════════════════
  // CONSTRAINTS
  // ════════════════════════════════════════════════════════════

  // 1. Process each input note
  component npkHashes[N];
  component commHashes[N];
  component merkleProofs[N];
  component nullifierHashes[N];

  for (var i = 0; i < N; i++) {
    // 1a. Derive the owned note's public key: npk = Poseidon(ownerField, random)
    npkHashes[i] = Poseidon(2);
    npkHashes[i].inputs[0] <== ownerField;
    npkHashes[i].inputs[1] <== randomIn[i];
    npk[i] <== npkHashes[i].out;

    // 1b. Compute commitment: commitment = Poseidon(npk, token, value)
    commHashes[i] = Poseidon(3);
    commHashes[i].inputs[0] <== npk[i];
    commHashes[i].inputs[1] <== token;
    commHashes[i].inputs[2] <== valueIn[i];

    // 1c. Verify Merkle membership of this commitment
    merkleProofs[i] = MerkleTreeProof(16);
    merkleProofs[i].leaf <== commHashes[i].out;
    for (var j = 0; j < 16; j++) {
      merkleProofs[i].pathElements[j] <== pathElements[i * 16 + j];
    }
    merkleProofs[i].pathIndices <== leavesIndices[i];

    // Root must match public merkleRoot
    merkleRoot === merkleProofs[i].root;

    // 1d. Derive nullifier: nullifier = Poseidon(nullifyingKey, leafIndex)
    nullifierHashes[i] = Poseidon(2);
    nullifierHashes[i].inputs[0] <== nullifyingKey;
    nullifierHashes[i].inputs[1] <== leavesIndices[i];
    nullifiers[i] === nullifierHashes[i].out;
  }

  // 2. Process each output note
  component outCommHashes[M];
  for (var j = 0; j < M; j++) {
    // commitment = Poseidon(npkOut, token, valueOut)
    outCommHashes[j] = Poseidon(3);
    outCommHashes[j].inputs[0] <== npkOut[j];
    outCommHashes[j].inputs[1] <== token;
    outCommHashes[j].inputs[2] <== valueOut[j];
    commitmentsOut[j] === outCommHashes[j].out;
  }

  // 3. Value conservation: sum(inputs) == sum(outputs)
  component valueInRange[N];
  for (var i = 0; i < N; i++) {
    valueInRange[i] = Num2Bits(120);
    valueInRange[i].in <== valueIn[i];
  }
  component valueOutRange[M];
  for (var j = 0; j < M; j++) {
    valueOutRange[j] = Num2Bits(120);
    valueOutRange[j].in <== valueOut[j];
  }

  signal sumIn;
  signal sumOut;
  var accIn = 0;
  var accOut = 0;
  for (var i = 0; i < N; i++) {
    accIn += valueIn[i];
  }
  for (var j = 0; j < M; j++) {
    accOut += valueOut[j];
  }
  sumIn <== accIn;
  sumOut <== accOut;
  sumIn === sumOut;

  // 4. transcriptHash binds merkleRoot, boundParamsHash, nullifiers and
  // commitmentsOut together, in place of the EdDSA-signed message hash.
  component msgHash = Poseidon(2 + N + M);
  msgHash.inputs[0] <== merkleRoot;
  msgHash.inputs[1] <== boundParamsHash;
  for (var i = 0; i < N; i++) {
    msgHash.inputs[2 + i] <== nullifiers[i];
  }
  for (var j = 0; j < M; j++) {
    msgHash.inputs[2 + N + j] <== commitmentsOut[j];
  }
  transcriptHash <== msgHash.out;
}

// Entry points are in src/main/ — one file per circuit shape.
