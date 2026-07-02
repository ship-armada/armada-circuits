pragma circom 2.0.0;

// Entry point for the 4x1 circuit shape (4 nullifiers, 1 commitment)
include "../operations/Transact.circom";

component main {public [merkleRoot, boundParamsHash, nullifiers, commitments]} = Transact(4, 1);
