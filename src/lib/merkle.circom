pragma circom 2.0.0;

/**
 * Binary Merkle Tree Proof Verifier
 *
 * Verifies that a leaf exists in a binary Merkle tree of the given depth,
 * using Poseidon(2) as the hash function at each level.
 *
 * Path indices are provided as a single packed field element (the leaf index).
 * Bit decomposition determines left/right at each level:
 *   bit=0 → current node is the left child
 *   bit=1 → current node is the right child
 *
 * Bits are read LSB-first (bit 0 = leaf level, bit 1 = next level up, etc.)
 */

include "../../node_modules/circomlib/circuits/poseidon.circom";
include "../../node_modules/circomlib/circuits/bitify.circom";

template MerkleTreeProof(depth) {
  signal input leaf;
  signal input pathElements[depth];
  signal input pathIndices; // packed — leaf index, decompose to bits

  signal output root;

  // Decompose path indices into individual bits
  component idxBits = Num2Bits(depth);
  idxBits.in <== pathIndices;

  // Chain of hashes from leaf to root
  signal levelHash[depth + 1];
  levelHash[0] <== leaf;

  // Pre-declare arrays (circom doesn't allow signal declarations in loops)
  component hashers[depth];
  signal deltaLR[depth];

  for (var i = 0; i < depth; i++) {
    hashers[i] = Poseidon(2);

    // sel = idxBits.out[i] (0 or 1)
    // deltaLR[i] = sel * (sibling - current)  — one quadratic constraint
    deltaLR[i] <== idxBits.out[i] * (pathElements[i] - levelHash[i]);

    // left  = current + deltaLR
    // right = sibling - deltaLR
    hashers[i].inputs[0] <== levelHash[i] + deltaLR[i];
    hashers[i].inputs[1] <== pathElements[i] - deltaLR[i];

    levelHash[i + 1] <== hashers[i].out;
  }

  root <== levelHash[depth];
}
