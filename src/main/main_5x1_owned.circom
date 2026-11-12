pragma circom 2.0.0;

// Entry point for the owned 5x1 circuit shape (5 nullifiers, 1 commitment)
include "../operations/TransactOwned.circom";

component main {public [merkleRoot, boundParamsHash, nullifiers, commitmentsOut, ownerField]} = TransactOwned(5, 1);
