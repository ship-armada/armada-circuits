pragma circom 2.0.0;

/**
 * Armada Nullifier Disclosure Circuit
 *
 * Proves, for one published nullifier, that:
 *   1. The nullifier belongs to the note at (treeNumber, leafIndex) of the wallet with
 *      masterPublicKey M: nullifier == Poseidon(nullifyingKey, leafIndex), and
 *      M == Poseidon(spendingPublicKeyX, spendingPublicKeyY, nullifyingKey).
 *   2. The spending key of M authorizes this disclosure: an EdDSA (BabyJubJub, Poseidon)
 *      signature by the spending key over
 *        message = Poseidon(statementHash, M, nullifier, treeNumber, leafIndex).
 *
 * The nullifyingKey and the spending key stay private. The circuit reveals nothing that
 * links any other nullifier to M.
 *
 * Public inputs:  [statementHash, masterPublicKey, nullifier, treeNumber, leafIndex]
 * Private inputs: spendingPublicKey[2], nullifyingKey, signature[3] = [R8x, R8y, S]
 *
 * Every public input enters the signed message, so the proof binds all of them. A Groth16
 * public input that no constraint uses is not bound by the proof.
 *
 * The formulas for M and the nullifier are the ones in Transact.circom (steps 1 and 2d).
 * The verifier checks off-circuit that the disclosed note is at (treeNumber, leafIndex) and
 * that the nullifier is in the pool's Nullified event for treeNumber.
 *
 * Design: armada-laconic engineering/16-selective-disclosure.md (ADR-0020).
 */

include "../../node_modules/circomlib/circuits/poseidon.circom";
include "../../node_modules/circomlib/circuits/bitify.circom";
include "../../node_modules/circomlib/circuits/babyjub.circom";
include "../../node_modules/circomlib/circuits/eddsaposeidon.circom";

/**
 * Derives the masterPublicKey and the nullifier of one leaf from the wallet keys.
 * Same formulas as Transact.circom; kept separate so it can be tested against real spends.
 */
template NullifierOwnership() {
  signal input spendingPublicKey[2];
  signal input nullifyingKey;
  signal input leafIndex;

  signal output masterPublicKey;
  signal output nullifier;

  component mpk = Poseidon(3);
  mpk.inputs[0] <== spendingPublicKey[0];
  mpk.inputs[1] <== spendingPublicKey[1];
  mpk.inputs[2] <== nullifyingKey;
  masterPublicKey <== mpk.out;

  component nf = Poseidon(2);
  nf.inputs[0] <== nullifyingKey;
  nf.inputs[1] <== leafIndex;
  nullifier <== nf.out;
}

template NullifierDisclosure() {
  // ── Public inputs ───────────────────────────────────────────
  signal input statementHash;
  signal input masterPublicKey;
  signal input nullifier;
  signal input treeNumber;
  signal input leafIndex;

  // ── Private witness ─────────────────────────────────────────
  signal input spendingPublicKey[2];   // [Ax, Ay] on BabyJubJub
  signal input nullifyingKey;
  signal input signature[3];           // EdDSA [R8x, R8y, S]

  // 1. Range checks. The pool's trees have depth 16, and treeNumber is a uint16 in events.
  component leafBits = Num2Bits(16);
  leafBits.in <== leafIndex;
  component treeBits = Num2Bits(16);
  treeBits.in <== treeNumber;

  // 2. The keys produce the public masterPublicKey and nullifier.
  component own = NullifierOwnership();
  own.spendingPublicKey[0] <== spendingPublicKey[0];
  own.spendingPublicKey[1] <== spendingPublicKey[1];
  own.nullifyingKey <== nullifyingKey;
  own.leafIndex <== leafIndex;
  masterPublicKey === own.masterPublicKey;
  nullifier === own.nullifier;

  // 3. The signed message commits to every public input.
  component msg = Poseidon(5);
  msg.inputs[0] <== statementHash;
  msg.inputs[1] <== masterPublicKey;
  msg.inputs[2] <== nullifier;
  msg.inputs[3] <== treeNumber;
  msg.inputs[4] <== leafIndex;

  // 4. Both curve points are on BabyJubJub. circomlib's verifier does not check this itself.
  component aOnCurve = BabyCheck();
  aOnCurve.x <== spendingPublicKey[0];
  aOnCurve.y <== spendingPublicKey[1];
  component rOnCurve = BabyCheck();
  rOnCurve.x <== signature[0];
  rOnCurve.y <== signature[1];

  // 5. The spending key signs the message (S < subgroup order and A != 0 are checked inside).
  component eddsa = EdDSAPoseidonVerifier();
  eddsa.enabled <== 1;
  eddsa.Ax <== spendingPublicKey[0];
  eddsa.Ay <== spendingPublicKey[1];
  eddsa.R8x <== signature[0];
  eddsa.R8y <== signature[1];
  eddsa.S <== signature[2];
  eddsa.M <== msg.out;
}
