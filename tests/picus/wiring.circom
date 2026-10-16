pragma circom 2.0.0;
// Picus piece: NullifierDisclosure with each circomlib hash and the EdDSA verifier abstracted.
// The Poseidon outputs become free inputs (mpkHash, nfHash, msgHash), the way the Picus README
// describes for hard templates. The message passed to EdDSAPoseidonVerifier becomes an output,
// so Picus checks that the wiring determines it. Every other constraint is as in the circuit.
// Keep this file in step with src/operations/NullifierDisclosure.circom: a change there that
// this file does not mirror leaves the change unchecked by Picus.
include "../../node_modules/circomlib/circuits/bitify.circom";
include "../../node_modules/circomlib/circuits/babyjub.circom";
template Wiring() {
  signal input statementHash;
  signal input masterPublicKey;
  signal input nullifier;
  signal input treeNumber;
  signal input leafIndex;
  signal input spendingPublicKey[2];
  signal input nullifyingKey;
  signal input signature[3];
  signal input mpkHash;   // stands for Poseidon(Ax, Ay, nullifyingKey)
  signal input nfHash;    // stands for Poseidon(nullifyingKey, leafIndex)
  signal input msgHash;   // stands for Poseidon(statementHash, M, N, T, L)
  signal output verifierM;

  component leafBits = Num2Bits(16);
  leafBits.in <== leafIndex;
  component treeBits = Num2Bits(16);
  treeBits.in <== treeNumber;
  masterPublicKey === mpkHash;
  nullifier === nfHash;
  component aOnCurve = BabyCheck();
  aOnCurve.x <== spendingPublicKey[0];
  aOnCurve.y <== spendingPublicKey[1];
  component rOnCurve = BabyCheck();
  rOnCurve.x <== signature[0];
  rOnCurve.y <== signature[1];
  verifierM <== msgHash;
}
component main = Wiring();
