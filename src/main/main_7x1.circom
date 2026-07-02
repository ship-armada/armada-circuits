pragma circom 2.0.0;

// Entry point for the 7x1 circuit shape (7 nullifiers, 1 commitment)
include "../operations/Transact.circom";

component main {public [merkleRoot, boundParamsHash, nullifiers, commitments]} = Transact(7, 1);
