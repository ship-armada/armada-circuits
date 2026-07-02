pragma circom 2.0.0;

// Entry point for the 5x2 circuit shape (5 nullifiers, 2 commitments)
include "../operations/Transact.circom";

component main {public [merkleRoot, boundParamsHash, nullifiers, commitments]} = Transact(5, 2);
