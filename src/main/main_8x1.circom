pragma circom 2.0.0;

// Entry point for the 8x1 circuit shape (8 nullifiers, 1 commitment)
include "../operations/Transact.circom";

component main {public [merkleRoot, boundParamsHash, nullifiers, commitments]} = Transact(8, 1);
