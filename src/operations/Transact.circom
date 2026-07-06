pragma circom 2.0.0;

/**
 * Armada Transact Circuit
 *
 * Parameterized by N (number of input nullifiers) and M (number of output commitments).
 *
 * Proves that a shielded transaction:
 *   1. Spends only notes owned by the prover (valid Merkle membership + NPK derivation)
 *   2. Does not double-spend (nullifiers correctly derived)
 *   3. Conserves value (sum of inputs == sum of outputs)
 *   4. Creates well-formed output commitments
 *   5. Is authorized by an EdDSA signature over boundParamsHash
 *
 * Public inputs:  [merkleRoot, boundParamsHash, nullifiers[N], commitmentsOut[M]]
 * Witness format: matches the SDK's Prover.formatRailgunInputs exactly
 *
 * Signal names MUST match FormattedCircuitInputsRailgun:
 *   merkleRoot, boundParamsHash, nullifiers, commitmentsOut,
 *   token, publicKey, signature, randomIn, valueIn,
 *   pathElements (flat N*16), leavesIndices, nullifyingKey,
 *   npkOut, valueOut
 *
 * boundParamsHash is a pass-through public input — it is NOT recomputed in-circuit.
 * It is computed off-chain by the SDK and on-chain by the verifier contract independently.
 */

include "../../node_modules/circomlib/circuits/poseidon.circom";
include "../../node_modules/circomlib/circuits/eddsaposeidon.circom";
include "../../node_modules/circomlib/circuits/bitify.circom";
include "../lib/merkle.circom";

template Transact(N, M) {
  // ── Public inputs ──────────────────────────────────────────
  signal input merkleRoot;
  signal input boundParamsHash;
  signal input nullifiers[N];
  signal input commitmentsOut[M];

  // ── Private witness: keys ──────────────────────────────────
  signal input token;                   // tokenHash (all inputs/outputs share this)
  signal input publicKey[2];            // spending public key [x, y] on BabyJubJub
  signal input signature[3];            // EdDSA [R_x, R_y, S]
  signal input nullifyingKey;

  // ── Private witness: input notes (×N) ──────────────────────
  signal input randomIn[N];             // note randomness per input
  signal input valueIn[N];              // note value per input
  signal input pathElements[N * 16];    // Merkle path elements (flat: N inputs × depth 16)
  signal input leavesIndices[N];        // Merkle leaf positions (packed)

  // ── Private witness: output notes (×M) ─────────────────────
  signal input npkOut[M];               // output note public keys
  signal input valueOut[M];             // output values

  // ════════════════════════════════════════════════════════════
  // CONSTRAINTS
  // ════════════════════════════════════════════════════════════

  // 1. Derive masterPublicKey from spending keys
  //    masterPublicKey = Poseidon(spendingPublicKeyX, spendingPublicKeyY, nullifyingKey)
  component mpkHash = Poseidon(3);
  mpkHash.inputs[0] <== publicKey[0];
  mpkHash.inputs[1] <== publicKey[1];
  mpkHash.inputs[2] <== nullifyingKey;

  // 2. Process each input note — declare components as arrays
  component npkHashes[N];
  component commHashes[N];
  component merkleProofs[N];
  component nullifierHashes[N];

  for (var i = 0; i < N; i++) {
    // 2a. Derive note public key: npk = Poseidon(masterPublicKey, random)
    npkHashes[i] = Poseidon(2);
    npkHashes[i].inputs[0] <== mpkHash.out;
    npkHashes[i].inputs[1] <== randomIn[i];

    // 2b. Compute commitment: commitment = Poseidon(npk, token, value)
    commHashes[i] = Poseidon(3);
    commHashes[i].inputs[0] <== npkHashes[i].out;
    commHashes[i].inputs[1] <== token;
    commHashes[i].inputs[2] <== valueIn[i];

    // 2c. Verify Merkle membership of this commitment
    merkleProofs[i] = MerkleTreeProof(16);
    merkleProofs[i].leaf <== commHashes[i].out;
    for (var j = 0; j < 16; j++) {
      merkleProofs[i].pathElements[j] <== pathElements[i * 16 + j];
    }
    merkleProofs[i].pathIndices <== leavesIndices[i];

    // Root must match public merkleRoot
    merkleRoot === merkleProofs[i].root;

    // 2d. Derive nullifier: nullifier = Poseidon(nullifyingKey, leafIndex)
    nullifierHashes[i] = Poseidon(2);
    nullifierHashes[i].inputs[0] <== nullifyingKey;
    nullifierHashes[i].inputs[1] <== leavesIndices[i];
    nullifiers[i] === nullifierHashes[i].out;
  }

  // 3. Process each output note
  component outCommHashes[M];
  for (var j = 0; j < M; j++) {
    // commitment = Poseidon(npkOut, token, valueOut)
    outCommHashes[j] = Poseidon(3);
    outCommHashes[j].inputs[0] <== npkOut[j];
    outCommHashes[j].inputs[1] <== token;
    outCommHashes[j].inputs[2] <== valueOut[j];
    commitmentsOut[j] === outCommHashes[j].out;
  }

  // 4. Value conservation: sum(inputs) == sum(outputs)
  // Values are constrained to < 2^120 to prevent modular arithmetic exploits.
  // Shield enforces max uint80 on-chain; 120 bits gives headroom for sums.
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

  // 5. Compute the message hash that the EdDSA signature covers.
  // The SDK signs: Poseidon(merkleRoot, boundParamsHash, ...nullifiers, ...commitmentsOut)
  // For shape (N,M), this is Poseidon with 2+N+M inputs.
  // circomlib Poseidon supports up to 16 inputs via Poseidon(nInputs).
  component msgHash = Poseidon(2 + N + M);
  msgHash.inputs[0] <== merkleRoot;
  msgHash.inputs[1] <== boundParamsHash;
  for (var i = 0; i < N; i++) {
    msgHash.inputs[2 + i] <== nullifiers[i];
  }
  for (var j = 0; j < M; j++) {
    msgHash.inputs[2 + N + j] <== commitmentsOut[j];
  }

  // 6. EdDSA signature verification over the message hash
  component eddsa = EdDSAPoseidonVerifier();
  eddsa.enabled <== 1;
  eddsa.Ax <== publicKey[0];
  eddsa.Ay <== publicKey[1];
  eddsa.S <== signature[2];
  eddsa.R8x <== signature[0];
  eddsa.R8y <== signature[1];
  eddsa.M <== msgHash.out;
}

// Entry points are in src/main/ — one file per circuit shape.
