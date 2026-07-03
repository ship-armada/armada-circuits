pragma circom 2.0.0;

// Entry point for the 1x1 circuit shape (1 nullifier, 1 commitment)
include "../operations/Transact.circom";

component main {public [merkleRoot, boundParamsHash, nullifiers, commitmentsOut]} = Transact(1, 1);
