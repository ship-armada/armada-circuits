pragma circom 2.0.0;

// Entry point for the owned 1x1 circuit shape (1 nullifier, 1 commitment)
include "../operations/TransactOwned.circom";

component main {public [merkleRoot, boundParamsHash, nullifiers, commitmentsOut, ownerField]} = TransactOwned(1, 1);
