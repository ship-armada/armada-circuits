pragma circom 2.0.0;

// Entry point for the 2x1 circuit shape (2 nullifiers, 1 commitment)
include "../operations/Transact.circom";

component main {public [merkleRoot, boundParamsHash, nullifiers, commitmentsOut]} = Transact(2, 1);
