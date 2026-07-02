pragma circom 2.0.0;

// Entry point for the 3x3 circuit shape (3 nullifiers, 3 commitments)
include "../operations/Transact.circom";

component main {public [merkleRoot, boundParamsHash, nullifiers, commitments]} = Transact(3, 3);
