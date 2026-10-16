pragma circom 2.0.0;

// Entry point for the nullifier disclosure circuit (selective disclosure, ADR-0020)
include "../operations/NullifierDisclosure.circom";

component main {public [statementHash, masterPublicKey, nullifier, treeNumber, leafIndex]} = NullifierDisclosure();
